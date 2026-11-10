using System.Diagnostics;
using Transversals.GuestAgent.Host.Streaming;

namespace Transversals.GuestAgent.Tests;

// C-1 (guest): `Transversals.GuestAgent.exe stream ...` — length-prefixed JPEG frames on stdout.
//
// Assumed contracts (namespace Transversals.GuestAgent.Host.Streaming unless noted):
//   enum AgentMode { Ndjson, Stream, Invalid }
//   Transversals.GuestAgent.Program.ResolveMode(string[] args) -> AgentMode           (internal static, pure)
//   record StreamOptions(int Fps, int MaxLongEdge, int Quality)
//     static bool TryParse(string[] args, out StreamOptions? options, out string? error)
//   record StreamLimits(int MaxFrameBytes, TimeSpan WriteStallTimeout, TimeSpan HeartbeatTimeout)
//     { static StreamLimits Default }                                                  (A-HB adds HeartbeatTimeout)
//   interface IJpegFrameSource { byte[] Capture(int maxLongEdge, int quality); }
//   interface IStreamClock { TimeSpan Elapsed { get; } Task DelayUntilAsync(TimeSpan due, CancellationToken ct); }
//   FrameWriter(Stream output).WriteFrameAsync(ReadOnlyMemory<byte> jpeg, CancellationToken ct)
//   static StreamSession.RunAsync(StreamOptions, IJpegFrameSource, Stream stdout, Stream stdin,
//                                 IStreamClock, StreamLimits, CancellationToken) -> Task<int>
// Pacing uses IStreamClock; the write-stall timeout is measured in real time (a blocked write
// never lets the clock move), so the G9 tests use real 100–500 ms limits.
// The stdin heartbeat timeout (A-HB) is also real time: stdin is read by a background watcher that the
// fake clock cannot see, so the HB-G tests use real 100–300 ms timeouts. FastLimits keeps it at 30 s so
// tests with a silent OpenStdin are unaffected.
public sealed class StreamTests
{
    private static readonly TimeSpan Guard = TimeSpan.FromSeconds(5);

    private static readonly StreamLimits FastLimits = new(
        MaxFrameBytes: 2_097_152,
        WriteStallTimeout: TimeSpan.FromSeconds(2),
        HeartbeatTimeout: TimeSpan.FromSeconds(30));

    private sealed class Rig
    {
        public CancellationTokenSource Stop { get; } = new();
        public FakeStreamClock Clock { get; } = new();
        public FakeFrameSource Source { get; }
        public MemoryStream Stdout { get; } = new();

        public Rig() => Source = new FakeFrameSource(Clock, Stop);

        public Task<int> RunAsync(
            StreamOptions? options = null,
            System.IO.Stream? stdout = null,
            System.IO.Stream? stdin = null,
            StreamLimits? limits = null) =>
            StreamSession
                .RunAsync(
                    options ?? new StreamOptions(10, 800, 70),
                    Source,
                    stdout ?? Stdout,
                    stdin ?? new OpenStdin(),
                    Clock,
                    limits ?? FastLimits,
                    Stop.Token)
                .WaitAsync(Guard);

        public List<byte[]> Frames() => StreamTestData.ReadFrames(Stdout.ToArray());
    }

    // ---------- G1 mode dispatch ----------

    [Fact]
    public void G1_no_args_selects_the_ndjson_session() =>
        Assert.Equal(AgentMode.Ndjson, Program.ResolveMode([]));

    public static TheoryData<string[]> StreamModeArgs => new()
    {
        new[] { "stream" },
        new[] { "stream", "--fps", "5" },
        new[] { "stream", "--bogus" }, // flag validation is StreamOptions' job, not dispatch
    };

    public static TheoryData<string[]> InvalidModeArgs => new()
    {
        new[] { "bogus" },
        new[] { "--fps", "5" },
        new[] { "" },
    };

    [Theory]
    [MemberData(nameof(StreamModeArgs))]
    public void G1_first_arg_stream_selects_stream_mode(string[] args) =>
        Assert.Equal(AgentMode.Stream, Program.ResolveMode(args));

