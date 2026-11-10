using System.Text.Json.Serialization;

namespace Transversals.GuestAgent.Semantics;

public sealed class SemanticNode
{
    public string Id { get; set; } = string.Empty;
    public string? Reference { get; set; }
    public string Role { get; set; } = string.Empty;
    public string? Name { get; set; }
    public string? AutomationId { get; set; }
    public string? ClassName { get; set; }
    public int? ProcessId { get; set; }
    public long? WindowHandle { get; set; }
    public bool? IsEnabled { get; set; }
    public bool? IsOffscreen { get; set; }
    public bool? HasKeyboardFocus { get; set; }
    public string? Value { get; set; }
    public string? Text { get; set; }
    public List<string> Capabilities { get; set; } = [];
    public List<SemanticNode> Children { get; set; } = [];
    public SemanticTruncation? Truncation { get; set; }
}

public sealed class SemanticTruncation
{
    public bool Truncated { get; set; } = true;
    public List<string> Reasons { get; set; } = [];
    public int? ByteBudget { get; set; }
    public int IncludedNodes { get; set; }
    public int OmittedNodesAtLeast { get; set; }
    public int TruncatedFields { get; set; }
}

public sealed class SemanticLocator
{
    public string? AutomationId { get; set; }
    public string? Role { get; set; }
    public string? Name { get; set; }
    public string? Text { get; set; }
    public string? Value { get; set; }
    public SemanticLocator? Ancestor { get; set; }
    public SemanticLocator? Descendant { get; set; }
    public SemanticLocator? Sibling { get; set; }
    public bool Fuzzy { get; set; }
    public int? Index { get; set; }
}

public sealed class SemanticAction
{
    public string Kind { get; set; } = string.Empty;
    public string? Value { get; set; }
}

public sealed class SemanticAssertion
{
    public string Property { get; set; } = string.Empty;
    public new string? Equals { get; set; }
    public string? NotEquals { get; set; }
    public string? Contains { get; set; }
    public bool? Exists { get; set; }
}

public sealed class SemanticScope
{
    public int? ProcessId { get; set; }
    public string? WindowName { get; set; }
    public SemanticLocator? WindowLocator { get; set; }
    public int MaxDepth { get; set; } = 12;
    public int MaxNodes { get; set; } = 1000;
}

public interface ISemanticBackend
{
    Task<SemanticNode> SnapshotAsync(CancellationToken cancellationToken);
    Task InteractAsync(string id, SemanticAction action, CancellationToken cancellationToken);
}

public interface IScopedSemanticBackend : ISemanticBackend
{
    Task<SemanticNode> SnapshotAsync(SemanticScope scope, CancellationToken cancellationToken);
}

public interface ISemanticClock
{
    DateTimeOffset UtcNow { get; }
    Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken);
}

public sealed class SystemSemanticClock : ISemanticClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

    public Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken) =>
        Task.Delay(duration, cancellationToken);
}

public static class SemanticErrorCodes
{
    public const string NotFound = "NOT_FOUND";
    public const string AmbiguousMatch = "AMBIGUOUS_MATCH";
    public const string StaleReference = "STALE_REFERENCE";
    public const string CapabilityUnavailable = "CAPABILITY_UNAVAILABLE";
    public const string AssertionFailed = "ASSERTION_FAILED";
    public const string AssertionTimeout = "ASSERTION_TIMEOUT";
    public const string InvalidRequest = "INVALID_REQUEST";
    public const string ElementUnavailable = "ELEMENT_UNAVAILABLE";
    public const string AccessDenied = "ACCESS_DENIED";
    public const string BackendFailure = "BACKEND_FAILURE";
}

public class SemanticException : Exception
{
    public SemanticException(string code, string message, Exception? innerException = null)
        : base(message, innerException) => Code = code;

    public string Code { get; }
}

public sealed record SemanticCandidateSummary(
    string? Reference,
    string Role,
    string? Name,
    string? Text,
    string? AutomationId);

internal static class SemanticLimits
{
    internal const int AmbiguousCandidateSummaries = 10;
}

public sealed class SemanticNotFoundException : SemanticException
{
    public SemanticNotFoundException(string message = "No element matched the semantic locator.")
        : base(SemanticErrorCodes.NotFound, message) { }
}

public sealed class SemanticAmbiguousException : SemanticException
{
    public SemanticAmbiguousException(
        IReadOnlyList<SemanticCandidateSummary> candidates,
        string message = "The semantic locator matched more than one element.")
        : base(SemanticErrorCodes.AmbiguousMatch, message) => Candidates = candidates;

    public IReadOnlyList<SemanticCandidateSummary> Candidates { get; }
}

public sealed class SemanticStaleReferenceException : SemanticException
{
    public SemanticStaleReferenceException(string message = "The element reference is not from the current snapshot.")
        : base(SemanticErrorCodes.StaleReference, message) { }
}

public sealed class SemanticCapabilityException : SemanticException
{
    public SemanticCapabilityException(string message = "The requested action is not supported by this element.")
        : base(SemanticErrorCodes.CapabilityUnavailable, message) { }
}

public sealed class SemanticAssertionException : SemanticException
{
    public SemanticAssertionException(string message = "The semantic assertion failed.")
        : base(SemanticErrorCodes.AssertionFailed, message) { }
}

public sealed class SemanticTimeoutException : SemanticException
{
    public SemanticTimeoutException(string message = "The semantic assertion did not pass before its deadline.")
        : base(SemanticErrorCodes.AssertionTimeout, message) { }
}

public sealed class SemanticProtocolException : SemanticException
{
    public SemanticProtocolException(string message)
        : base(SemanticErrorCodes.InvalidRequest, message) { }
}

public sealed class SemanticElementUnavailableException : SemanticException
{
    public SemanticElementUnavailableException(string message, Exception? innerException = null)
        : base(SemanticErrorCodes.ElementUnavailable, message, innerException) { }
}

public sealed class SemanticAccessException : SemanticException
{
    public SemanticAccessException(string message, Exception? innerException = null)
        : base(SemanticErrorCodes.AccessDenied, message, innerException) { }
}

public sealed class SemanticBackendException : SemanticException
{
    public SemanticBackendException(string message, Exception? innerException = null)
        : base(SemanticErrorCodes.BackendFailure, message, innerException) { }
}
