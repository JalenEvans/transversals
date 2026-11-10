namespace Transversals.GuestAgent.Host;

/// <summary>
/// The NDJSON request/response loop on stdin/stdout. The host writes blank lines as keepalives (protocol v2);
/// when stdin stays silent for the idle timeout between commands the host is presumed gone (a killed prlctl
/// neither closes the agent's stdin nor fails its writes) and the session ends so the agent does not leak.
/// </summary>
internal static class NdjsonSessionRunner
{
    public const int ExitOk = 0;
    public const int ExitFailure = 1;

    /// <summary>Six missed 5 s host keepalives.</summary>
    public static readonly TimeSpan DefaultIdleTimeout = TimeSpan.FromSeconds(30);

    /// <returns>
    /// 0 on EOF or cancellation; 1 on an idle timeout or a handler/stdout failure (reported through
    /// <paramref name="reportFailure"/>, never on stdout).
    /// </returns>
    public static async Task<int> RunAsync(
        Func<string, CancellationToken, Task<string>> handleLine,
        TextReader stdin,
        TextWriter stdout,
        TimeSpan idleTimeout,
        CancellationToken ct,
        Action<Exception>? reportFailure = null)
    {
        try
        {
            while (true)
            {
                // The idle timer covers only the wait for the next line, so a long command never times out.
                string? line = await ReadLineOrIdleAsync(stdin, idleTimeout, ct).ConfigureAwait(false);
                if (line is null) return ExitOk;
                if (string.IsNullOrWhiteSpace(line)) continue; // keepalive: activity, no response

                string response = await handleLine(line, ct).ConfigureAwait(false);
                await stdout.WriteLineAsync(response.AsMemory(), ct).ConfigureAwait(false);
                await stdout.FlushAsync(ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return ExitOk;
        }
        catch (Exception error)
        {
            reportFailure?.Invoke(error);
            return ExitFailure;
        }
    }

    /// <summary>
    /// The next line, or null at EOF. Throws <see cref="TimeoutException"/> when no line arrives within
    /// <paramref name="idleTimeout"/> of real time. The pending read is then abandoned, never awaited.
    /// </summary>
    /// <remarks>
    /// The blocking ReadLine runs on a thread-pool thread: Console.In is a SyncTextReader whose ReadLineAsync
    /// blocks the caller and returns a completed task, which would stop the idle timer from ever winning.
    /// The read takes no token (console reads ignore cancellation); the delay and <paramref name="ct"/> end
    /// the wait instead. Only one read is outstanding: a read is abandoned only on the way out.
    /// </remarks>
    private static async Task<string?> ReadLineOrIdleAsync(TextReader stdin, TimeSpan idleTimeout, CancellationToken ct)
    {
        Task<string?> read = Task.Run(() => stdin.ReadLine(), CancellationToken.None);
        using CancellationTokenSource timerCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task idle = Task.Delay(idleTimeout, timerCts.Token);
        if (await Task.WhenAny(read, idle).ConfigureAwait(false) != read)
        {
            ObserveFault(read);
            ct.ThrowIfCancellationRequested();
            throw new TimeoutException(
                $"No input from the host for {idleTimeout.TotalSeconds:0.###} s; assuming it is gone.");
        }

        timerCts.Cancel();
        return await read.ConfigureAwait(false);
    }

    /// <summary>Keeps an abandoned read's eventual exception from surfacing as unobserved.</summary>
    private static void ObserveFault(Task task) =>
        _ = task.ContinueWith(
            static completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
}
