namespace Transversals.GuestAgent.Host;

public sealed record ScreenBounds(int Left, int Top, int Width, int Height);

public sealed record CapturedImage(int Width, int Height, byte[] Png);

public interface IScreenCapture
{
    ScreenBounds VirtualScreen { get; }

    /// <summary>Captures the virtual screen, downscaled so max(width, height) &lt;= <paramref name="maxLongEdge"/>.</summary>
    CapturedImage Capture(int maxLongEdge);
}
