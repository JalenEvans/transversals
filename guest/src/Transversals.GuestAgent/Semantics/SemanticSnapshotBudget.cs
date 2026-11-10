using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Transversals.GuestAgent.Semantics;

internal sealed class SemanticSnapshotBudget
{
    private const int MetadataReserveBytes = 256;
    private const int MaxFieldBytes = 4096;
    private const int MaxIdentityBytes = 256;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly int _byteBudget;

    public SemanticSnapshotBudget(int byteBudget)
    {
        if (byteBudget < 512) throw new ArgumentOutOfRangeException(nameof(byteBudget));
        _byteBudget = byteBudget;
    }

    public SemanticNode Apply(SemanticNode source)
    {
        ArgumentNullException.ThrowIfNull(source);

        int totalNodes = CountNodes(source);
        int truncatedFields = 0;
        SemanticNode root = CloneShallow(source, ref truncatedFields);
        List<(SemanticNode Node, SemanticNode Parent)> includedDescendants = [];
        int includedNodes = 1;
        int measuredBytes = Measure(root);
        int contentBudget = _byteBudget - MetadataReserveBytes;

        Stack<(SemanticNode Source, SemanticNode Parent)> pending = new();
        PushChildren(source, root, pending);
        while (pending.Count > 0)
        {
            (SemanticNode candidateSource, SemanticNode parent) = pending.Pop();
            int candidateTruncatedFields = 0;
            SemanticNode candidate = CloneShallow(candidateSource, ref candidateTruncatedFields);
            int addition = Measure(candidate) + (parent.Children.Count == 0 ? 0 : 1);
            if (measuredBytes + addition > contentBudget) continue;

            parent.Children.Add(candidate);
            includedDescendants.Add((candidate, parent));
            includedNodes++;
            truncatedFields += candidateTruncatedFields;
            measuredBytes += addition;
            PushChildren(candidateSource, candidate, pending);
        }

        bool truncated = includedNodes != totalNodes || truncatedFields > 0 || source.Truncation?.Truncated == true;
        if (truncated)
        {
            root.Truncation = Metadata(source, includedNodes, totalNodes, truncatedFields);
        }

        while (Measure(root) > _byteBudget && includedDescendants.Count > 0)
        {
            (SemanticNode removed, SemanticNode parent) = includedDescendants[^1];
            includedDescendants.RemoveAt(includedDescendants.Count - 1);
            parent.Children.Remove(removed);
            int removedNodes = CountNodes(removed);
            includedNodes -= removedNodes;
            root.Truncation = Metadata(source, includedNodes, totalNodes, truncatedFields);
        }

        if (Measure(root) > _byteBudget)
        {
            root.Children.Clear();
            root.Name = null;
            root.AutomationId = null;
            root.ClassName = null;
            root.Value = null;
            root.Text = null;
            root.Capabilities.Clear();
            root.Truncation = Metadata(source, 1, totalNodes, truncatedFields + 1);
        }

        return root;
    }

    private SemanticTruncation Metadata(
        SemanticNode source,
        int includedNodes,
        int totalNodes,
        int truncatedFields)
    {
        List<string> reasons = source.Truncation?.Reasons.Distinct(StringComparer.Ordinal).ToList() ?? [];
        if (includedNodes != totalNodes || truncatedFields > 0) reasons.Add("utf8ByteBudget");
        return new SemanticTruncation
        {
            Reasons = reasons.Distinct(StringComparer.Ordinal).ToList(),
            ByteBudget = _byteBudget,
            IncludedNodes = includedNodes,
            OmittedNodesAtLeast = Math.Max(0, totalNodes - includedNodes) +
                (source.Truncation?.OmittedNodesAtLeast ?? 0),
            TruncatedFields = truncatedFields + (source.Truncation?.TruncatedFields ?? 0),
        };
    }

    private static SemanticNode CloneShallow(SemanticNode source, ref int truncatedFields)
    {
        List<string> capabilities = [];
        foreach (string capability in source.Capabilities.Take(16))
            capabilities.Add(Limit(capability, MaxIdentityBytes, ref truncatedFields) ?? string.Empty);
        if (source.Capabilities.Count > capabilities.Count) truncatedFields++;

        return new SemanticNode
        {
            Id = Limit(source.Id, MaxIdentityBytes, ref truncatedFields) ?? string.Empty,
            Reference = Limit(source.Reference, MaxIdentityBytes, ref truncatedFields),
            Role = Limit(source.Role, MaxIdentityBytes, ref truncatedFields) ?? string.Empty,
            Name = Limit(source.Name, MaxFieldBytes, ref truncatedFields),
            AutomationId = Limit(source.AutomationId, MaxFieldBytes, ref truncatedFields),
            ClassName = Limit(source.ClassName, MaxFieldBytes, ref truncatedFields),
            ProcessId = source.ProcessId,
            WindowHandle = source.WindowHandle,
            IsEnabled = source.IsEnabled,
            IsOffscreen = source.IsOffscreen,
            HasKeyboardFocus = source.HasKeyboardFocus,
            Value = Limit(source.Value, MaxFieldBytes, ref truncatedFields),
            Text = Limit(source.Text, MaxFieldBytes, ref truncatedFields),
            Capabilities = capabilities,
        };
    }

    private static string? Limit(string? value, int byteLimit, ref int truncatedFields)
    {
        if (value is null || Encoding.UTF8.GetByteCount(value) <= byteLimit) return value;
        truncatedFields++;
        StringBuilder result = new(value.Length);
        int bytes = 0;
        foreach (Rune rune in value.EnumerateRunes())
        {
            if (bytes + rune.Utf8SequenceLength > byteLimit) break;
            result.Append(rune.ToString());
            bytes += rune.Utf8SequenceLength;
        }
        return result.ToString();
    }

    private static int CountNodes(SemanticNode root)
    {
        int count = 0;
        Stack<SemanticNode> pending = new();
        pending.Push(root);
        while (pending.Count > 0)
        {
            SemanticNode current = pending.Pop();
            count++;
            foreach (SemanticNode child in current.Children) pending.Push(child);
        }
        return count;
    }

    private static void PushChildren(
        SemanticNode source,
        SemanticNode parent,
        Stack<(SemanticNode Source, SemanticNode Parent)> pending)
    {
        for (int index = source.Children.Count - 1; index >= 0; index--)
            pending.Push((source.Children[index], parent));
    }

    private static int Measure(SemanticNode node) =>
        JsonSerializer.SerializeToUtf8Bytes(node, JsonOptions).Length;
}
