using System.Text;
using System.Text.Json;

namespace Transversals.GuestAgent.Tests;

public sealed class NdjsonProtocolTests
{
    [Fact]
    public async Task Batch_correlates_id_and_orders_snapshot_find_and_interact()
    {
        (object handler, BackendProxy backend) = CreateHandler();

        string response = (string)(await SemanticContract.CallAsync(
            handler,
            "HandleLineAsync",
            """
            {"id":"request-17","commands":[
              {"type":"snapshot"},
              {"type":"find","locator":{"automationId":"stop"}},
              {"type":"interact","ref":"$last","action":{"kind":"Invoke"}}
            ]}
            """,
            CancellationToken.None))!;

        using JsonDocument parsed = JsonDocument.Parse(response);
        Assert.Equal("request-17", parsed.RootElement.GetProperty("id").GetString());
        Assert.Equal("ok", parsed.RootElement.GetProperty("status").GetString());
        Assert.Equal(3, parsed.RootElement.GetProperty("results").GetArrayLength());
        Assert.Collection(backend.Actions, action =>
        {
            Assert.Equal("stop", action.Id);
            Assert.Equal("Invoke", action.Kind);
        });
    }

    [Fact]
    public async Task Batch_fails_fast_on_first_action_error_with_a_typed_response()
    {
        (object handler, BackendProxy backend) = CreateHandler();
        backend.NextActionError = new InvalidOperationException("device rejected invoke");

        string response = (string)(await SemanticContract.CallAsync(
            handler,
            "HandleLineAsync",
            """
            {"id":"request-18","commands":[
              {"type":"find","locator":{"automationId":"stop"}},
              {"type":"interact","ref":"$last","action":{"kind":"Invoke"}},
              {"type":"interact","ref":"$last","action":{"kind":"Focus"}}
            ]}
            """,
            CancellationToken.None))!;

        using JsonDocument parsed = JsonDocument.Parse(response);
        JsonElement root = parsed.RootElement;
        Assert.Equal("request-18", root.GetProperty("id").GetString());
        Assert.Equal("error", root.GetProperty("status").GetString());
        Assert.Equal(1, root.GetProperty("error").GetProperty("commandIndex").GetInt32());
        Assert.False(string.IsNullOrWhiteSpace(root.GetProperty("error").GetProperty("code").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(root.GetProperty("error").GetProperty("message").GetString()));
        Assert.Empty(backend.Actions);
    }

    [Fact]
    public async Task Ambiguous_match_returns_bounded_deterministic_candidate_summaries()
    {
        var candidates = Enumerable.Range(0, 12).Select(index => new
        {
            id = $"backend-{index:00}",
            role = "Button",
            name = "Stop",
            text = $"Visible stop {index:00}",
            automationId = $"stop-{index:00}",
            children = new[]
            {
                new { id = $"private-child-{index:00}", role = "Text", name = $"Private subtree {index:00}" },
            },
        }).ToArray();
        object root = SemanticContract.FromJson(
            "SemanticNode",
            JsonSerializer.Serialize(new { id = "root", role = "Window", children = candidates }));
        BackendProxy backend = SemanticContract.CreateProxy<BackendProxy>("ISemanticBackend");
        backend.Root = root;
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        object session = SemanticContract.Create("SemanticSession", backend, clock);
        object handler = SemanticContract.Create("NdjsonProtocolHandler", session);

        string response = (string)(await SemanticContract.CallAsync(
            handler,
            "HandleLineAsync",
            """
            {"id":"ambiguous-request","commands":[
              {"type":"find","locator":{"role":"Button","name":"Stop"}}
            ]}
            """,
            CancellationToken.None))!;

        using JsonDocument parsed = JsonDocument.Parse(response);
        JsonElement error = parsed.RootElement.GetProperty("error");
        Assert.Equal("AMBIGUOUS_MATCH", error.GetProperty("code").GetString());
        Assert.True(
            error.TryGetProperty("details", out JsonElement details),
            "AMBIGUOUS_MATCH must include structured details.");
        JsonElement[] summaries = details.GetProperty("candidates").EnumerateArray().ToArray();
        Assert.InRange(summaries.Length, 1, 10);

        for (int index = 0; index < summaries.Length; index++)
        {
            JsonElement summary = summaries[index];
            string reference = summary.GetProperty("reference").GetString()!;
            Assert.False(string.IsNullOrWhiteSpace(reference));
            Assert.NotEqual($"backend-{index:00}", reference);
            Assert.Equal("Button", summary.GetProperty("role").GetString());
            Assert.Equal("Stop", summary.GetProperty("name").GetString());
            Assert.Equal($"Visible stop {index:00}", summary.GetProperty("text").GetString());
            Assert.Equal($"stop-{index:00}", summary.GetProperty("automationId").GetString());
            Assert.False(summary.TryGetProperty("children", out _));
            Assert.False(summary.TryGetProperty("image", out _));
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Unknown_assertion_property_returns_invalid_request(bool exists)
    {
        (object handler, _) = CreateHandler();
        string request = JsonSerializer.Serialize(new
        {
            id = "unknown-assertion",
            commands = new[]
            {
                new
                {
                    type = "assert",
                    locator = new { automationId = "stop" },
                    assertion = new { property = "unknownProperty", exists },
                },
            },
        });

        string response = (string)(await SemanticContract.CallAsync(
            handler,
            "HandleLineAsync",
            request,
            CancellationToken.None))!;

        using JsonDocument parsed = JsonDocument.Parse(response);
        JsonElement root = parsed.RootElement;
        Assert.Equal("error", root.GetProperty("status").GetString());
        Assert.Equal("INVALID_REQUEST", root.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, root.GetProperty("error").GetProperty("commandIndex").GetInt32());
    }

    [Fact]
    public async Task Oversized_snapshot_is_valid_and_reports_credible_truncation_with_an_injected_budget()
    {
        const int responseByteBudget = 64 * 1024;
        const int totalNodes = 25;
        string oversizedText = string.Concat(Enumerable.Repeat("é", 4_000));
        var children = Enumerable.Range(1, totalNodes - 1)
            .Select(index => new
            {
                id = $"child-{index:00}",
                role = "Text",
                text = oversizedText,
            })
            .ToArray();
        string sourceJson = JsonSerializer.Serialize(new
        {
            id = "root",
            role = "Window",
            text = oversizedText,
            children,
        });
        Assert.True(Encoding.UTF8.GetByteCount(sourceJson) > responseByteBudget);

        BackendProxy backend = SemanticContract.CreateProxy<BackendProxy>("ISemanticBackend");
        backend.Root = SemanticContract.FromJson("SemanticNode", sourceJson);
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        object session = SemanticContract.Create("SemanticSession", backend, clock);
        object handler = SemanticContract.Create("NdjsonProtocolHandler", session, responseByteBudget);

        string response = (string)(await SemanticContract.CallAsync(
            handler,
            "HandleLineAsync",
            """{"id":"budgeted-snapshot","commands":[{"type":"snapshot"}]}""",
            CancellationToken.None))!;

        Assert.True(Encoding.UTF8.GetByteCount(response) < responseByteBudget);
        using JsonDocument parsed = JsonDocument.Parse(response);
        JsonElement root = parsed.RootElement;
        Assert.Equal("ok", root.GetProperty("status").GetString());
        JsonElement tree = root.GetProperty("results")[0];
        JsonElement truncation = tree.GetProperty("truncation");
        Assert.True(truncation.GetProperty("truncated").GetBoolean());
        Assert.Contains(
            "utf8ByteBudget",
            truncation.GetProperty("reasons").EnumerateArray().Select(reason => reason.GetString()));

        int includedNodes = truncation.GetProperty("includedNodes").GetInt32();
        int omittedNodes = truncation.GetProperty("omittedNodesAtLeast").GetInt32();
        int truncatedFields = truncation.GetProperty("truncatedFields").GetInt32();
        Assert.Equal(includedNodes, CountNodes(tree));
        Assert.InRange(includedNodes, 1, totalNodes - 1);
        Assert.True(omittedNodes >= totalNodes - includedNodes);
        Assert.InRange(truncatedFields, 1, includedNodes);
        Assert.InRange(truncation.GetProperty("byteBudget").GetInt32(), 512, responseByteBudget - 1);
    }

    private static (object Handler, BackendProxy Backend) CreateHandler()
    {
        object node = SemanticContract.FromJson(
            "SemanticNode",
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
            """);
        BackendProxy backend = SemanticContract.CreateProxy<BackendProxy>("ISemanticBackend");
        backend.Root = node;
        ClockProxy clock = SemanticContract.CreateProxy<ClockProxy>("ISemanticClock");
        object session = SemanticContract.Create("SemanticSession", backend, clock);
        object handler = SemanticContract.Create("NdjsonProtocolHandler", session);
        return (handler, backend);
    }

    private static int CountNodes(JsonElement node) =>
        1 + node.GetProperty("children").EnumerateArray().Sum(CountNodes);
}