    [Theory]
    [MemberData(nameof(InvalidModeArgs))]
    public void G1_any_other_first_arg_is_invalid(string[] args) =>
        Assert.Equal(AgentMode.Invalid, Program.ResolveMode(args));

    // ---------- G2 option defaults and accepted boundaries ----------

    [Fact]
    public void G2_no_flags_yields_the_defaults()
    {
        Assert.True(StreamOptions.TryParse([], out StreamOptions? options, out string? error));
        Assert.Null(error);
        Assert.Equal(new StreamOptions(15, 800, 70), options);
    }

    [Theory]
    [InlineData(new[] { "--fps", "1" }, 1, 800, 70)]
    [InlineData(new[] { "--fps", "30" }, 30, 800, 70)]
    [InlineData(new[] { "--max-long-edge", "320" }, 15, 320, 70)]
    [InlineData(new[] { "--max-long-edge", "1920" }, 15, 1920, 70)]
    [InlineData(new[] { "--quality", "30" }, 15, 800, 30)]
    [InlineData(new[] { "--quality", "95" }, 15, 800, 95)]
    [InlineData(new[] { "--quality", "50", "--fps", "5", "--max-long-edge", "1024" }, 5, 1024, 50)]
    public void G2_accepts_boundary_values_in_any_order(string[] args, int fps, int edge, int quality)
    {
        Assert.True(StreamOptions.TryParse(args, out StreamOptions? options, out string? error), error);
        Assert.Null(error);
        Assert.Equal(new StreamOptions(fps, edge, quality), options);
    }

    // ---------- G3 rejected arguments ----------

    [Theory]
    [InlineData(new[] { "--fps", "0" }, "--fps")]
    [InlineData(new[] { "--fps", "31" }, "--fps")]
    [InlineData(new[] { "--max-long-edge", "319" }, "--max-long-edge")]
    [InlineData(new[] { "--max-long-edge", "1921" }, "--max-long-edge")]
    [InlineData(new[] { "--quality", "29" }, "--quality")]
    [InlineData(new[] { "--quality", "96" }, "--quality")]
    [InlineData(new[] { "--fps", "abc" }, "--fps")]
    [InlineData(new[] { "--fps", "1.5" }, "--fps")]
    [InlineData(new[] { "--fps", "" }, "--fps")]
    [InlineData(new[] { "--fps" }, "--fps")]
    [InlineData(new[] { "--fps", "--quality", "50" }, "--fps")]
    [InlineData(new[] { "--fps", "5", "--fps", "6" }, "--fps")]
    [InlineData(new[] { "--max-size", "800" }, "--max-size")]
    [InlineData(new[] { "--bogus" }, "--bogus")]
    [InlineData(new[] { "extra" }, "extra")]
    [InlineData(new[] { "--fps", "5", "extra" }, "extra")]
    public void G3_rejects_invalid_arguments_with_a_message_naming_the_culprit(string[] args, string culprit)
    {
        Assert.False(StreamOptions.TryParse(args, out StreamOptions? options, out string? error));
        Assert.Null(options);
        Assert.False(string.IsNullOrWhiteSpace(error));
        Assert.Contains(culprit, error);
    }

    // ---------- G4 frame writer ----------

    [Fact]
    public async Task G4_writes_a_big_endian_length_prefix_then_the_bytes()
    {
        MemoryStream output = new();
        byte[] jpeg = StreamTestData.Jpeg(300, tag: 3);

        await new FrameWriter(output).WriteFrameAsync(jpeg, CancellationToken.None);

        byte[] raw = output.ToArray();
        Assert.Equal(4 + 300, raw.Length);
        Assert.Equal(new byte[] { 0x00, 0x00, 0x01, 0x2C }, raw[..4]);
        Assert.Equal(jpeg, raw[4..]);
    }

    [Fact]
    public async Task G4_uses_all_four_prefix_bytes_for_larger_frames()
    {
        MemoryStream output = new();

        await new FrameWriter(output).WriteFrameAsync(StreamTestData.Jpeg(70_000), CancellationToken.None);

        Assert.Equal(4 + 70_000, output.Length);
        Assert.Equal(new byte[] { 0x00, 0x01, 0x11, 0x70 }, output.ToArray()[..4]);
    }

