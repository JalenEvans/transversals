namespace Transversals.GuestAgent.Tests;

public sealed class SemanticLocatorTests
{
    public static TheoryData<string, string, string> FallbackCases => new()
    {
        {
            Tree("""
              { "id":"id-wins", "role":"Button", "name":"Other", "automationId":"stop" },
              { "id":"name-would-match", "role":"Button", "name":"Stop" }
            """),
            """{ "automationId":"stop", "role":"Button", "name":"Stop" }""",
            "id-wins"
        },
        {
            Tree("""{ "id":"exact", "role":"Button", "name":"Stop" }"""),
            """{ "automationId":"missing", "role":"Button", "name":"Stop" }""",
            "exact"
        },
        {
            Tree("""{ "id":"text", "role":"Text", "text":"Connected" }"""),
            """{ "text":"Connected" }""",
            "text"
        },
        {
            Tree("""{ "id":"value", "role":"Edit", "value":"COM7" }"""),
            """{ "value":"COM7" }""",
            "value"
        },
        {
            Tree("""
              { "id":"device", "role":"Card", "text":"Example Device", "children":[
                { "id":"stop-button", "role":"Button", "children":[
                  { "id":"stop-label", "role":"Text", "text":"Stop" }
                ]}
              ]}
            """),
            """
            {
              "role":"Button",
              "ancestor":{"text":"Example Device"},
              "descendant":{"text":"Stop"}
            }
            """,
            "stop-button"
        },
        {
            Tree("""
              { "id":"row", "role":"Group", "children":[
                { "id":"device-label", "role":"Text", "text":"Example Device" },
                { "id":"sibling-button", "role":"Button" }
              ]}
            """),
            """{ "role":"Button", "sibling":{"text":"Example Device"} }""",
            "sibling-button"
        },
        {
            Tree("""{ "id":"fuzzy", "role":"Button", "name":"Stop device capture" }"""),
            """{ "name":"Stop capture", "fuzzy":true }""",
            "fuzzy"
        },
        {
            Tree("""{ "id":"fuzzy-text", "role":"Text", "text":"Device connected successfully" }"""),
            """{ "text":"Device connected", "fuzzy":true }""",
            "fuzzy-text"
        },
    };

    [Theory]
    [MemberData(nameof(FallbackCases))]
    public void Resolve_uses_the_ordered_semantic_fallbacks(
        string treeJson,
        string locatorJson,
        string expectedId)
    {
        object resolver = SemanticContract.Create("SemanticResolver");
        object result = SemanticContract.Call(
            resolver,
            "Resolve",
            SemanticContract.FromJson("SemanticNode", treeJson),
            SemanticContract.FromJson("SemanticLocator", locatorJson));

        Assert.Equal(expectedId, SemanticContract.StringProperty(result, "Id"));
    }

    [Fact]
    public void Resolve_rejects_ties_unless_an_explicit_index_selects_one()
    {
        object resolver = SemanticContract.Create("SemanticResolver");
        object tree = SemanticContract.FromJson("SemanticNode", Tree("""
          { "id":"first", "role":"Button", "name":"Stop" },
          { "id":"second", "role":"Button", "name":"Stop" }
        """));
        object tied = SemanticContract.FromJson("SemanticLocator", """{ "role":"Button", "name":"Stop" }""");

        Exception error = Assert.ThrowsAny<Exception>(() =>
            SemanticContract.Call(resolver, "Resolve", tree, tied));
        SemanticContract.AssertTyped(error, "SemanticAmbiguousException", "AMBIGUOUS_MATCH");

        object indexed = SemanticContract.FromJson(
            "SemanticLocator",
            """{ "role":"Button", "name":"Stop", "index":1 }""");
        object result = SemanticContract.Call(resolver, "Resolve", tree, indexed);
        Assert.Equal("second", SemanticContract.StringProperty(result, "Id"));
    }

    [Theory]
    [InlineData(
        """
        { "id":"root", "role":"Window", "children":[
          { "id":"sign-in-label", "role":"Text", "name":"Sign In with Example", "text":"" }
        ]}
        """,
        """{ "text":"Sign In with Example" }""",
        "sign-in-label")]
    [InlineData(
        """
        { "id":"root", "role":"Window", "children":[
          { "id":"other-button", "role":"Button", "children":[
            { "id":"other-label", "role":"Text", "name":"Cancel", "text":"" }
          ]},
          { "id":"sign-in-button", "role":"Button", "children":[
            { "id":"sign-in-label", "role":"Text", "name":"Sign In with Example", "text":"" }
          ]}
        ]}
        """,
        """{ "role":"Button", "descendant":{ "text":"Sign In with Example" } }""",
        "sign-in-button")]
    public void Resolve_treats_a_text_nodes_accessible_name_as_visible_text(
        string treeJson,
        string locatorJson,
        string expectedId)
    {
        object resolver = SemanticContract.Create("SemanticResolver");

        object result = SemanticContract.Call(
            resolver,
            "Resolve",
            SemanticContract.FromJson("SemanticNode", treeJson),
            SemanticContract.FromJson("SemanticLocator", locatorJson));

        Assert.Equal(expectedId, SemanticContract.StringProperty(result, "Id"));
    }

    [Fact]
    public void Resolve_fails_semantically_without_implicit_visual_fallback()
    {
        object resolver = SemanticContract.Create("SemanticResolver");
        object tree = SemanticContract.FromJson(
            "SemanticNode",
            Tree("""{ "id":"only", "role":"Button", "name":"Start" }"""));
        object locator = SemanticContract.FromJson(
            "SemanticLocator",
            """{ "role":"Button", "name":"Stop" }""");

        Exception error = Assert.ThrowsAny<Exception>(() =>
            SemanticContract.Call(resolver, "Resolve", tree, locator));

        SemanticContract.AssertTyped(error, "SemanticNotFoundException", "NOT_FOUND");
    }

    private static string Tree(string children) => $$"""
    {
      "id":"root",
      "role":"Window",
      "children":[{{children}}]
    }
    """;
}
