using System.Diagnostics;
using Transversals.GuestAgent.Host;
using Transversals.GuestAgent.Host.Win32;

namespace Transversals.GuestAgent.Tests;

// C-3 (guest): NDJSON session keepalive. The host writes blank lines as keepalives; the guest ignores
// them (no response) and exits when stdin stays silent for the idle timeout between commands.
//
// Assumed contract:
//   internal static class Transversals.GuestAgent.Host.NdjsonSessionRunner
//     static readonly TimeSpan DefaultIdleTimeout   // 30 s (a const-like static property or field)
//     static Task<int> RunAsync(Func<string, CancellationToken, Task<string>> handleLine,
//                               TextReader stdin, TextWriter stdout, TimeSpan idleTimeout, CancellationToken ct)
//   - Blank/whitespace-only lines: no output, handler not called, count as activity.
//   - Idle timeout in REAL time, only while awaiting the next line; the pending read is abandoned (not awaited).
//   - Exit codes: EOF 0, cancellation 0, idle timeout 1, handler exception (non-OCE) 1 with nothing written
//     to stdout for that line (stderr reporting stays in Program).
//   - Each response is written as one line and flushed.
//   WindowsAgentInfo.CurrentProtocolVersion == 2.
// Timing: real 100–300 ms timeouts; assertions use lower bounds only (upper bound = the 5 s guard).
public sealed class NdjsonSessionTests
{
    private static readonly TimeSpan Guard = TimeSpan.FromSeconds(5);

    private static Task<int> Run(
        FakeLineHandler handler,
        TextReader stdin,
        TextWriter stdout,
        int idleMs,
        CancellationToken ct = default) =>
        NdjsonSessionRunner
            .RunAsync(handler.HandleAsync, stdin, stdout, TimeSpan.FromMilliseconds(idleMs), ct)
            .WaitAsync(Guard);

    // ---------- KA-G1 keepalive lines are ignored ----------

