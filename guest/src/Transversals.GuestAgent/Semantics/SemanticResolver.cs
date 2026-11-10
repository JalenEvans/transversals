namespace Transversals.GuestAgent.Semantics;

public sealed class SemanticResolver
{
    public SemanticNode Resolve(SemanticNode root, SemanticLocator locator)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(locator);

        List<Entry> entries = Flatten(root).ToList();
        IEnumerable<Entry>? matches = null;

        if (!string.IsNullOrWhiteSpace(locator.AutomationId))
        {
            matches = entries.Where(entry => Same(entry.Node.AutomationId, locator.AutomationId));
            SemanticNode? result = SelectIfAny(matches, locator.Index);
            if (result is not null) return result;
        }

        if (!string.IsNullOrWhiteSpace(locator.Name))
        {
            matches = entries.Where(entry =>
                RoleMatches(entry.Node, locator.Role) && Same(entry.Node.Name, locator.Name));
            SemanticNode? result = SelectIfAny(matches, locator.Index);
            if (result is not null) return result;
        }

        if (!string.IsNullOrWhiteSpace(locator.Text) || !string.IsNullOrWhiteSpace(locator.Value))
        {
            matches = entries.Where(entry =>
                RoleMatches(entry.Node, locator.Role) &&
                (string.IsNullOrWhiteSpace(locator.Text) || Same(VisibleText(entry.Node), locator.Text)) &&
                (string.IsNullOrWhiteSpace(locator.Value) || Same(entry.Node.Value, locator.Value)));
            SemanticNode? result = SelectIfAny(matches, locator.Index);
            if (result is not null) return result;
        }

        if (locator.Ancestor is not null || locator.Descendant is not null || locator.Sibling is not null)
        {
            matches = entries.Where(entry =>
                DirectMatches(entry.Node, locator) &&
                (locator.Ancestor is null || entry.Ancestors.Any(node => ContextMatches(node, locator.Ancestor))) &&
                (locator.Descendant is null || Descendants(entry.Node).Any(node => ContextMatches(node, locator.Descendant))) &&
                (locator.Sibling is null || entry.Parent is not null && entry.Parent.Children.Any(node =>
                    !ReferenceEquals(node, entry.Node) && ContextMatches(node, locator.Sibling))));
            SemanticNode? result = SelectIfAny(matches, locator.Index);
            if (result is not null) return result;
        }

        if (locator.Fuzzy)
        {
            matches = entries.Where(entry =>
                RoleMatches(entry.Node, locator.Role) &&
                FuzzyField(entry.Node.Name, locator.Name) &&
                FuzzyField(VisibleText(entry.Node), locator.Text) &&
                FuzzyField(entry.Node.Value, locator.Value));
            SemanticNode? result = SelectIfAny(matches, locator.Index);
            if (result is not null) return result;
        }

        if (!HasValueCriteria(locator))
        {
            matches = entries.Where(entry => RoleMatches(entry.Node, locator.Role));
            SemanticNode? result = SelectIfAny(matches, locator.Index);
            if (result is not null) return result;
        }