    [Fact]
    public async Task G4_concatenates_frames_and_flushes_after_each_complete_frame()
    {
        FlushRecordingStream output = new();
        FrameWriter writer = new(output);
        byte[] first = StreamTestData.Jpeg(10, tag: 1);
        byte[] second = StreamTestData.Jpeg(20, tag: 2);

        await writer.WriteFrameAsync(first, CancellationToken.None);
        await writer.WriteFrameAsync(second, CancellationToken.None);

        List<byte[]> frames = StreamTestData.ReadFrames(output.ToArray());
        Assert.Equal([first, second], frames);
        Assert.Equal([4L + 10, 4L + 10 + 4 + 20], output.FlushedAtLength);
    }

    // ---------- G5 frame cap and empty captures ----------

    [Fact]
    public void G5_default_limits_are_2_MiB_and_5_seconds()
    {
        Assert.Equal(2_097_152, StreamLimits.Default.MaxFrameBytes);
        Assert.Equal(TimeSpan.FromSeconds(5), StreamLimits.Default.WriteStallTimeout);
    }

    [Fact]
    public async Task G5_skips_frames_over_the_cap_writes_frames_at_the_cap_and_continues()
    {
        Rig rig = new();
        rig.Source.Frames(101, 100, 50);

        int code = await rig.RunAsync(limits: FastLimits with { MaxFrameBytes = 100 });

        Assert.Equal(0, code);
        Assert.Equal([100, 50], rig.Frames().Select(frame => frame.Length));
        Assert.Equal(4, rig.Source.Captures.Count);
    }

    [Fact]
    public async Task G5_skips_zero_length_captures_and_continues()
    {
        Rig rig = new();
        rig.Source.Frames(0, 10, 0, 20);

        int code = await rig.RunAsync();

        Assert.Equal(0, code);
        Assert.Equal([10, 20], rig.Frames().Select(frame => frame.Length));
    }

    // ---------- G6 pacing ----------

