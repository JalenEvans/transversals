namespace Transversals.GuestAgent.Host.Streaming;

/// <summary>
/// The <c>stream</c> mode loop: capture JPEG frames on a fixed schedule and write them to stdout until
/// stdin reaches EOF (the host went away), the host's stdin heartbeat stops, or the session is cancelled.
/// </summary>
internal static class StreamSession
{
    public const int ExitOk = 0;
    public const int ExitFailure = 1;

    /// <summary>Set by the stdin watcher before it cancels the session for a missed heartbeat.</summary>
    private sealed class HostPresence
    {
        private volatile bool _lost;

        public bool Lost => _lost;

        public void MarkLost() => _lost = true;
    }

    /// <returns>0 on EOF or cancellation; 1 when stdout fails or stalls, or the host heartbeat stops.</returns>
    public static async Task<int> RunAsync(
        StreamOptions options,
        IJpegFrameSource source,
        Stream stdout,
        Stream stdin,
        IStreamClock clock,
        StreamLimits limits,
        CancellationToken cancellationToken)
    {
        using CancellationTokenSource session = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        CancellationToken ct = session.Token;
        HostPresence host = new();
        // Fire and forget: on exit the watcher is cancelled, never awaited (a real console read may ignore it).
        _ = WatchStdinAsync(stdin, limits.HeartbeatTimeout, host, session);
        int CancelledExit() => host.Lost ? ExitFailure : ExitOk;

        FrameWriter writer = new(stdout);
        TimeSpan start = clock.Elapsed;
        long slot = 0;
        try
        {
            while (true)
            {
                ct.ThrowIfCancellationRequested();

                byte[]? frame = TryCapture(source, options, ct);
                if (frame is not null && frame.Length > 0 && frame.Length <= limits.MaxFrameBytes)
                {
                    if (!await TryWriteAsync(writer, frame, limits.WriteStallTimeout, ct).ConfigureAwait(false))
                        return ct.IsCancellationRequested ? CancelledExit() : ExitFailure;
                }

                slot = NextSlot(slot, clock.Elapsed - start, options.Fps);
                await clock.DelayUntilAsync(start + SlotOffset(slot, options.Fps), ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return CancelledExit();
        }
        finally
        {
            session.Cancel();
        }
    }

    /// <summary>Offset of slot <paramref name="slot"/> from the start; computed per slot so rounding never accumulates.</summary>
    private static TimeSpan SlotOffset(long slot, int fps) => TimeSpan.FromTicks(slot * TimeSpan.TicksPerSecond / fps);

    /// <summary>
    /// The first slot after <paramref name="current"/> that is late by less than one period (due &gt; now − period).
    /// Such a slot is captured at once; slots missed by a whole period or more are dropped. A wait in the VM wakes
    /// 15–20 ms late (the timer resolution can't be raised there), so requiring a future slot would skip every
    /// other one at 30 fps.
    /// </summary>
    private static long NextSlot(long current, TimeSpan sinceStart, int fps)
    {
        long period = TimeSpan.TicksPerSecond / fps;
        // Smallest k with due(k) = floor(k·TicksPerSecond/fps) > threshold, i.e. k·TicksPerSecond ≥ (threshold + 1)·fps.
        long threshold = sinceStart.Ticks - period;
        long scaled = Math.Max(0, (threshold + 1) * fps);
        long firstLive = (scaled + TimeSpan.TicksPerSecond - 1) / TimeSpan.TicksPerSecond;
        return Math.Max(current + 1, firstLive);
    }

    /// <summary>A failed capture (e.g. a locked desktop) skips this slot; cancellation still propagates.</summary>
    private static byte[]? TryCapture(IJpegFrameSource source, StreamOptions options, CancellationToken ct)
    {
        try
        {
            return source.Capture(options.MaxLongEdge, options.Quality);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Writes one frame. False when the write fails or makes no progress within <paramref name="stallTimeout"/>
    /// of real time; a stalled write is abandoned, not awaited, because pipe writes can ignore cancellation.
    /// </summary>
    private static async Task<bool> TryWriteAsync(
        FrameWriter writer,
        byte[] frame,
        TimeSpan stallTimeout,
        CancellationToken ct)
    {
        Task write = writer.WriteFrameAsync(frame, ct);
        using CancellationTokenSource stallTimer = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task stall = Task.Delay(stallTimeout, stallTimer.Token);
        if (await Task.WhenAny(write, stall).ConfigureAwait(false) != write)
        {
            ObserveFault(write);
            return false;
        }

        stallTimer.Cancel();
        try
        {
            await write.ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Watches stdin until the session ends. Any bytes are a host heartbeat (content ignored); EOF or a broken
    /// stdin ends the session normally. No byte within <paramref name="heartbeatTimeout"/> (real time) of the
    /// start or of the last byte means the host vanished without closing the pipe (e.g. a killed prlctl), so
    /// the session ends as a failure. A read that outlives the timeout is abandoned, never awaited.
    /// </summary>
    private static async Task WatchStdinAsync(
        Stream stdin,
        TimeSpan heartbeatTimeout,
        HostPresence host,
        CancellationTokenSource session)
    {
        // Read the token before the first await; the session may be disposed while a read is pending.
        CancellationToken ct = session.Token;
        byte[] buffer = new byte[256];
        try
        {
            while (true)
            {
                Task<int> read = stdin.ReadAsync(buffer, ct).AsTask();
                using CancellationTokenSource timerCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                Task timeout = Task.Delay(heartbeatTimeout, timerCts.Token);
                if (await Task.WhenAny(read, timeout).ConfigureAwait(false) != read)
                {
                    ObserveFault(read);
                    if (ct.IsCancellationRequested) return;
                    host.MarkLost();
                    break;
                }

                timerCts.Cancel();
                if (await read.ConfigureAwait(false) == 0) break;
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return;
        }
        catch (Exception)
        {
            // A broken stdin means the host is gone, the same as EOF.
        }

        try
        {
            session.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The session already ended.
        }
    }

    /// <summary>Keeps an abandoned write's eventual exception from surfacing as unobserved.</summary>
    private static void ObserveFault(Task task) =>
        _ = task.ContinueWith(
            static completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
}
