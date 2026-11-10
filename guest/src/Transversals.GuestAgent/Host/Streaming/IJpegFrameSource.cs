namespace Transversals.GuestAgent.Host.Streaming;

/// <summary>Captures one JPEG frame of the virtual screen, downscaled so its long edge is at most <c>maxLongEdge</c>.</summary>
internal interface IJpegFrameSource
{
    byte[] Capture(int maxLongEdge, int quality);
}