    [Fact]
    public async Task G6_captures_on_a_fixed_schedule_without_drift_and_passes_edge_and_quality()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5, 5, 5, 5);
        rig.Source.Cost = _ => TimeSpan.FromMilliseconds(30); // work shorter than the 100 ms interval

        int code = await rig.RunAsync(new StreamOptions(10, 1024, 55));

        Assert.Equal(0, code);
        List<TimeSpan> at = rig.Source.Captures.Select(capture => capture.At).ToList();
        TimeSpan start = at[0];
        Assert.Equal(
            Enumerable.Range(0, 6).Select(k => start + TimeSpan.FromMilliseconds(100 * k)),
            at);
        Assert.All(rig.Source.Captures, capture => Assert.Equal((1024, 55), (capture.MaxLongEdge, capture.Quality)));
        Assert.Equal(5, rig.Frames().Count);
    }

    [Fact]
    public async Task G6_drops_missed_slots_instead_of_bursting_to_catch_up()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5, 5, 5);
        // Capture #1 (due at +100 ms) takes 350 ms and ends at +450 ms: slots +200 and +300 are missed by a
        // whole period or more and dropped; slot +400 is late by less than a period, so it is captured at once.
        rig.Source.Cost = index => index == 1 ? TimeSpan.FromMilliseconds(350) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        TimeSpan start = rig.Source.Captures[0].At;
        Assert.Equal(
            new[] { 0, 100, 450, 500, 600 }.Select(ms => start + TimeSpan.FromMilliseconds(ms)),
            rig.Source.Captures.Select(capture => capture.At));
        Assert.Equal(4, rig.Frames().Count); // the late frame is still delivered once; nothing is queued
    }

    [Fact]
    public async Task G6_never_waits_for_a_due_time_already_in_the_past()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5, 5);
        rig.Source.Cost = index => index == 0 ? TimeSpan.FromMilliseconds(950) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        Assert.Equal(4, rig.Source.Captures.Count);
        // After a 950 ms capture at 10 fps, slot +900 is late by less than a period and is captured at once
        // (no time passes); the 8 stale slots +100..+800 are never targeted; then the schedule resumes at +1000.
        TimeSpan start = rig.Source.Captures[0].At;
        Assert.Equal(start + TimeSpan.FromMilliseconds(950), rig.Source.Captures[1].At);
        Assert.Equal(start + TimeSpan.FromMilliseconds(1_000), rig.Source.Captures[2].At);
        Assert.DoesNotContain(rig.Clock.Dues, due => due > start && due < start + TimeSpan.FromMilliseconds(900));
    }

    // ---------- FP frame pacing under a coarse timer ----------
    // Rule: next slot = max(current + 1, first slot whose due time > now - period), where due(k) =
    // start + k * TicksPerSecond / fps ticks and period = TicksPerSecond / fps ticks. A slot late by less than one
    // period is captured immediately; one late by a whole period or more (due <= now - period) is skipped. The
    // sleep is DelayUntilAsync(due) as before. Boundary tests use 10 fps, where the period is exactly 1_000_000 ticks.

    private static TimeSpan Slot(long k, int fps) => TimeSpan.FromTicks(k * TimeSpan.TicksPerSecond / fps);

    private static List<TimeSpan> Relative(Rig rig)
    {
        TimeSpan start = rig.Source.Captures[0].At;
        return rig.Source.Captures.Select(capture => capture.At - start).ToList();
    }

    private static IEnumerable<TimeSpan> Ms(params double[] values) => values.Select(TimeSpan.FromMilliseconds);

    /// <summary>Capture k happened for slot k: no earlier than its due time and less than one period late.</summary>
    private static void AssertConsecutiveSlots(IReadOnlyList<TimeSpan> at, int count, int fps)
    {
        for (int k = 0; k < count; k++)
        {
            Assert.True(
                at[k] >= Slot(k, fps) && at[k] < Slot(k + 1, fps),
                $"Capture #{k} at {at[k].TotalMilliseconds:0.###} ms is not in slot {k} " +
                $"[{Slot(k, fps).TotalMilliseconds:0.###}, {Slot(k + 1, fps).TotalMilliseconds:0.###}) ms.");
        }
    }

    [Fact]
    public async Task FP2_30_fps_holds_when_each_wait_overshoots_and_capture_takes_most_of_a_period()
    {
        Rig rig = new();
        rig.Clock.Overshoot = TimeSpan.FromMilliseconds(15);
        for (int i = 0; i < 40; i++) rig.Source.Frames(5);
        rig.Source.Cost = _ => TimeSpan.FromMilliseconds(27);

        int code = await rig.RunAsync(new StreamOptions(30, 800, 70));

        Assert.Equal(0, code);
        List<TimeSpan> at = Relative(rig);
        int inFirstSecond = at.Count(t => t < TimeSpan.FromSeconds(1));
        Assert.True(inFirstSecond >= 29, $"Only {inFirstSecond} captures in the first simulated second at --fps 30.");
        AssertConsecutiveSlots(at, 30, fps: 30);
    }

    [Fact]
    public async Task FP3_a_slot_late_by_less_than_a_period_is_captured_immediately()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5, 5, 5);
        // Capture #1 (slot 1, +100 ms) ends at +219 ms: slot 2 (+200 ms) is 19 ms late.
        rig.Source.Cost = index => index == 1 ? TimeSpan.FromMilliseconds(119) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        Assert.Equal(Ms(0, 100, 219, 300, 400), Relative(rig));
    }

    [Fact]
    public async Task FP4_a_slot_late_by_exactly_one_period_is_skipped()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5, 5, 5);
        // Capture #1 ends at +300 ms = due(2) + period: slot 2 is skipped; slot 3 (due now) is captured, once.
        rig.Source.Cost = index => index == 1 ? TimeSpan.FromMilliseconds(200) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        Assert.Equal(Ms(0, 100, 300, 400, 500), Relative(rig));
    }

    [Fact]
    public async Task FP4_a_slot_late_by_one_period_minus_a_tick_is_still_captured()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5, 5, 5);
        // Capture #1 ends one tick before +300 ms: slot 2 (+200 ms) is late by period - 1 tick, so it is captured
        // at once; slot 3 (+300 ms) then follows on schedule.
        rig.Source.Cost = index => index == 1 ? TimeSpan.FromMilliseconds(200) - TimeSpan.FromTicks(1) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        Assert.Equal(
            new[]
            {
                TimeSpan.Zero,
                TimeSpan.FromMilliseconds(100),
                TimeSpan.FromMilliseconds(300) - TimeSpan.FromTicks(1),
                TimeSpan.FromMilliseconds(300),
                TimeSpan.FromMilliseconds(400),
            },
            Relative(rig));
    }

    [Fact]
    public async Task FP5_a_stall_never_causes_a_burst_or_a_rate_above_fps()
    {
        Rig rig = new();
        rig.Clock.Overshoot = TimeSpan.FromMilliseconds(15);
        rig.Source.Frames(5, 5, 5, 5, 5, 5);
        // Capture #1 (woken at +115 ms) takes 350 ms and ends at +465 ms; the rest are free.
        rig.Source.Cost = index => index == 1 ? TimeSpan.FromMilliseconds(350) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        List<TimeSpan> at = Relative(rig);
        // Slot 4 (+400) is late by < a period and captured at once; slots 2 and 3 are dropped; then slots 5, 6, ...
        Assert.Equal(Ms(0, 115, 465, 515, 615, 715, 815), at);
        TimeSpan period = Slot(1, 10);
        foreach (TimeSpan t in at)
            Assert.True(at.Count(other => other >= t && other < t + period) <= 2, $"Burst after {t.TotalMilliseconds} ms.");
        double allowed = Math.Ceiling(at[^1].TotalSeconds * 10) + 1;
        Assert.True(at.Count <= allowed, $"{at.Count} captures in {at[^1]} exceeds {allowed}.");
    }

    [Theory]
    [InlineData(15, 1_000, 15)]
    [InlineData(1, 3_000, 3)]
    public async Task FP7_lower_fps_with_overshoot_delivers_exactly_fps(int fps, int windowMs, int expected)
    {
        Rig rig = new();
        rig.Clock.Overshoot = TimeSpan.FromMilliseconds(15);
        for (int i = 0; i < expected + 5; i++) rig.Source.Frames(5);
        rig.Source.Cost = _ => TimeSpan.FromMilliseconds(27);

        int code = await rig.RunAsync(new StreamOptions(fps, 800, 70));

        Assert.Equal(0, code);
        List<TimeSpan> at = Relative(rig);
        Assert.Equal(expected, at.Count(t => t < TimeSpan.FromMilliseconds(windowMs)));
        AssertConsecutiveSlots(at, expected, fps);
    }

    [Fact]
    public async Task FP8_a_10_second_clock_jump_yields_one_late_capture_then_the_normal_schedule()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5, 5, 5);
        // Capture #1 (+100 ms) ends at +10 150 ms, e.g. the VM was paused: 99 slots are behind.
        rig.Source.Cost = index => index == 1 ? TimeSpan.FromMilliseconds(10_050) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        List<TimeSpan> at = Relative(rig);
        Assert.Equal(Ms(0, 100, 10_150, 10_200, 10_300), at);
        Assert.Single(at, t => t >= TimeSpan.FromMilliseconds(10_100) && t < TimeSpan.FromMilliseconds(10_200));
    }

    [Fact]
    public async Task FP9_a_failed_capture_uses_its_slot_and_is_not_retried()
    {
        Rig rig = new();
        rig.Source.Frames(5);
        rig.Source.Steps.Add(() => throw new InvalidOperationException("The desktop is locked."));
        rig.Source.Frames(5, 5);

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        Assert.Equal(Ms(0, 100, 200, 300, 400), Relative(rig));
        Assert.Equal(3, rig.Frames().Count);
    }

    [Fact]
    public async Task FP9_a_slow_failed_capture_still_lets_a_slot_late_by_less_than_a_period_be_captured()
    {
        Rig rig = new();
        rig.Source.Frames(5);
        rig.Source.Steps.Add(() => throw new InvalidOperationException("The desktop is locked."));
        rig.Source.Frames(5, 5);
        // The failing capture #1 (+100 ms) takes 150 ms: slot 2 (+200 ms) is 50 ms late at +250 ms.
        rig.Source.Cost = index => index == 1 ? TimeSpan.FromMilliseconds(150) : TimeSpan.Zero;

        int code = await rig.RunAsync(new StreamOptions(10, 800, 70));

        Assert.Equal(0, code);
        Assert.Equal(Ms(0, 100, 250, 300, 400), Relative(rig));
        Assert.Equal(3, rig.Frames().Count);
    }

    [Fact]
    public async Task FP10_the_first_frame_is_captured_immediately_without_waiting()
    {
        Rig rig = new();
        rig.Clock.Overshoot = TimeSpan.FromMilliseconds(15);
        TimeSpan startedAt = rig.Clock.Elapsed;
        int duesBeforeFirstCapture = -1;
        rig.Source.Frames(5, 5);
        rig.Source.AfterCapture = index =>
        {
            if (index == 0) duesBeforeFirstCapture = rig.Clock.Dues.Count;
        };

        int code = await rig.RunAsync(new StreamOptions(30, 800, 70));

        Assert.Equal(0, code);
        Assert.Equal(startedAt, rig.Source.Captures[0].At);
        Assert.Equal(0, duesBeforeFirstCapture);
    }

    // ---------- G7 normal stop ----------

    [Fact]
    public async Task G7_stdin_eof_stops_the_stream_with_exit_0()
    {
        Rig rig = new();
        rig.Clock.RealDelayPerWait = TimeSpan.FromMilliseconds(10);
        GatedStdin stdin = new();
        for (int i = 0; i < 200; i++) rig.Source.Frames(5);
        rig.Source.AfterCapture = index =>
        {
            if (index == 2) stdin.CloseInput();
        };

        int code = await rig.RunAsync(stdin: stdin);

        Assert.Equal(0, code);
        // EOF arrives during capture #2; allow at most one capture already in flight after that.
        Assert.InRange(rig.Source.Captures.Count, 3, 4);
    }

    [Fact]
    public async Task G7_stdin_already_at_eof_stops_without_streaming()
    {
        Rig rig = new();
        rig.Clock.RealDelayPerWait = TimeSpan.FromMilliseconds(10);
        for (int i = 0; i < 200; i++) rig.Source.Frames(5);

        int code = await rig.RunAsync(stdin: new MemoryStream());

        Assert.Equal(0, code);
        Assert.InRange(rig.Source.Captures.Count, 0, 1);
    }

    [Fact]
    public async Task G7_cancellation_stops_the_stream_with_exit_0()
    {
        Rig rig = new();
        rig.Source.Frames(5, 5);

        int code = await rig.RunAsync();

        Assert.Equal(0, code);
        Assert.Equal(2, rig.Frames().Count);
    }

    // ---------- G8 broken stdout ----------

    [Fact]
    public async Task G8_a_failing_stdout_write_exits_1_without_retrying()
    {
        Rig rig = new();
        for (int i = 0; i < 20; i++) rig.Source.Frames(5);
        BrokenStdout stdout = new();

        int code = await rig.RunAsync(stdout: stdout);

        Assert.Equal(1, code);
        Assert.Single(rig.Source.Captures);
        Assert.Equal(1, stdout.WriteAttempts);
    }

    // ---------- G9 write-stall watchdog (real time) ----------

    [Fact]
    public async Task G9_a_write_blocked_for_the_stall_timeout_exits_1()
    {
        Rig rig = new();
        for (int i = 0; i < 20; i++) rig.Source.Frames(5);
        StalledStdout stdout = new();
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await rig.RunAsync(
            stdout: stdout,
            limits: FastLimits with { WriteStallTimeout = TimeSpan.FromMilliseconds(100) });

        Assert.Equal(1, code);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(80), $"Gave up after only {elapsed.Elapsed}.");
        Assert.Single(rig.Source.Captures);
        Assert.Equal(1, stdout.WriteAttempts);
    }

    [Fact]
    public async Task G9_slow_writes_under_the_stall_timeout_keep_streaming()
    {
        Rig rig = new();
        rig.Source.Frames(5, 6, 7);
        SlowStdout stdout = new(TimeSpan.FromMilliseconds(20));

        int code = await rig.RunAsync(
            stdout: stdout,
            limits: FastLimits with { WriteStallTimeout = TimeSpan.FromMilliseconds(500) });

        Assert.Equal(0, code);
        Assert.Equal([5, 6, 7], StreamTestData.ReadFrames(stdout.Inner.ToArray()).Select(frame => frame.Length));
    }

    // ---------- G10 capture failures ----------

    [Fact]
    public async Task G10_a_failed_capture_is_skipped_and_streaming_continues()
    {
        Rig rig = new();
        rig.Source.Frames(10);
        rig.Source.Steps.Add(() => throw new InvalidOperationException("The desktop is locked."));
        rig.Source.Frames(30, 40);

        int code = await rig.RunAsync();

        Assert.Equal(0, code);
        Assert.Equal([10, 30, 40], rig.Frames().Select(frame => frame.Length));
        Assert.Equal(5, rig.Source.Captures.Count);
    }

    // ---------- HB-G stdin heartbeat (A-HB, real time) ----------

    /// <summary>A rig whose capture loop paces in real time and never runs out of frames within the guard.</summary>
    private static Rig LiveRig()
    {
        Rig rig = new();
        rig.Clock.RealDelayPerWait = TimeSpan.FromMilliseconds(5);
        for (int i = 0; i < 2_000; i++) rig.Source.Frames(5);
        return rig;
    }

    private static StreamLimits Heartbeat(int ms) => FastLimits with { HeartbeatTimeout = TimeSpan.FromMilliseconds(ms) };

    [Fact]
    public void HB_G3_default_heartbeat_timeout_is_5_seconds() =>
        Assert.Equal(TimeSpan.FromSeconds(5), StreamLimits.Default.HeartbeatTimeout);

    [Fact]
    public async Task HB_G1_silent_stdin_past_the_heartbeat_timeout_exits_1_and_stops_capturing()
    {
        Rig rig = LiveRig();
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await rig.RunAsync(stdin: new OpenStdin(), limits: Heartbeat(100));

        Assert.Equal(1, code);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(80), $"Gave up after only {elapsed.Elapsed}.");
        int capturesAtExit = rig.Source.Captures.Count;
        await Task.Delay(150);
        Assert.Equal(capturesAtExit, rig.Source.Captures.Count);
        Assert.True(rig.Source.Captures.Count < 2_000, "The session ran out of scripted frames instead of timing out.");
    }

    [Fact]
    public async Task HB_G1_the_timeout_runs_from_the_last_byte_then_exits_1_when_stdin_goes_silent()
    {
        Rig rig = LiveRig();
        // 5 beats 40 ms apart (~200 ms), then silence. Without resets the session would end at ~150 ms.
        HeartbeatStdin stdin = new(TimeSpan.FromMilliseconds(40), beats: 5, eofAfterBeats: false);
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await rig.RunAsync(stdin: stdin, limits: Heartbeat(150));

        Assert.Equal(1, code);
        Assert.Equal(5, stdin.BeatsDelivered);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(300), $"Timed out after only {elapsed.Elapsed}.");
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)] // several bytes in one read are still just a heartbeat
    public async Task HB_G2_bytes_arriving_within_the_timeout_keep_streaming_until_eof_exits_0(int bytesPerBeat)
    {
        Rig rig = LiveRig();
        // 10 beats 30 ms apart (~300 ms, twice the 150 ms timeout), then EOF.
        HeartbeatStdin stdin = new(TimeSpan.FromMilliseconds(30), beats: 10, eofAfterBeats: true, bytesPerBeat);
        Stopwatch elapsed = Stopwatch.StartNew();

        int code = await rig.RunAsync(stdin: stdin, limits: Heartbeat(150));

        Assert.Equal(0, code);
        Assert.Equal(10, stdin.BeatsDelivered);
        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(250), $"Stopped after only {elapsed.Elapsed}.");
        Assert.NotEmpty(rig.Frames());
    }

    [Fact]
    public async Task HB_G2_eof_before_the_heartbeat_timeout_still_exits_0()
    {
        Rig rig = LiveRig();

        int code = await rig.RunAsync(stdin: new MemoryStream(), limits: Heartbeat(100));

        Assert.Equal(0, code);
    }
}
