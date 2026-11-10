using System.Windows.Automation;

namespace Transversals.GuestAgent.Semantics;

public sealed class WindowsUiaBackend : IScopedSemanticBackend
{
    private const int SelectionTraversalLimit = 1000;
    private readonly Dictionary<string, AutomationElement> _elements = new(StringComparer.Ordinal);
    private long _generation;
    private int _sequence;

    public Task<SemanticNode> SnapshotAsync(CancellationToken cancellationToken) =>
        SnapshotAsync(new SemanticScope(), cancellationToken);

    public Task<SemanticNode> SnapshotAsync(SemanticScope scope, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scope);
        if (scope.MaxDepth is < 0 or > 64) throw new ArgumentOutOfRangeException(nameof(scope.MaxDepth));
        if (scope.MaxNodes is <= 0 or > 10_000) throw new ArgumentOutOfRangeException(nameof(scope.MaxNodes));

        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            _generation++;
            _sequence = 0;
            _elements.Clear();

            AutomationElement desktop = AutomationElement.RootElement;
            int remaining = scope.MaxNodes;
            HashSet<string> truncationReasons = new(StringComparer.Ordinal);
            int omittedNodes = 0;
            SemanticNode root = CreateNode(desktop);
            root.Role = "Desktop";
            remaining--;
            bool requiresWindowMatch = scope.ProcessId is not null ||
                                       !string.IsNullOrWhiteSpace(scope.WindowName);
            bool matchedWindow = false;

