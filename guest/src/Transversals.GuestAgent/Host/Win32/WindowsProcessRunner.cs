using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Transversals.GuestAgent.Host.Win32;

/// <summary>
/// Runs a PowerShell script in a child powershell.exe confined to a Job Object.
/// The script is delivered over stdin (base64 UTF-8) to a fixed bootstrap that blocks on
/// stdin until the script arrives, so the process is in the job before any user code runs.
/// </summary>
public sealed class WindowsProcessRunner : IProcessRunner
{
    private static readonly TimeSpan OutputDrainGrace = TimeSpan.FromSeconds(2);

    // Reads the base64 script from stdin, decodes it as UTF-8, and runs it.
    // - Progress is silenced first so module auto-load and Write-Progress never reach stderr.
    // - Windows PowerShell serializes host-written error records as CLIXML whenever stderr is
    //   redirected under -EncodedCommand (-OutputFormat Text does not stop it), so the error stream
    //   is merged and rendered here as plain text to [Console]::Error; the host never sees an error.
    // - Native stderr lines (NativeCommandError*) are passed through raw and don't fail the run.
    // - Errors attributed to the bootstrap's own lines (top-level Write-Error, parse errors) are
    //   rendered without the bootstrap position; errors inside user code keep the default view,
    //   whose position refers to the user's script text.
    // - Warning/verbose/debug streams are merged too (the host would also emit them as CLIXML) and
    //   written as "WARNING: "/"VERBOSE: "/"DEBUG: " lines to stderr; they never fail the run.
    // - The information stream (Write-Host/Write-Information) is merged as well and its message
    //   text written to stdout (honoring Write-Host -NoNewline); it never fails the run.
    // - Pipeline output is formatted by one steppable `Out-String -Stream` pipeline (default
    //   formatting, written to [Console]::Out alongside Write-Host text) whose End() runs in
    //   `finally`, so buffered table output is flushed before any exit, including the user's `exit N`.
    // - Exit code: `exit N` in user code ends the process with N; a terminating error gives 1;
    //   otherwise a non-zero $LASTEXITCODE is passed through, then any non-native error record
    //   gives 1, else 0.
    private const string Bootstrap = """
        $ProgressPreference='SilentlyContinue'
        [Console]::OutputEncoding=[Text.Encoding]::UTF8
        $global:__transversalsFailed=$false
        function __transversalsWriteError($r) {
          if ($r.InvocationInfo -and $r.InvocationInfo.Line -like '*__transversalsUser*') {
            $e=$r.Exception
            if ($e -is [Management.Automation.MethodInvocationException] -and $e.InnerException) { $e=$e.InnerException }
            $t="$($e.Message)`n    + CategoryInfo          : $($r.CategoryInfo)`n    + FullyQualifiedErrorId : $($r.FullyQualifiedErrorId)"
          } else { $t=($r | Out-String).TrimEnd() }
          [Console]::Error.WriteLine($t)
        }
        $__transversalsOut={ Out-String -Stream | ForEach-Object { [Console]::Out.WriteLine($_) } }.GetSteppablePipeline()
        $__transversalsOut.Begin($true)
        try {
          $__transversalsUser=[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))
          & $__transversalsUser 2>&1 3>&1 4>&1 5>&1 6>&1 | ForEach-Object {
            if ($_ -is [Management.Automation.InformationRecord]) {
              $m=$_.MessageData
              if ($m -is [Management.Automation.HostInformationMessage] -and $m.NoNewLine) { [Console]::Out.Write("$m") } else { [Console]::Out.WriteLine("$m") }
            }
            elseif ($_ -is [Management.Automation.WarningRecord]) { [Console]::Error.WriteLine("WARNING: $($_.Message)") }
            elseif ($_ -is [Management.Automation.VerboseRecord]) { [Console]::Error.WriteLine("VERBOSE: $($_.Message)") }
            elseif ($_ -is [Management.Automation.DebugRecord]) { [Console]::Error.WriteLine("DEBUG: $($_.Message)") }
            elseif ($_ -isnot [Management.Automation.ErrorRecord]) { $__transversalsOut.Process($_) }
            elseif ($_.FullyQualifiedErrorId -like 'NativeCommandError*') { [Console]::Error.WriteLine($_.Exception.Message) }
            else { $global:__transversalsFailed=$true; __transversalsWriteError $_ }
          }
        } catch { __transversalsWriteError $_; exit 1 }
        finally { $__transversalsOut.End() }
        if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        if ($global:__transversalsFailed) { exit 1 }
        exit 0
        """;

    private static readonly string EncodedBootstrap =
        Convert.ToBase64String(Encoding.Unicode.GetBytes(Bootstrap));

