namespace Transversals.GuestAgent.Host.Streaming;

/// <summary>
/// Safety bounds for a stream session: frames larger than <see cref="MaxFrameBytes"/> are skipped, a stdout
/// write that makes no progress for <see cref="WriteStallTimeout"/> ends the session, and so does stdin
/// staying silent for <see cref="HeartbeatTimeout"/> (the host writes a heartbeat byte every second).
/// Both timeouts are real time.
/// </summary>
internal sealed record StreamLimits(int MaxFrameBytes, TimeSpan WriteStallTimeout, TimeSpan HeartbeatTimeout)
{
    public static StreamLimits Default { get; } =
        new(2_097_152, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
}