    [Fact]
    public async Task KA_G1_blank_and_whitespace_lines_get_no_response_and_skip_the_handler()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: true)
            .Line("").Line("   ").Line("\t").Line("{\"id\":\"a\"}").Line(" \t ").Line("{\"id\":\"b\"}");

        int code = await Run(handler, stdin, stdout, idleMs: 2_000);

        Assert.Equal(0, code);
        Assert.Equal(["{\"id\":\"a\"}", "{\"id\":\"b\"}"], handler.Snapshot());
        Assert.Equal(["resp:{\"id\":\"a\"}", "resp:{\"id\":\"b\"}"], stdout.OutputLines());
        Assert.True(stdout.Flushes >= 2, $"Expected a flush per response, saw {stdout.Flushes}.");
    }

    [Fact]
    public async Task KA_G1_a_session_of_only_keepalives_writes_nothing()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: true).Repeat("", 5, everyMs: 0);

        int code = await Run(handler, stdin, stdout, idleMs: 2_000);

        Assert.Equal(0, code);
        Assert.Empty(handler.Snapshot());
        Assert.Equal("", stdout.ToString());
    }

    // ---------- KA-G2 idle timeout ----------

    [Fact]
    public void KA_G2_default_idle_timeout_is_30_seconds() =>
        Assert.Equal(TimeSpan.FromSeconds(30), NdjsonSessionRunner.DefaultIdleTimeout);

    [Fact]
    public async Task KA_G2_silent_stdin_exits_1_after_the_idle_timeout_and_abandons_the_read()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new(eofAfterScript: false);
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await Run(handler, stdin, stdout, idleMs: 100);

        Assert.Equal(1, code);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(80), $"Gave up after only {elapsed.Elapsed}.");
        Assert.Empty(handler.Snapshot());
        Assert.Equal("", stdout.ToString());
        await Task.Delay(150);
        Assert.Equal(1, stdin.Reads); // stopped reading
    }

    [Fact]
    public async Task KA_G2_silence_after_a_command_exits_1()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: false).Line("req");

        int code = await Run(handler, stdin, stdout, idleMs: 150);

        Assert.Equal(1, code);
        Assert.Equal(["resp:req"], stdout.OutputLines());
    }

    // ---------- KA-G3 keepalives keep the session alive ----------

    [Fact]
    public async Task KA_G3_keepalives_faster_than_the_timeout_keep_the_session_alive_until_eof()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        // 8 keepalives 40 ms apart (~320 ms, twice the 150 ms timeout), then a request, then EOF.
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: true)
            .Repeat("", 8, everyMs: 40)
            .Line("req", afterMs: 40);
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await Run(handler, stdin, stdout, idleMs: 150);

        Assert.Equal(0, code);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(300), $"Stopped after only {elapsed.Elapsed}.");
        Assert.Equal(["resp:req"], stdout.OutputLines());
    }

    [Fact]
    public async Task KA_G3_the_timeout_runs_from_the_last_keepalive()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        // 5 keepalives 40 ms apart (~200 ms), then silence. Without resets the session would end at ~150 ms.
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: false).Repeat(" ", 5, everyMs: 40);
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await Run(handler, stdin, stdout, idleMs: 150);

        Assert.Equal(1, code);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(300), $"Timed out after only {elapsed.Elapsed}.");
    }

    // ---------- KA-G4 never times out mid-command ----------

    [Fact]
    public async Task KA_G4_a_command_longer_than_the_timeout_completes_and_the_session_continues()
    {
        FakeLineHandler handler = new() { Cost = line => line == "slow" ? TimeSpan.FromMilliseconds(350) : TimeSpan.Zero };
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: true)
            .Line("slow")
            .Line("next", afterMs: 50);

        int code = await Run(handler, stdin, stdout, idleMs: 100);

        Assert.Equal(0, code);
        Assert.Equal(["resp:slow", "resp:next"], stdout.OutputLines());
    }

    [Fact]
    public async Task KA_G4_the_idle_timer_restarts_when_a_command_completes()
    {
        FakeLineHandler handler = new() { Cost = _ => TimeSpan.FromMilliseconds(300) };
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: false).Line("slow");
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await Run(handler, stdin, stdout, idleMs: 100);

        Assert.Equal(1, code);
        Assert.Equal(["resp:slow"], stdout.OutputLines());
        // 300 ms command + ~100 ms idle measured from its completion, not from when it started.
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(380), $"Timed out after only {elapsed.Elapsed}.");
    }

    // ---------- KA-G5 requests count as activity ----------

    [Fact]
    public async Task KA_G5_requests_spaced_under_the_timeout_keep_the_session_alive()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: true);
        for (int i = 0; i < 8; i++) stdin.Line($"r{i}", afterMs: 40);

        int code = await Run(handler, stdin, stdout, idleMs: 150);

        Assert.Equal(0, code);
        Assert.Equal(Enumerable.Range(0, 8).Select(i => $"resp:r{i}"), stdout.OutputLines());
    }

    // ---------- KA-G6 normal stop ----------

    [Fact]
    public async Task KA_G6_eof_exits_0()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();

        int code = await Run(handler, new ScriptedLineReader(eofAfterScript: true), stdout, idleMs: 2_000);

        Assert.Equal(0, code);
        Assert.Equal("", stdout.ToString());
    }

    [Fact]
    public async Task KA_G6_cancellation_exits_0()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        using CancellationTokenSource cts = new(TimeSpan.FromMilliseconds(50));

        int code = await Run(handler, new ScriptedLineReader(eofAfterScript: false), stdout, idleMs: 30_000, cts.Token);

        Assert.Equal(0, code);
    }

    // ---------- KA-G9 console-style (synchronously blocking) stdin ----------
    // Console.In's ReadLineAsync blocks the calling thread and returns a completed task, so racing it
    // against a delay on the same thread never lets the idle timer win (C-3 live-check failure).

    [Fact]
    public async Task KA_G9_silent_sync_blocking_stdin_still_idles_out_with_exit_1()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        using SyncBlockingLineReader stdin = new(cap: TimeSpan.FromSeconds(5));
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await Run(handler, stdin, stdout, idleMs: 150);
        elapsed.Stop();

        Assert.True(
            elapsed.Elapsed < TimeSpan.FromSeconds(2),
            $"RunAsync returned only after {elapsed.Elapsed} (the reader's 5 s cap), so the idle timeout never fired.");
        Assert.Equal(1, code);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(130), $"Gave up after only {elapsed.Elapsed}.");
        Assert.Empty(handler.Snapshot());
        Assert.Equal("", stdout.ToString());
    }

    [Fact]
    public async Task KA_G9b_lines_from_sync_blocking_stdin_are_handled_and_keepalives_ignored()
    {
        FakeLineHandler handler = new();
        RecordingWriter stdout = new();
        using SyncBlockingLineReader stdin = new(cap: TimeSpan.FromSeconds(5));
        Task feeder = Task.Run(async () =>
        {
            await Task.Delay(50);
            stdin.Feed("a");
            await Task.Delay(50);
            stdin.Feed("  ");
            await Task.Delay(50);
            stdin.Feed("b");
            await Task.Delay(50);
            stdin.Complete();
        });

        int code = await Run(handler, stdin, stdout, idleMs: 1_000);
        await feeder;

        Assert.Equal(0, code);
        Assert.Equal(["a", "b"], handler.Snapshot());
        Assert.Equal(["resp:a", "resp:b"], stdout.OutputLines());
    }

    // ---------- KA-G7 protocol version ----------

    [Fact]
    public void KA_G7_the_agent_advertises_protocol_version_2() =>
        Assert.Equal(2, WindowsAgentInfo.CurrentProtocolVersion);

    // ---------- KA-G8 handler failures ----------

    [Fact]
    public async Task KA_G8_a_handler_exception_exits_1_without_writing_a_response()
    {
        FakeLineHandler handler = new()
        {
            Failure = line => line == "boom" ? new InvalidOperationException("broken") : null,
        };
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: true).Line("ok").Line("boom").Line("after");

        int code = await Run(handler, stdin, stdout, idleMs: 2_000);

        Assert.Equal(1, code);
        Assert.Equal(["resp:ok"], stdout.OutputLines());
        Assert.DoesNotContain("after", handler.Snapshot());
    }

    [Fact]
    public async Task KA_G8_cancellation_surfacing_from_the_handler_exits_0()
    {
        using CancellationTokenSource cts = new();
        FakeLineHandler handler = new()
        {
            Failure = line =>
            {
                if (line != "cancel") return null;
                cts.Cancel();
                return new OperationCanceledException(cts.Token);
            },
        };
        RecordingWriter stdout = new();
        ScriptedLineReader stdin = new ScriptedLineReader(eofAfterScript: false).Line("cancel");

        int code = await Run(handler, stdin, stdout, idleMs: 2_000, cts.Token);

        Assert.Equal(0, code);
        Assert.Equal("", stdout.ToString());
    }
}