    public async Task<ProcessRunResult> RunPowerShellAsync(ProcessRunRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

        ProcessStartInfo startInfo = new()
        {
            FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
            UseShellExecute = false,
            // CREATE_NO_WINDOW: the child must never pop a visible console window.
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // -OutputFormat Text keeps pipeline output as text; error records are rendered by the bootstrap.
        foreach (string argument in new[]
                 {
                     "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text",
                     "-EncodedCommand", EncodedBootstrap,
                 })
        {
            startInfo.ArgumentList.Add(argument);
        }

        using SafeJobHandle job = CreateKillOnCloseJob();
        Process process = new() { StartInfo = startInfo };
        bool disposeProcess = true;
        try
        {
            if (!process.Start())
                throw new InvalidOperationException("powershell.exe failed to start.");

            bool inJob = NativeMethods.AssignProcessToJobObject(job, process.SafeHandle);

            OutputCollector stdout = new(request.MaxOutputBytes);
            OutputCollector stderr = new(request.MaxOutputBytes);
            Task drained = Task.WhenAll(
                stdout.DrainAsync(process.StandardOutput.BaseStream),
                stderr.DrainAsync(process.StandardError.BaseStream));

            bool timedOut = false;
            try
            {
                string payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(request.Script));
                await process.StandardInput.WriteAsync(payload.AsMemory(), ct).ConfigureAwait(false);
                await process.StandardInput.FlushAsync(ct).ConfigureAwait(false);
                process.StandardInput.Close();

                using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(request.Timeout);
                try
                {
                    await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    timedOut = true;
                }
            }
            catch
            {
                KillTree(job, process, inJob);
                throw;
            }

            if (timedOut)
                KillTree(job, process, inJob);
            else
                DisableKillOnClose(job); // let apps the script launched on purpose outlive the job handle

            // Grandchildren that inherited the pipes can hold them open; don't wait on them forever.
            bool complete = await Task.WhenAny(drained, Task.Delay(OutputDrainGrace, CancellationToken.None))
                .ConfigureAwait(false) == drained;
            if (!complete)
            {
                // Pipe reads are synchronous under the hood; closing their handles mid-read can block,
                // so release the process only after the readers finish on their own.
                disposeProcess = false;
                _ = drained.ContinueWith(_ => process.Dispose(), TaskScheduler.Default);
            }

            (string stdoutText, bool stdoutTruncated) = stdout.Snapshot(incomplete: !complete);
            (string stderrText, bool stderrTruncated) = stderr.Snapshot(incomplete: !complete);
            int? exitCode = timedOut ? null : process.ExitCode;
            return new ProcessRunResult(exitCode, stdoutText, stderrText, stdoutTruncated, stderrTruncated, timedOut);
        }
        finally
        {
            if (disposeProcess) process.Dispose();
        }
    }

    private static SafeJobHandle CreateKillOnCloseJob()
    {
        SafeJobHandle job = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed.");

        NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = default;
        info.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetLimits(job, ref info))
        {
            int error = Marshal.GetLastWin32Error();
            job.Dispose();
            throw new Win32Exception(error, "SetInformationJobObject failed.");
        }

        return job;
    }

    private static void DisableKillOnClose(SafeJobHandle job)
    {
        NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = default;
        SetLimits(job, ref info);
    }

    private static bool SetLimits(SafeJobHandle job, ref NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info) =>
        NativeMethods.SetInformationJobObject(
            job,
            NativeMethods.JobObjectExtendedLimitInformation,
            ref info,
            (uint)Marshal.SizeOf<NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());

    private static void KillTree(SafeJobHandle job, Process process, bool inJob)
    {
        if (inJob && NativeMethods.TerminateJobObject(job, 1)) return;
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already exited.
        }
    }

    /// <summary>Drains a stream to EOF, keeping at most <c>maxBytes</c>; thread-safe snapshots.</summary>
    private sealed class OutputCollector(int maxBytes)
    {
        private readonly object _gate = new();
        private readonly byte[] _kept = new byte[maxBytes];
        private int _length;
        private bool _truncated;

        public async Task DrainAsync(Stream stream)
        {
            byte[] buffer = new byte[16 * 1024];
            try
            {
                while (true)
                {
                    int read = await stream.ReadAsync(buffer).ConfigureAwait(false);
                    if (read == 0) return;
                    lock (_gate)
                    {
                        int toKeep = Math.Min(read, _kept.Length - _length);
                        if (toKeep > 0)
                        {
                            Buffer.BlockCopy(buffer, 0, _kept, _length, toKeep);
                            _length += toKeep;
                        }

                        // Keep draining past the cap so the child never blocks on a full pipe.
                        if (toKeep < read) _truncated = true;
                    }
                }
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            {
                // Pipe broken by a killed process; keep what we have.
            }
        }

        public (string Text, bool Truncated) Snapshot(bool incomplete)
        {
            lock (_gate)
            {
                bool truncated = _truncated || incomplete;
                int length = truncated ? Utf8SafeLength(_kept, _length) : _length;
                return (Encoding.UTF8.GetString(_kept, 0, length), truncated);
            }
        }
    }

    /// <summary>Trims a trailing incomplete UTF-8 sequence left by a byte cap.</summary>
    private static int Utf8SafeLength(byte[] bytes, int length)
    {
        int index = length - 1;
        int continuation = 0;
        while (index >= 0 && continuation < 3 && (bytes[index] & 0xC0) == 0x80)
        {
            index--;
            continuation++;
        }

        if (index < 0) return length;
        int expected = bytes[index] switch
        {
            >= 0xF0 => 4,
            >= 0xE0 => 3,
            >= 0xC0 => 2,
            _ => 1,
        };
        return continuation + 1 >= expected ? length : index;
    }
}
