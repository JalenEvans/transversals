using System.Globalization;

namespace Transversals.GuestAgent.Host.Streaming;

/// <summary>Validated <c>stream</c> flags: frames per second, downscale bound, and JPEG quality.</summary>
internal sealed record StreamOptions(int Fps, int MaxLongEdge, int Quality)
{
    public const int DefaultFps = 15;
    public const int DefaultMaxLongEdge = 800;
    public const int DefaultQuality = 70;

    private sealed record Flag(string Name, int Min, int Max);

    private static readonly Flag FpsFlag = new("--fps", 1, 30);
    private static readonly Flag MaxLongEdgeFlag = new("--max-long-edge", 320, 1_920);
    private static readonly Flag QualityFlag = new("--quality", 30, 95);
    private static readonly Flag[] Flags = [FpsFlag, MaxLongEdgeFlag, QualityFlag];

    /// <summary>
    /// Parses the arguments after <c>stream</c>. On failure <paramref name="options"/> is null and
    /// <paramref name="error"/> names the offending token.
    /// </summary>
    public static bool TryParse(string[] args, out StreamOptions? options, out string? error)
    {
        options = null;
        Dictionary<Flag, int> values = [];

        for (int index = 0; index < args.Length; index++)
        {
            string token = args[index];
            Flag? flag = Array.Find(Flags, candidate => candidate.Name == token);
            if (flag is null)
            {
                error = token.StartsWith('-')
                    ? $"stream: unknown option \"{token}\". Expected --fps, --max-long-edge, or --quality."
                    : $"stream: unexpected argument \"{token}\".";
                return false;
            }
            if (values.ContainsKey(flag))
            {
                error = $"stream: {flag.Name} was given more than once.";
                return false;
            }
            if (index + 1 >= args.Length)
            {
                error = $"stream: {flag.Name} requires a value.";
                return false;
            }

            string raw = args[++index];
            // Digits only: rejects signs, decimals, whitespace, and a following flag taken as the value.
            if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out int value) ||
                value < flag.Min || value > flag.Max)
            {
                error = $"stream: {flag.Name} must be an integer from {flag.Min} to {flag.Max}, got \"{raw}\".";
                return false;
            }
            values[flag] = value;
        }

        options = new StreamOptions(
            values.GetValueOrDefault(FpsFlag, DefaultFps),
            values.GetValueOrDefault(MaxLongEdgeFlag, DefaultMaxLongEdge),
            values.GetValueOrDefault(QualityFlag, DefaultQuality));
        error = null;
        return true;
    }
}
