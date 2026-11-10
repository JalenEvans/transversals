using System.Diagnostics;

namespace Transversals.GuestAgent.Host.Streaming;

/// <summary>Monotonic clock that paces frame captures.</summary>
internal interface IStreamClock
{
    TimeSpan Elapsed { get; }

    /// <summary>Completes once <see cref="Elapsed"/> reaches <paramref name="due"/>; immediately if it already has.</summary>
    Task DelayUntilAsync(TimeSpan due, CancellationToken ct);
}

/// <summary>Stopwatch-backed <see cref="IStreamClock"/>.</summary>
internal sealed class StopwatchStreamClock : IStreamClock
{
    private readonly Stopwatch _stopwatch = Stopwatch.StartNew();

    public TimeSpan Elapsed => _stopwatch.Elapsed;

    public Task DelayUntilAsync(TimeSpan due, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        TimeSpan remaining = due - Elapsed;
        return remaining > TimeSpan.Zero ? Task.Delay(remaining, ct) : Task.CompletedTask;
    }
}
