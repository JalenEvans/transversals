namespace Transversals.GuestAgent.Tests;

public sealed class SemanticSessionTests
{
    public static TheoryData<string, string?> SupportedActions => new()
    {
        { "Invoke", null },
        { "Value", "new value" },
        { "Focus", null },
        { "Toggle", null },
        { "Select", "COM7" },
        { "Expand", null },
        { "Collapse", null },
    };

    [Fact]
    public async Task Snapshot_and_find_return_opaque_session_references()
    {
        BackendProxy backend = BackendWith(Node("control", "Button", "Stop", "Invoke"));
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        object session = SemanticContract.Create("SemanticSession", backend, clock);

        object snapshot = (await SemanticContract.CallAsync(
            session,
            "SnapshotAsync",
            CancellationToken.None))!;
        object found = (await SemanticContract.CallAsync(
            session,
            "FindAsync",
            Locator("""{ "role":"Button", "name":"Stop" }"""),
            CancellationToken.None))!;

        string snapshotRef = SemanticContract.StringProperty(snapshot, "Reference");
        string foundRef = SemanticContract.StringProperty(found, "Reference");
        Assert.NotEmpty(snapshotRef);
        Assert.NotEmpty(foundRef);
        Assert.NotEqual("root", snapshotRef);
        Assert.NotEqual("control", foundRef);
    }

    [Theory]
    [MemberData(nameof(SupportedActions))]
    public async Task Interact_dispatches_each_supported_capability(string kind, string? value)
    {
        string advertisedCapability = kind == "Collapse" ? "Expand" : kind;
        BackendProxy backend = BackendWith(Node("control", "Control", "Target", advertisedCapability));
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        object session = SemanticContract.Create("SemanticSession", backend, clock);
        object found = (await SemanticContract.CallAsync(
            session,
            "FindAsync",
            Locator("""{ "name":"Target" }"""),
            CancellationToken.None))!;

        await SemanticContract.CallAsync(
            session,
            "InteractAsync",
            SemanticContract.StringProperty(found, "Reference"),
            Action(kind, value),
            CancellationToken.None);

        Assert.Collection(backend.Actions, dispatched =>
        {
            Assert.Equal("control", dispatched.Id);
            Assert.Equal(kind, dispatched.Kind);
            Assert.Equal(value, dispatched.Value);
        });
    }

    [Fact]
    public async Task Interact_rejects_missing_capability_without_dispatching()
    {
        BackendProxy backend = BackendWith(Node("control", "Button", "Stop"));
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        object session = SemanticContract.Create("SemanticSession", backend, clock);
        object found = (await SemanticContract.CallAsync(
            session,
            "FindAsync",
            Locator("""{ "name":"Stop" }"""),
            CancellationToken.None))!;

        Exception error = await SemanticContract.CaptureAsync(async () =>
            await SemanticContract.CallAsync(
                session,
                "InteractAsync",
                SemanticContract.StringProperty(found, "Reference"),
                Action("Invoke"),
                CancellationToken.None));

        SemanticContract.AssertTyped(error, "SemanticCapabilityException", "CAPABILITY_UNAVAILABLE");
        Assert.Empty(backend.Actions);
    }

    [Fact]
    public async Task Interact_rejects_a_reference_from_an_older_snapshot()
    {
        BackendProxy backend = BackendWith(Node("control", "Button", "Stop", "Invoke"));
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        object session = SemanticContract.Create("SemanticSession", backend, clock);
        object found = (await SemanticContract.CallAsync(
            session,
            "FindAsync",
            Locator("""{ "name":"Stop" }"""),
            CancellationToken.None))!;
        await SemanticContract.CallAsync(session, "SnapshotAsync", CancellationToken.None);

        Exception error = await SemanticContract.CaptureAsync(async () =>
            await SemanticContract.CallAsync(
                session,
                "InteractAsync",
                SemanticContract.StringProperty(found, "Reference"),
                Action("Invoke"),
                CancellationToken.None));

        SemanticContract.AssertTyped(error, "SemanticStaleReferenceException", "STALE_REFERENCE");
        Assert.Empty(backend.Actions);
    }

    [Fact]
    public async Task Wait_succeeds_after_change_and_times_out_at_the_injected_clock_deadline()
    {
        BackendProxy backend = BackendWith(Node("status", "Text", "Starting"));
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        clock.AfterDelay = count =>
        {
            if (count == 2)
            {
                backend.Root = Root(Node("status", "Text", "Connected"));
            }
        };
        object session = SemanticContract.Create("SemanticSession", backend, clock);

        object result = (await SemanticContract.CallAsync(
            session,
            "WaitForAsync",
            Locator("""{ "role":"Text" }"""),
            Assertion("Name", "Connected"),
            TimeSpan.FromSeconds(5),
            TimeSpan.FromSeconds(1),
            CancellationToken.None))!;

        Assert.Equal("Connected", SemanticContract.StringProperty(result, "Name"));
        Assert.Equal(2, clock.DelayCount);

        Exception timeout = await SemanticContract.CaptureAsync(async () =>
            await SemanticContract.CallAsync(
                session,
                "WaitForAsync",
                Locator("""{ "role":"Text" }"""),
                Assertion("Name", "Never"),
                TimeSpan.FromSeconds(3),
                TimeSpan.FromSeconds(1),
                CancellationToken.None));

        SemanticContract.AssertTyped(timeout, "SemanticTimeoutException", "ASSERTION_TIMEOUT");
        Assert.Equal(DateTimeOffset.UnixEpoch.AddSeconds(5), clock.Now);
    }

    private static BackendProxy BackendWith(object child)
    {
        BackendProxy backend = SemanticContract.CreateProxy<BackendProxy>("ISemanticBackend");
        backend.Root = Root(child);
        return backend;
    }

    private static object Root(object child)
    {
        string childJson = System.Text.Json.JsonSerializer.Serialize(child, child.GetType());
        return SemanticContract.FromJson(
            "SemanticNode",
            $$"""{ "id":"root", "role":"Window", "children":[{{childJson}}] }""");
    }

    private static object Node(string id, string role, string name, params string[] capabilities) =>
        SemanticContract.FromJson(
            "SemanticNode",
            System.Text.Json.JsonSerializer.Serialize(new { id, role, name, capabilities }));

    private static object Locator(string json) => SemanticContract.FromJson("SemanticLocator", json);

    private static object Action(string kind, string? value = null) => SemanticContract.FromJson(
        "SemanticAction",
        System.Text.Json.JsonSerializer.Serialize(new { kind, value }));

    private static object Assertion(string property, string equals) => SemanticContract.FromJson(
        "SemanticAssertion",
        System.Text.Json.JsonSerializer.Serialize(new { property, equals }));
}
