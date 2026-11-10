using System.Text.Json;
using Transversals.GuestAgent.Host;
using Transversals.GuestAgent.Semantics;

namespace Transversals.GuestAgent.Tests;

internal sealed class FakeAgentInfo : IAgentInfo
{
    public string AgentVersion { get; set; } = "1.2.3-test";
    public int ProtocolVersion { get; set; } = 2;
    public int SessionId { get; set; } = 7;
    public bool IsInteractiveSession { get; set; } = true;
    public IReadOnlyList<string> MissingNativeFiles { get; set; } = [];
}

internal sealed class FakeProcessRunner : IProcessRunner
{
    public List<ProcessRunRequest> Requests { get; } = [];

    public ProcessRunResult NextResult { get; set; } = new(0, "out", "", false, false, false);

    public Task<ProcessRunResult> RunPowerShellAsync(ProcessRunRequest request, CancellationToken ct)
    {
        Requests.Add(request);
        return Task.FromResult(NextResult);
    }
}

internal sealed class FakeScreenCapture : IScreenCapture
{
    public ScreenBounds VirtualScreen { get; set; } = new(-1920, 0, 3840, 1080);

    public List<int> Requests { get; } = [];

    /// <summary>Produces the image for a requested maxLongEdge. Default: tiny deterministic PNG-ish payload.</summary>
    public Func<int, CapturedImage> Factory { get; set; } =
        maxLongEdge => new CapturedImage(maxLongEdge, maxLongEdge / 2, [0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]);

    public CapturedImage Capture(int maxLongEdge)
    {
        Requests.Add(maxLongEdge);
        return Factory(maxLongEdge);
    }
}

internal sealed class FakeInputSender : IInputSender
{
    public HashSet<string> KnownKeys { get; } =
        ["ctrl", "shift", "alt", "win", "enter", "tab", "esc", "a", "c", "s", "v", "f4"];

    public List<string> TypedTexts { get; } = [];
    public List<IReadOnlyList<string>> Chords { get; } = [];
    public List<(int X, int Y, MouseButton Button, bool IsDouble)> Clicks { get; } = [];

    public int CallCount => TypedTexts.Count + Chords.Count + Clicks.Count;

    public void TypeText(string text) => TypedTexts.Add(text);

    public void SendChord(IReadOnlyList<string> keys) => Chords.Add(keys.ToArray());

    public void Click(int x, int y, MouseButton button, bool isDouble) => Clicks.Add((x, y, button, isDouble));

    public bool IsKnownKey(string key) => KnownKeys.Contains(key);
}

internal sealed class FakeWindowManager : IWindowManager
{
    public List<WindowInfo> Windows { get; } = [];
    public bool FocusResult { get; set; } = true;
    public List<long> FocusRequests { get; } = [];

    public IReadOnlyList<WindowInfo> List() => Windows;

    public bool Focus(long handle)
    {
        FocusRequests.Add(handle);
        return FocusResult;
    }
}

internal sealed class StubSemanticBackend(SemanticNode root) : ISemanticBackend
{
    public List<(string Id, string Kind)> Actions { get; } = [];

    public Task<SemanticNode> SnapshotAsync(CancellationToken cancellationToken) => Task.FromResult(root);

    public Task InteractAsync(string id, SemanticAction action, CancellationToken cancellationToken)
    {
        Actions.Add((id, action.Kind.ToString()));
        return Task.CompletedTask;
    }
}

internal sealed class StubSemanticClock : ISemanticClock
{
    public DateTimeOffset UtcNow { get; private set; } = DateTimeOffset.UnixEpoch;

    public Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken)
    {
        UtcNow += duration;
        return Task.CompletedTask;
    }
}

/// <summary>Builds an NdjsonProtocolHandler wired to fake host ports and a one-button semantic tree.</summary>
internal sealed class HostHarness
{
    private static readonly JsonSerializerOptions NodeOptions = new() { PropertyNameCaseInsensitive = true };

    public FakeAgentInfo Info { get; } = new();
    public FakeProcessRunner Process { get; } = new();
    public FakeScreenCapture Screen { get; } = new();
    public FakeInputSender Input { get; } = new();
    public FakeWindowManager Windows { get; } = new();
    public StubSemanticBackend Backend { get; }
    public NdjsonProtocolHandler Handler { get; }

    public HostHarness(int? responseByteBudget = null, bool withPorts = true)
    {
        Backend = new StubSemanticBackend(CreateRoot());
        SemanticSession session = new(Backend, new StubSemanticClock());
        GuestHostPorts ports = new(Info, Process, Screen, Input, Windows);
        Handler = (withPorts, responseByteBudget) switch
        {
            (true, int budget) => new NdjsonProtocolHandler(session, ports, budget),
            (true, null) => new NdjsonProtocolHandler(session, ports),
            (false, int budget) => new NdjsonProtocolHandler(session, budget),
            (false, null) => new NdjsonProtocolHandler(session),
        };
    }

    public async Task<JsonDocument> SendAsync(string requestJson) =>
        JsonDocument.Parse(await Handler.HandleLineAsync(requestJson, CancellationToken.None));

    public async Task<string> SendRawAsync(string requestJson) =>
        await Handler.HandleLineAsync(requestJson, CancellationToken.None);

    public Task<JsonDocument> SendCommandsAsync(params object[] commands) =>
        SendAsync(JsonSerializer.Serialize(new { id = "host-request", commands }));

    private static SemanticNode CreateRoot() =>
        JsonSerializer.Deserialize<SemanticNode>(
            """
            {
              "id":"root",
              "role":"Window",
              "children":[{
                "id":"stop",
                "role":"Button",
                "name":"Stop",
                "automationId":"stop",
                "capabilities":["Invoke","Focus"]
              }]
            }
            """,
            NodeOptions)!;
}

internal static class HostResponse
{
    public static JsonElement SingleOkResult(JsonDocument response)
    {
        JsonElement root = response.RootElement;
        Assert.True(
            root.GetProperty("status").GetString() == "ok",
            $"Expected ok response but got: {root.GetRawText()}");
        JsonElement results = root.GetProperty("results");
        Assert.Equal(1, results.GetArrayLength());
        return results[0];
    }

    public static void AssertError(JsonDocument response, int commandIndex, string code)
    {
        JsonElement root = response.RootElement;
        Assert.True(
            root.GetProperty("status").GetString() == "error",
            $"Expected error response but got: {root.GetRawText()}");
        JsonElement error = root.GetProperty("error");
        Assert.True(
            error.GetProperty("code").GetString() == code && error.GetProperty("commandIndex").GetInt32() == commandIndex,
            $"Expected {code} at commandIndex {commandIndex} but got: {error.GetRawText()}");
    }

    /// <summary>
    /// A validation rejection must come from the handler recognizing the host command,
    /// not from the generic unknown-command fallback.
    /// </summary>
    public static void AssertValidationRejection(JsonDocument response, int commandIndex = 0)
    {
        AssertError(response, commandIndex, "INVALID_REQUEST");
        string message = response.RootElement.GetProperty("error").GetProperty("message").GetString()!;
        Assert.False(
            message.StartsWith("Unknown command type", StringComparison.Ordinal),
            $"Rejection came from the unknown-command fallback, not host-command validation: {message}");
    }

    public static void AssertCompleted(JsonDocument response) =>
        Assert.True(SingleOkResult(response).GetProperty("completed").GetBoolean());
}
