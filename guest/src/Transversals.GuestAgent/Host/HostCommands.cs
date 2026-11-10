using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Transversals.GuestAgent.Semantics;

namespace Transversals.GuestAgent.Host;

/// <summary>Validates and dispatches host-level protocol commands (hello, exec, screenshot, input, windows).</summary>
internal static class HostCommands
{
    internal const int DefaultExecTimeoutMs = 30_000;
    internal const int MaxExecTimeoutMs = 120_000;
    internal const int MaxScriptLength = 8_192;
    internal const int MaxOutputBytes = 65_536;
    internal const int DefaultMaxLongEdge = 1_568;
    internal const int MinMaxLongEdge = 320;
    internal const int MaxMaxLongEdge = 3_840;
    internal const int MaxTypeTextLength = 16_384;
    internal const int MaxChordKeys = 6;

    public static bool IsHostCommand(string type) =>
        type is "hello" or "exec" or "screenshot" or "input" or "windows";

    public static async Task<object?> ExecuteAsync(
        string type,
        JsonElement command,
        GuestHostPorts ports,
        int resultByteBudget,
        JsonSerializerOptions jsonOptions,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        switch (type)
        {
            case "hello":
                return new
                {
                    agentVersion = ports.Info.AgentVersion,
                    protocolVersion = ports.Info.ProtocolVersion,
                    sessionId = ports.Info.SessionId,
                    interactiveSession = ports.Info.IsInteractiveSession,
                    missingNativeFiles = ports.Info.MissingNativeFiles,
                };

            case "exec":
                return await ExecAsync(command, ports.Process, cancellationToken).ConfigureAwait(false);

            case "screenshot":
                return Screenshot(command, ports.Screen, resultByteBudget, jsonOptions);

            case "input":
                return Input(command, ports.Input, ports.Screen);

            case "windows":
                return Windows(command, ports.Windows);

            default:
                throw new InvalidOperationException($"'{type}' is not a host command.");
        }
    }

    private static async Task<ExecResult> ExecAsync(JsonElement command, IProcessRunner runner, CancellationToken cancellationToken)
    {
        string? script = ReadOptionalString(command, "script");
        if (string.IsNullOrEmpty(script))
            throw new SemanticProtocolException("exec: 'script' must be a non-empty string.");
        if (script.Length > MaxScriptLength)
            throw new SemanticProtocolException($"exec: 'script' must be at most {MaxScriptLength} characters.");

        int timeoutMs = ReadOptionalInt32(command, "timeoutMs", "exec") ?? DefaultExecTimeoutMs;
        if (timeoutMs is < 1 or > MaxExecTimeoutMs)
            throw new SemanticProtocolException($"exec: 'timeoutMs' must be between 1 and {MaxExecTimeoutMs}.");

        ProcessRunResult run = await runner
            .RunPowerShellAsync(new ProcessRunRequest(script, TimeSpan.FromMilliseconds(timeoutMs), MaxOutputBytes), cancellationToken)
            .ConfigureAwait(false);
        return new ExecResult
        {
            ExitCode = run.ExitCode,
            Stdout = run.Stdout,
            Stderr = run.Stderr,
            StdoutTruncated = run.StdoutTruncated,
            StderrTruncated = run.StderrTruncated,
            TimedOut = run.TimedOut,
        };
    }

