namespace Transversals.GuestAgent.Semantics;

public sealed class SemanticSession
{
    private readonly ISemanticBackend _backend;
    private readonly ISemanticClock _clock;
    private readonly SemanticResolver _resolver = new();
    private readonly Dictionary<string, CurrentElement> _references = new(StringComparer.Ordinal);
    private long _generation;
    private SemanticNode? _currentRoot;

    public SemanticSession(ISemanticBackend backend, ISemanticClock clock)
    {
        _backend = backend ?? throw new ArgumentNullException(nameof(backend));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public Task<SemanticNode> SnapshotAsync(CancellationToken cancellationToken) =>
        RefreshAsync(null, cancellationToken);

    public Task<SemanticNode> SnapshotAsync(SemanticScope scope, CancellationToken cancellationToken) =>
        RefreshAsync(scope, cancellationToken);

    public Task<SemanticNode> FindAsync(SemanticLocator locator, CancellationToken cancellationToken) =>
        FindAsync(locator, null, cancellationToken);

    public async Task<SemanticNode> FindAsync(
        SemanticLocator locator,
        SemanticScope? scope,
        CancellationToken cancellationToken)
    {
        SemanticNode root = await RefreshAsync(scope, cancellationToken).ConfigureAwait(false);
        return _resolver.Resolve(root, locator);
    }

    public async Task InteractAsync(
        string reference,
        SemanticAction action,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(action);
        CurrentElement current = ResolveReference(reference);
        string capability = NormalizeCapability(action.Kind);
        if (!current.Node.Capabilities.Any(item =>
                string.Equals(item, capability, StringComparison.OrdinalIgnoreCase)))
        {
            throw new SemanticCapabilityException(
                $"Element '{reference}' does not support the '{action.Kind}' capability.");
        }

        await _backend.InteractAsync(current.BackendId, action, cancellationToken).ConfigureAwait(false);
    }

    public Task<SemanticNode> AssertAsync(
        SemanticLocator locator,
        SemanticAssertion assertion,
        CancellationToken cancellationToken) =>
        AssertAsync(locator, assertion, null, cancellationToken);

    public async Task<SemanticNode> AssertAsync(
        SemanticLocator locator,
        SemanticAssertion assertion,
        SemanticScope? scope,
        CancellationToken cancellationToken)
    {
        SemanticNode node = await FindAsync(locator, scope, cancellationToken).ConfigureAwait(false);
        if (!AssertionPasses(node, assertion))
        {
            throw new SemanticAssertionException(
                $"Assertion on '{assertion.Property}' failed for element '{node.Reference}'.");
        }

        return node;
    }

    public Task<SemanticNode> AssertAsync(
        string reference,
        SemanticAssertion assertion,
        CancellationToken cancellationToken)
    {
        SemanticNode node = ResolveReference(reference).Node;
        if (!AssertionPasses(node, assertion))
        {
            throw new SemanticAssertionException(
                $"Assertion on '{assertion.Property}' failed for element '{reference}'.");
        }

        return Task.FromResult(node);
    }

    public Task<SemanticNode> WaitForAsync(
        SemanticLocator locator,
        SemanticAssertion assertion,
        TimeSpan timeout,
        TimeSpan pollInterval,
        CancellationToken cancellationToken) =>
        WaitForAsync(locator, assertion, timeout, pollInterval, null, cancellationToken);

    public async Task<SemanticNode> WaitForAsync(
        SemanticLocator locator,
        SemanticAssertion assertion,
        TimeSpan timeout,
        TimeSpan pollInterval,
        SemanticScope? scope,
        CancellationToken cancellationToken)
    {
        if (timeout < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        if (pollInterval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(pollInterval));

        DateTimeOffset deadline = _clock.UtcNow + timeout;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                SemanticNode node = await FindAsync(locator, scope, cancellationToken).ConfigureAwait(false);
                if (AssertionPasses(node, assertion)) return node;
            }
            catch (SemanticNotFoundException)
            {
                // Absence is an unmet condition while polling.
            }

            if (_clock.UtcNow >= deadline) throw new SemanticTimeoutException();

            TimeSpan remaining = deadline - _clock.UtcNow;
            await _clock.DelayAsync(
                remaining < pollInterval ? remaining : pollInterval,
                cancellationToken).ConfigureAwait(false);
        }
    }

    public SemanticNode ResolveReferenceNode(string reference) => ResolveReference(reference).Node;

    private async Task<SemanticNode> RefreshAsync(SemanticScope? scope, CancellationToken cancellationToken)
    {
        SemanticNode source = scope is not null && _backend is IScopedSemanticBackend scoped
            ? await scoped.SnapshotAsync(scope, cancellationToken).ConfigureAwait(false)
            : await _backend.SnapshotAsync(cancellationToken).ConfigureAwait(false);

        _generation++;
        _references.Clear();
        int sequence = 0;
        _currentRoot = CloneWithReferences(source, ref sequence);
        return _currentRoot;
    }

    private SemanticNode CloneWithReferences(SemanticNode source, ref int sequence)
    {
        string backendId = source.Id;
        string reference = $"s{_generation:x}-n{sequence++:x}-{Guid.NewGuid():N}";
        SemanticNode clone = new()
        {
            Id = source.Id,
            Reference = reference,
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
            Truncation = source.Truncation,
        };
        _references[reference] = new CurrentElement(_generation, backendId, clone);
        foreach (SemanticNode child in source.Children)
        {
            clone.Children.Add(CloneWithReferences(child, ref sequence));
        }

        return clone;
    }

    private CurrentElement ResolveReference(string reference)
    {
        if (string.IsNullOrWhiteSpace(reference) ||
            !_references.TryGetValue(reference, out CurrentElement? current) ||
            current.Generation != _generation)
        {
            throw new SemanticStaleReferenceException();
        }

        return current;
    }

    private static string NormalizeCapability(string kind) => kind.Trim() switch
    {
        string value when value.Equals("Collapse", StringComparison.OrdinalIgnoreCase) => "Expand",
        _ => kind.Trim(),
    };

    private static bool AssertionPasses(SemanticNode node, SemanticAssertion assertion)
    {
        ArgumentNullException.ThrowIfNull(assertion);
        System.Reflection.PropertyInfo? property = typeof(SemanticNode).GetProperties()
            .FirstOrDefault(candidate => candidate.Name.Equals(assertion.Property, StringComparison.OrdinalIgnoreCase));
        if (property is null)
            throw new SemanticProtocolException($"Unknown assertion property '{assertion.Property}'.");

        object? raw = property.GetValue(node);
        string? value = raw switch
        {
            null => null,
            IEnumerable<string> values => string.Join(",", values),
            _ => raw.ToString(),
        };

        if (assertion.Exists is bool exists && exists != !string.IsNullOrEmpty(value)) return false;
        if (assertion.Equals is not null && !string.Equals(value, assertion.Equals, StringComparison.OrdinalIgnoreCase)) return false;
        if (assertion.NotEquals is not null && string.Equals(value, assertion.NotEquals, StringComparison.OrdinalIgnoreCase)) return false;
        if (assertion.Contains is not null &&
            (value is null || !value.Contains(assertion.Contains, StringComparison.OrdinalIgnoreCase))) return false;

        return assertion.Exists is not null || assertion.Equals is not null ||
               assertion.NotEquals is not null || assertion.Contains is not null;
    }

    private sealed record CurrentElement(long Generation, string BackendId, SemanticNode Node);
}