            foreach (AutomationElement window in Children(desktop))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!WindowMatches(window, scope)) continue;
                matchedWindow = true;
                if (remaining <= 0)
                {
                    truncationReasons.Add("maxNodes");
                    omittedNodes++;
                    break;
                }

                SemanticNode? child = BuildTree(
                    window,
                    depth: 0,
                    scope.MaxDepth,
                    ref remaining,
                    truncationReasons,
                    ref omittedNodes,
                    cancellationToken);
                if (child is not null) root.Children.Add(child);
            }

            if (requiresWindowMatch && !matchedWindow)
                throw new SemanticNotFoundException("No window matched the requested scope.");

            if (scope.WindowLocator is not null)
            {
                SemanticNode windowIndex = new() { Id = "window-index", Role = "Desktop" };
                windowIndex.Children.AddRange(root.Children.Select(WithoutDescendants));
                SemanticNode selected = new SemanticResolver().Resolve(windowIndex, scope.WindowLocator);
                SemanticNode selectedTree = root.Children.Single(node => node.Id == selected.Id);
                root.Children = [selectedTree];
            }

            if (truncationReasons.Count > 0)
            {
                root.Truncation = new SemanticTruncation
                {
                    Reasons = truncationReasons.ToList(),
                    IncludedNodes = CountNodes(root),
                    OmittedNodesAtLeast = omittedNodes,
                };
            }

            return Task.FromResult(root);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            throw Translate(error, "Could not capture the UI Automation snapshot.");
        }
    }

    public Task InteractAsync(string id, SemanticAction action, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(action);
        cancellationToken.ThrowIfCancellationRequested();
        if (!_elements.TryGetValue(id, out AutomationElement? element))
            throw new SemanticStaleReferenceException("The UI Automation element is not in the current snapshot.");

        try
        {
            switch (action.Kind.Trim().ToLowerInvariant())
            {
                case "invoke":
                    Pattern<InvokePattern>(element, InvokePattern.Pattern, "Invoke").Invoke();
                    break;
                case "value":
                    if (action.Value is null) throw new SemanticProtocolException("Value actions require a value.");
                    Pattern<ValuePattern>(element, ValuePattern.Pattern, "Value").SetValue(action.Value);
                    break;
                case "focus":
                    element.SetFocus();
                    break;
                case "toggle":
                    Pattern<TogglePattern>(element, TogglePattern.Pattern, "Toggle").Toggle();
                    break;
                case "select":
                    Select(element, action.Value);
                    break;
                case "expand":
                    Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern, "Expand").Expand();
                    break;
                case "collapse":
                    Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern, "Expand").Collapse();
                    break;
                default:
                    throw new SemanticCapabilityException($"Unknown semantic action '{action.Kind}'.");
            }

            return Task.CompletedTask;
        }
        catch (Exception error) when (error is not OperationCanceledException && error is not SemanticException)
        {
            throw Translate(error, $"UI Automation action '{action.Kind}' failed.");
        }
    }

    private SemanticNode? BuildTree(
        AutomationElement element,
        int depth,
        int maxDepth,
        ref int remaining,
        HashSet<string> truncationReasons,
        ref int omittedNodes,
        CancellationToken cancellationToken)
    {
        if (remaining <= 0) return null;
        cancellationToken.ThrowIfCancellationRequested();

        SemanticNode node = CreateNode(element);
        remaining--;
        if (depth >= maxDepth)
        {
            if (Children(element).Any())
            {
                truncationReasons.Add("maxDepth");
                omittedNodes++;
            }
            return node;
        }

        foreach (AutomationElement child in Children(element))
        {
            if (remaining <= 0)
            {
                truncationReasons.Add("maxNodes");
                omittedNodes++;
                break;
            }
            SemanticNode? childNode = BuildTree(
                child,
                depth + 1,
                maxDepth,
                ref remaining,
                truncationReasons,
                ref omittedNodes,
                cancellationToken);
            if (childNode is not null) node.Children.Add(childNode);
        }

        return node;
    }

    private SemanticNode CreateNode(AutomationElement element)
    {
        AutomationElement.AutomationElementInformation current = element.Current;
        string id = $"uia-{_generation:x}-{_sequence++:x}-{Guid.NewGuid():N}";
        _elements[id] = element;

        SemanticNode node = new()
        {
            Id = id,
            Role = Role(current.ControlType),
            Name = EmptyToNull(current.Name),
            AutomationId = EmptyToNull(current.AutomationId),
            ClassName = EmptyToNull(current.ClassName),
            ProcessId = current.ProcessId,
            WindowHandle = current.NativeWindowHandle == 0 ? null : current.NativeWindowHandle,
            IsEnabled = current.IsEnabled,
            IsOffscreen = current.IsOffscreen,
            HasKeyboardFocus = current.HasKeyboardFocus,
        };

        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out object? valuePattern))
        {
            node.Value = EmptyToNull(((ValuePattern)valuePattern).Current.Value);
            node.Capabilities.Add("Value");
        }

        if (element.TryGetCurrentPattern(TextPattern.Pattern, out object? textPattern))
        {
            string text = ((TextPattern)textPattern).DocumentRange.GetText(4096).TrimEnd('\r', '\n');
            node.Text = EmptyToNull(text);
        }

        AddCapability<InvokePattern>(element, InvokePattern.Pattern, "Invoke", node);
        AddCapability<TogglePattern>(element, TogglePattern.Pattern, "Toggle", node);
        AddCapability<SelectionItemPattern>(element, SelectionItemPattern.Pattern, "Select", node);
        AddCapability<SelectionPattern>(element, SelectionPattern.Pattern, "Select", node);
        AddCapability<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern, "Expand", node);
        if (current.IsKeyboardFocusable) node.Capabilities.Add("Focus");

        return node;
    }

    private static void AddCapability<T>(
        AutomationElement element,
        AutomationPattern pattern,
        string capability,
        SemanticNode node)
    {
        if (element.TryGetCurrentPattern(pattern, out _) && !node.Capabilities.Contains(capability))
            node.Capabilities.Add(capability);
    }

    private static T Pattern<T>(AutomationElement element, AutomationPattern pattern, string capability)
    {
        if (!element.TryGetCurrentPattern(pattern, out object? implementation) || implementation is not T typed)
            throw new SemanticCapabilityException($"The element does not expose the '{capability}' UI Automation pattern.");
        return typed;
    }

    private static void Select(AutomationElement element, string? requestedValue)
    {
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out object? direct))
        {
            ((SelectionItemPattern)direct).Select();
            return;
        }

        if (string.IsNullOrWhiteSpace(requestedValue))
            throw new SemanticCapabilityException("Selecting from a container requires a semantic value.");

        List<(SelectionItemPattern Pattern, SemanticCandidateSummary Summary)> matches = [];
        Stack<AutomationElement> pending = new(Children(element).Reverse());
        int visited = 0;
        while (pending.Count > 0 &&
               visited < SelectionTraversalLimit &&
               matches.Count < SemanticLimits.AmbiguousCandidateSummaries)
        {
            AutomationElement candidate = pending.Pop();
            visited++;
            AutomationElement.AutomationElementInformation current = candidate.Current;
            if ((string.Equals(current.Name?.Trim(), requestedValue.Trim(), StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(current.AutomationId?.Trim(), requestedValue.Trim(), StringComparison.OrdinalIgnoreCase)) &&
                candidate.TryGetCurrentPattern(SelectionItemPattern.Pattern, out object? pattern) &&
                pattern is SelectionItemPattern selectionItem)
            {
                matches.Add((selectionItem, CandidateSummary(candidate, current)));
            }

            foreach (AutomationElement child in Children(candidate).Reverse()) pending.Push(child);
        }

        bool traversalComplete = pending.Count == 0;
        int selected = ContainerSelectionResolver.ResolveUnique(
            matches.Select(match => match.Summary).ToList(),
            traversalComplete,
            requestedValue);
        matches[selected].Pattern.Select();
    }

    private static SemanticCandidateSummary CandidateSummary(
        AutomationElement element,
        AutomationElement.AutomationElementInformation current)
    {
        string? text = null;
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out object? pattern) && pattern is TextPattern textPattern)
            text = EmptyToNull(textPattern.DocumentRange.GetText(4096).TrimEnd('\r', '\n'));
        return new SemanticCandidateSummary(
            null,
            Role(current.ControlType),
            EmptyToNull(current.Name),
            text,
            EmptyToNull(current.AutomationId));
    }

    private static IEnumerable<AutomationElement> Children(AutomationElement parent)
    {
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement? child = walker.GetFirstChild(parent);
        while (child is not null)
        {
            yield return child;
            child = walker.GetNextSibling(child);
        }
    }

    private static bool WindowMatches(AutomationElement element, SemanticScope scope)
    {
        AutomationElement.AutomationElementInformation current = element.Current;
        if (scope.ProcessId is int processId && current.ProcessId != processId) return false;
        return string.IsNullOrWhiteSpace(scope.WindowName) ||
               string.Equals(current.Name, scope.WindowName, StringComparison.OrdinalIgnoreCase);
    }

    private static string Role(ControlType controlType)
    {
        const string prefix = "ControlType.";
        string name = controlType.ProgrammaticName;
        return name.StartsWith(prefix, StringComparison.Ordinal) ? name[prefix.Length..] : name;
    }

    private static string? EmptyToNull(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    private static int CountNodes(SemanticNode root)
    {
        int count = 0;
        Stack<SemanticNode> pending = new();
        pending.Push(root);
        while (pending.Count > 0)
        {
            SemanticNode node = pending.Pop();
            count++;
            foreach (SemanticNode child in node.Children) pending.Push(child);
        }
        return count;
    }

    private static SemanticNode WithoutDescendants(SemanticNode source) => new()
    {
        Id = source.Id,
        Role = source.Role,
        Name = source.Name,
        AutomationId = source.AutomationId,
        ClassName = source.ClassName,
        ProcessId = source.ProcessId,
        WindowHandle = source.WindowHandle,
        IsEnabled = source.IsEnabled,
        IsOffscreen = source.IsOffscreen,
        HasKeyboardFocus = source.HasKeyboardFocus,
        Value = source.Value,
        Text = source.Text,
        Capabilities = [.. source.Capabilities],
    };

    private static SemanticException Translate(Exception error, string message) => error switch
    {
        SemanticException semantic => semantic,
        ElementNotAvailableException => new SemanticElementUnavailableException(message, error),
        UnauthorizedAccessException => new SemanticAccessException(message, error),
        _ => new SemanticBackendException(message, error),
    };
}
