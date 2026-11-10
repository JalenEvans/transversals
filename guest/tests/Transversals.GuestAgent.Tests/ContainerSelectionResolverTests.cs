using Transversals.GuestAgent.Semantics;

namespace Transversals.GuestAgent.Tests;

public sealed class ContainerSelectionResolverTests
{
    [Fact]
    public void Duplicate_name_or_automation_id_matches_are_bounded_and_unique_match_resolves()
    {
        List<SemanticCandidateSummary> duplicates = Enumerable.Range(0, 12)
            .Select(index => new SemanticCandidateSummary(
                $"reference-{index:00}",
                "ListItem",
                index % 2 == 0 ? "COM7" : $"Port {index:00}",
                $"USB port {index:00}",
                index % 2 == 0 ? $"port-{index:00}" : "COM7"))
            .ToList();

        SemanticAmbiguousException error = Assert.Throws<SemanticAmbiguousException>(() =>
            ContainerSelectionResolver.ResolveUnique(duplicates, traversalComplete: true, "COM7"));

        Assert.Equal(SemanticErrorCodes.AmbiguousMatch, error.Code);
        Assert.Equal(duplicates.Take(10), error.Candidates);
        Assert.Equal(
            0,
            ContainerSelectionResolver.ResolveUnique([duplicates[0]], traversalComplete: true, "COM7"));
    }
}