    private static ScreenshotResult Screenshot(
        JsonElement command,
        IScreenCapture screen,
        int resultByteBudget,
        JsonSerializerOptions jsonOptions)
    {
        int maxLongEdge = ReadOptionalInt32(command, "maxLongEdge", "screenshot") ?? DefaultMaxLongEdge;
        if (maxLongEdge is < MinMaxLongEdge or > MaxMaxLongEdge)
            throw new SemanticProtocolException(
                $"screenshot: 'maxLongEdge' must be between {MinMaxLongEdge} and {MaxMaxLongEdge}.");

        // The source rect lets clients map image pixels back to virtual-screen coordinates.
        ScreenBounds source = screen.VirtualScreen;
        int edge = maxLongEdge;
        while (true)
        {
            CapturedImage image = screen.Capture(edge);
            ScreenshotResult result = new()
            {
                Width = image.Width,
                Height = image.Height,
                Screen = new ScreenRect
                {
                    Left = source.Left,
                    Top = source.Top,
                    Width = source.Width,
                    Height = source.Height,
                },
                Data = Convert.ToBase64String(image.Png),
            };
            int bytes = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(result, jsonOptions));
            if (bytes <= resultByteBudget) return result;
            if (edge <= MinMaxLongEdge)
                throw new SemanticBackendException(
                    $"Screenshot exceeded the {resultByteBudget}-byte result budget even at maxLongEdge {MinMaxLongEdge}.");
            edge = Math.Max(MinMaxLongEdge, edge / 2);
        }
    }

    private static object Input(JsonElement command, IInputSender input, IScreenCapture screen)
    {
        string action = ReadRequiredAction(command, "input");
        switch (action)
        {
            case "type":
            {
                string? text = ReadOptionalString(command, "text");
                if (text is null || text.Length is < 1 or > MaxTypeTextLength)
                    throw new SemanticProtocolException(
                        $"input type: 'text' must be a string of 1 to {MaxTypeTextLength} characters.");
                input.TypeText(text);
                break;
            }

            case "keys":
            {
                string keys = ReadOptionalString(command, "keys")
                    ?? throw new SemanticProtocolException("input keys: 'keys' must be a string such as \"ctrl+s\".");
                string[] chord = keys.Split('+').Select(key => key.Trim().ToLowerInvariant()).ToArray();
                if (chord.Length is < 1 or > MaxChordKeys)
                    throw new SemanticProtocolException($"input keys: a chord must contain 1 to {MaxChordKeys} keys.");
                foreach (string key in chord)
                {
                    if (key.Length == 0 || !input.IsKnownKey(key))
                        throw new SemanticProtocolException($"input keys: unknown key '{key}' in chord '{keys}'.");
                }
                input.SendChord(chord);
                break;
            }

            case "click":
            {
                int x = ReadRequiredInt32(command, "x", "input click");
                int y = ReadRequiredInt32(command, "y", "input click");
                ScreenBounds bounds = screen.VirtualScreen;
                if (x < bounds.Left || x >= bounds.Left + bounds.Width || y < bounds.Top || y >= bounds.Top + bounds.Height)
                    throw new SemanticProtocolException(
                        $"input click: ({x}, {y}) is outside the virtual screen " +
                        $"({bounds.Left}, {bounds.Top}, {bounds.Width}x{bounds.Height}).");

                string button = ReadOptionalString(command, "button")?.ToLowerInvariant() ?? "left";
                MouseButton mouseButton = button switch
                {
                    "left" => MouseButton.Left,
                    "right" => MouseButton.Right,
                    _ => throw new SemanticProtocolException("input click: 'button' must be 'left' or 'right'."),
                };
                bool isDouble = ReadOptionalBoolean(command, "double", "input click") ?? false;
                input.Click(x, y, mouseButton, isDouble);
                break;
            }

            default:
                throw new SemanticProtocolException($"input: unsupported action '{action}'. Expected type, keys, or click.");
        }

        return new { completed = true };
    }

    private static object Windows(JsonElement command, IWindowManager windows)
    {
        string action = ReadRequiredAction(command, "windows");
        switch (action)
        {
            case "list":
                return new
                {
                    windows = windows.List().Select(window => new
                    {
                        handle = window.Handle,
                        title = window.Title,
                        processId = window.ProcessId,
                        processName = window.ProcessName,
                        isForeground = window.IsForeground,
                    }).ToArray(),
                };

            case "focus":
            {
                if (!command.TryGetProperty("handle", out JsonElement value) ||
                    value.ValueKind != JsonValueKind.Number ||
                    !value.TryGetInt64(out long handle))
                    throw new SemanticProtocolException("windows focus: 'handle' must be an integer.");
                if (!windows.Focus(handle))
                    throw new SemanticNotFoundException($"windows focus: no window with handle {handle}.");
                return new { completed = true };
            }

            default:
                throw new SemanticProtocolException($"windows: unsupported action '{action}'. Expected list or focus.");
        }
    }

    private static string ReadRequiredAction(JsonElement command, string commandName)
    {
        string? action = ReadOptionalString(command, "action");
        return string.IsNullOrWhiteSpace(action)
            ? throw new SemanticProtocolException($"{commandName}: 'action' must be a non-empty string.")
            : action.ToLowerInvariant();
    }

    private static string? ReadOptionalString(JsonElement owner, string property)
    {
        if (!owner.TryGetProperty(property, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String)
            throw new SemanticProtocolException($"'{property}' must be a string.");
        return value.GetString();
    }

    private static int? ReadOptionalInt32(JsonElement owner, string property, string commandName)
    {
        if (!owner.TryGetProperty(property, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out int result))
            throw new SemanticProtocolException($"{commandName}: '{property}' must be an integer.");
        return result;
    }

    private static int ReadRequiredInt32(JsonElement owner, string property, string commandName) =>
        ReadOptionalInt32(owner, property, commandName)
        ?? throw new SemanticProtocolException($"{commandName}: '{property}' is required.");

    private static bool? ReadOptionalBoolean(JsonElement owner, string property, string commandName)
    {
        if (!owner.TryGetProperty(property, out JsonElement value) || value.ValueKind == JsonValueKind.Null) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw new SemanticProtocolException($"{commandName}: '{property}' must be a boolean."),
        };
    }

    private sealed class ExecResult
    {
        /// <summary>Always serialized, as explicit null when the process timed out or was killed.</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
        public int? ExitCode { get; init; }

        public string Stdout { get; init; } = string.Empty;
        public string Stderr { get; init; } = string.Empty;
        public bool StdoutTruncated { get; init; }
        public bool StderrTruncated { get; init; }
        public bool TimedOut { get; init; }
    }

    private sealed class ScreenshotResult
    {
        public string MimeType { get; init; } = "image/png";
        public int Width { get; init; }
        public int Height { get; init; }
        public ScreenRect Screen { get; init; } = new();
        public string Data { get; init; } = string.Empty;
    }

    private sealed class ScreenRect
    {
        public int Left { get; init; }
        public int Top { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
    }
}
