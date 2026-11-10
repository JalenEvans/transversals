namespace Transversals.GuestAgent.Semantics;

internal static class ContainerSelectionResolver
{
    internal static int ResolveUnique(
        IReadOnlyList<SemanticCandidateSummary> candidates,
        bool traversalComplete,
        string requestedValue)
    {
        ArgumentNullException.ThrowIfNull(candidates);

        if (candidates.Count > 1)
        {
            throw new SemanticAmbiguousException(
                candidates.Take(SemanticLimits.AmbiguousCandidateSummaries).ToList(),
                $"More than one selectable item matched '{requestedValue}'.");
        }

        if (!traversalComplete)
        {
            throw new SemanticCapabilityException(
                $"Selection lookup for '{requestedValue}' exceeded its bounded descendant scan.");
        }

        if (candidates.Count == 0)
            throw new SemanticNotFoundException($"No selectable item matched '{requestedValue}'.");

        return 0;
    }
}
