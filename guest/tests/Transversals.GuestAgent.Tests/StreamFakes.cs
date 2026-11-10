using System.Buffers.Binary;
using Transversals.GuestAgent.Host.Streaming;

namespace Transversals.GuestAgent.Tests;

/// <summary>
/// Deterministic monotonic clock. Time only moves when a capture "costs" time or a wait is due in the future.
/// Every wait yields (or sleeps <see cref="RealDelayPerWait"/>) so background stdin watchers get to run.
/// </summary>
internal sealed class FakeStreamClock : IStreamClock
{
    public TimeSpan Elapsed { get; private set; } = TimeSpan.FromSeconds(10);

    public List<TimeSpan> Dues { get; } = [];

    public TimeSpan RealDelayPerWait { get; set; } = TimeSpan.Zero;

    /// <summary>
    /// How late a real wait wakes (a coarse Windows timer): a future <c>due</c> completes at <c>due + Overshoot</c>;
    /// a due time already reached completes immediately, with no overshoot. Default: exact.
    /// </summary>
    public TimeSpan Overshoot { get; set; } = TimeSpan.Zero;

    public void Advance(TimeSpan by) => Elapsed += by;

    public async Task DelayUntilAsync(TimeSpan due, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Dues.Add(due);
        if (due > Elapsed) Elapsed = due + Overshoot;
        if (RealDelayPerWait > TimeSpan.Zero) await Task.Delay(RealDelayPerWait, ct);
        else await Task.Yield();
        ct.ThrowIfCancellationRequested();
    }
}

/// <summary>
/// Scripted capture source. Each step returns bytes or throws. When the script runs out it cancels
/// <paramref name="stop"/> and throws OperationCanceledException, which ends the session with exit 0.
/// </summary>
internal sealed class FakeFrameSource(FakeStreamClock clock, CancellationTokenSource stop) : IJpegFrameSource
{
    public List<Func<byte[]>> Steps { get; } = [];

    /// <summary>Clock time consumed by capture #index (0-based). Default: free.</summary>
    public Func<int, TimeSpan> Cost { get; set; } = _ => TimeSpan.Zero;

    /// <summary>Invoked after capture #index is recorded (e.g. to close stdin).</summary>
    public Action<int>? AfterCapture { get; set; }

    public List<(TimeSpan At, int MaxLongEdge, int Quality)> Captures { get; } = [];

    public byte[] Capture(int maxLongEdge, int quality)
    {
        int index = Captures.Count;
        Captures.Add((clock.Elapsed, maxLongEdge, quality));
        clock.Advance(Cost(index));
        AfterCapture?.Invoke(index);
        if (index >= Steps.Count)
        {
            stop.Cancel();
            throw new OperationCanceledException(stop.Token);
        }
        return Steps[index]();
    }

    public FakeFrameSource Frames(params int[] lengths)
    {
        foreach (int length in lengths)
        {
            byte tag = (byte)Steps.Count;
            Steps.Add(() => StreamTestData.Jpeg(length, tag));
        }
        return this;
    }
}

internal static class StreamTestData
{
    /// <summary>A fake JPEG of <paramref name="length"/> bytes, distinguishable by <paramref name="tag"/>.</summary>
    public static byte[] Jpeg(int length, byte tag = 0) =>
        Enumerable.Range(0, length).Select(i => (byte)((i + tag * 31) & 0xFF)).ToArray();

    /// <summary>Splits a length-prefixed stream into frames, failing on any malformed framing.</summary>
    public static List<byte[]> ReadFrames(byte[] raw)
    {
        List<byte[]> frames = [];
        int offset = 0;
        while (offset < raw.Length)
        {
            Assert.True(raw.Length - offset >= 4, $"Truncated length prefix at offset {offset}.");
            int length = BinaryPrimitives.ReadInt32BigEndian(raw.AsSpan(offset, 4));
            offset += 4;
            Assert.True(length >= 0 && raw.Length - offset >= length, $"Truncated frame at offset {offset}.");
            frames.Add(raw.AsSpan(offset, length).ToArray());
            offset += length;
        }
        return frames;
    }
}

/// <summary>Minimal Stream base: async memory overloads are the single point of behaviour.</summary>
internal abstract class FakeStreamBase : System.IO.Stream
{
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();

    public override int Read(byte[] buffer, int offset, int count) =>
        ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) =>
        throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) =>
        WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) =>
        throw new NotSupportedException();
}

/// <summary>Stdin that stays open (host alive) until cancelled.</summary>
internal sealed class OpenStdin : FakeStreamBase
{
    public override bool CanRead => true;

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        await Task.Delay(Timeout.Infinite, ct);
        return 0;
    }
}

/// <summary>Stdin that stays open until <see cref="CloseInput"/>, then reports EOF.</summary>
internal sealed class GatedStdin : FakeStreamBase
{
    private readonly TaskCompletionSource eof = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public override bool CanRead => true;

    public void CloseInput() => eof.TrySetResult();

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        await eof.Task.WaitAsync(ct);
        return 0;
    }
}

/// <summary>
/// Host heartbeat stand-in (A-HB): delivers <paramref name="beats"/> reads of <paramref name="bytesPerBeat"/>
/// newline bytes, <paramref name="interval"/> of real time apart, then reports EOF or goes silent until cancelled.
/// </summary>
internal sealed class HeartbeatStdin(TimeSpan interval, int beats, bool eofAfterBeats, int bytesPerBeat = 1) : FakeStreamBase
{
    private int delivered;

    public int BeatsDelivered => Volatile.Read(ref delivered);

    public override bool CanRead => true;

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        if (BeatsDelivered < beats)
        {
            await Task.Delay(interval, ct);
            int count = Math.Min(bytesPerBeat, buffer.Length);
            buffer.Span[..count].Fill((byte)'\n');
            Interlocked.Increment(ref delivered);
            return count;
        }
        if (eofAfterBeats) return 0;
        await Task.Delay(Timeout.Infinite, ct);
        return 0;
    }
}

/// <summary>Records the stream length each time the writer flushes.</summary>
internal sealed class FlushRecordingStream : MemoryStream
{
    public List<long> FlushedAtLength { get; } = [];

    public override void Flush()
    {
        FlushedAtLength.Add(Length);
        base.Flush();
    }

    public override Task FlushAsync(CancellationToken ct)
    {
        FlushedAtLength.Add(Length);
        return Task.CompletedTask;
    }
}

/// <summary>Stdout whose consumer is gone: every write fails.</summary>
internal sealed class BrokenStdout : FakeStreamBase
{
    public int WriteAttempts { get; private set; }

    public override bool CanWrite => true;

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        WriteAttempts++;
        throw new IOException("The pipe has been ended.");
    }
}

/// <summary>Stdout whose reader stopped reading: writes never complete and ignore cancellation, like a full pipe.</summary>
internal sealed class StalledStdout : FakeStreamBase
{
    private readonly TaskCompletionSource never = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public int WriteAttempts { get; private set; }

    public override bool CanWrite => true;

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        WriteAttempts++;
        return new ValueTask(never.Task);
    }
}

/// <summary>Stdout where every write takes <paramref name="delay"/> of real time, then succeeds.</summary>
internal sealed class SlowStdout(TimeSpan delay) : FakeStreamBase
{
    public MemoryStream Inner { get; } = new();

    public override bool CanWrite => true;

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        await Task.Delay(delay, CancellationToken.None);
        Inner.Write(buffer.Span);
    }
}