        throw new SemanticNotFoundException();
    }

    private static SemanticNode? SelectIfAny(IEnumerable<Entry> source, int? index)
    {
        List<SemanticNode> nodes = source.Select(entry => entry.Node).ToList();
        if (nodes.Count == 0) return null;

        if (index is int selected)
        {
            if (selected < 0 || selected >= nodes.Count)
            {
                throw new SemanticNotFoundException($"Semantic match index {selected} is outside the {nodes.Count} matches.");
            }

            return nodes[selected];
        }

        return nodes.Count == 1
            ? nodes[0]
            : throw new SemanticAmbiguousException(
                nodes.Take(SemanticLimits.AmbiguousCandidateSummaries).Select(CandidateSummary).ToList(),
                $"The semantic locator matched {nodes.Count} elements; supply an explicit index.");
    }

    private static SemanticCandidateSummary CandidateSummary(SemanticNode node) => new(
        node.Reference,
        node.Role,
        node.Name,
        node.Text,
        node.AutomationId);

    private static bool DirectMatches(SemanticNode node, SemanticLocator locator) =>
        RoleMatches(node, locator.Role) &&
        (string.IsNullOrWhiteSpace(locator.AutomationId) || Same(node.AutomationId, locator.AutomationId)) &&
        (string.IsNullOrWhiteSpace(locator.Name) || Same(node.Name, locator.Name)) &&
        (string.IsNullOrWhiteSpace(locator.Text) || Same(VisibleText(node), locator.Text)) &&
        (string.IsNullOrWhiteSpace(locator.Value) || Same(node.Value, locator.Value));

    private static bool ContextMatches(SemanticNode node, SemanticLocator locator)
    {
        bool direct = locator.Fuzzy
            ? RoleMatches(node, locator.Role) &&
              FuzzyField(node.Name, locator.Name) &&
              FuzzyField(VisibleText(node), locator.Text) &&
              FuzzyField(node.Value, locator.Value)
            : DirectMatches(node, locator);

        return direct &&
            (locator.Descendant is null || Descendants(node).Any(child => ContextMatches(child, locator.Descendant)));
    }

    private static bool HasValueCriteria(SemanticLocator locator) =>
        !string.IsNullOrWhiteSpace(locator.AutomationId) ||
        !string.IsNullOrWhiteSpace(locator.Name) ||
        !string.IsNullOrWhiteSpace(locator.Text) ||
        !string.IsNullOrWhiteSpace(locator.Value) ||
        locator.Ancestor is not null || locator.Descendant is not null || locator.Sibling is not null;

    private static bool RoleMatches(SemanticNode node, string? role) =>
        string.IsNullOrWhiteSpace(role) || Same(node.Role, role);

    private static bool Same(string? left, string? right) =>
        string.Equals(left?.Trim(), right?.Trim(), StringComparison.OrdinalIgnoreCase);

    private static string? VisibleText(SemanticNode node) =>
        !string.IsNullOrWhiteSpace(node.Text)
            ? node.Text
            : Same(node.Role, "Text") ? node.Name : node.Text;

    private static bool FuzzyField(string? actual, string? requested)
    {
        if (string.IsNullOrWhiteSpace(requested)) return true;
        if (string.IsNullOrWhiteSpace(actual)) return false;

        string[] actualWords = Words(actual);
        string[] requestedWords = Words(requested);
        int position = 0;
        foreach (string requestedWord in requestedWords)
        {
            while (position < actualWords.Length &&
                   !actualWords[position].Contains(requestedWord, StringComparison.OrdinalIgnoreCase) &&
                   !requestedWord.Contains(actualWords[position], StringComparison.OrdinalIgnoreCase))
            {
                position++;
            }

            if (position == actualWords.Length) return false;
            position++;
        }

        return true;
    }

    private static string[] Words(string value) => value
        .Split([' ', '\t', '\r', '\n', '-', '_'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static IEnumerable<SemanticNode> Descendants(SemanticNode node)
    {
        foreach (SemanticNode child in node.Children)
        {
            yield return child;
            foreach (SemanticNode descendant in Descendants(child)) yield return descendant;
        }
    }

    private static IEnumerable<Entry> Flatten(SemanticNode root)
    {
        Stack<(SemanticNode Node, SemanticNode? Parent, IReadOnlyList<SemanticNode> Ancestors)> stack = new();
        stack.Push((root, null, Array.Empty<SemanticNode>()));
        while (stack.Count > 0)
        {
            (SemanticNode node, SemanticNode? parent, IReadOnlyList<SemanticNode> ancestors) = stack.Pop();
            yield return new Entry(node, parent, ancestors);

            SemanticNode[] nextAncestors = [.. ancestors, node];
            for (int index = node.Children.Count - 1; index >= 0; index--)
            {
                stack.Push((node.Children[index], node, nextAncestors));
            }
        }
    }

    private sealed record Entry(SemanticNode Node, SemanticNode? Parent, IReadOnlyList<SemanticNode> Ancestors);
}
