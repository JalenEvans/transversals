using System.Text.Json;
using System.Text.Json.Serialization;
using Transversals.GuestAgent.Host;

namespace Transversals.GuestAgent.Semantics;

public sealed class NdjsonProtocolHandler
{
    public const int DefaultResponseByteBudget = 3 * 1024 * 1024;
    private const int MinimumResponseByteBudget = 64 * 1024;
    private const int MaximumEnvelopeReserveBytes = 256 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly SemanticSession _session;
    private readonly int _responseByteBudget;
    private readonly GuestHostPorts? _ports;

    public NdjsonProtocolHandler(SemanticSession session)
        : this(session, DefaultResponseByteBudget) { }

    public NdjsonProtocolHandler(SemanticSession session, int responseByteBudget)
    {
        _session = session ?? throw new ArgumentNullException(nameof(session));
        if (responseByteBudget < MinimumResponseByteBudget)
            throw new ArgumentOutOfRangeException(nameof(responseByteBudget));
        _responseByteBudget = responseByteBudget;
    }

    public NdjsonProtocolHandler(
        SemanticSession session,
        GuestHostPorts ports,
        int responseByteBudget = DefaultResponseByteBudget)
        : this(session, responseByteBudget)
    {
        _ports = ports ?? throw new ArgumentNullException(nameof(ports));
    }

    public async Task<string> HandleLineAsync(string line, CancellationToken cancellationToken)
    {
        string? requestId = null;
        int commandIndex = -1;
        try
        {
            using JsonDocument document = JsonDocument.Parse(line);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new SemanticProtocolException("Request must be a JSON object.");

            requestId = ReadOptionalString(root, "id");
            if (!root.TryGetProperty("commands", out JsonElement commands) || commands.ValueKind != JsonValueKind.Array)
                throw new SemanticProtocolException("Request must contain a commands array.");

            int commandCount = commands.GetArrayLength();
            if (commandCount is < 1 or > 50)
                throw new SemanticProtocolException("Request must contain between 1 and 50 commands.");
            int envelopeReserve = Math.Min(MaximumEnvelopeReserveBytes, _responseByteBudget / 8);
            int resultByteBudget = Math.Max(
                512,
                (_responseByteBudget - envelopeReserve) / Math.Max(1, commandCount));
            SemanticSnapshotBudget snapshotBudget = new(resultByteBudget);
            List<object?> results = [];
            string? lastReference = null;
            foreach (JsonElement command in commands.EnumerateArray())
            {
                commandIndex++;
                object? result = await ExecuteAsync(command, lastReference, resultByteBudget, cancellationToken).ConfigureAwait(false);
                if (result is SemanticNode node) result = snapshotBudget.Apply(node);
                results.Add(result);
                lastReference = ExtractReference(result) ?? lastReference;
            }

            string response = JsonSerializer.Serialize(new { id = requestId, status = "ok", results }, JsonOptions);
            if (System.Text.Encoding.UTF8.GetByteCount(response) > _responseByteBudget)
                throw new SemanticBackendException("Semantic response exceeded its UTF-8 byte budget.");
            return response;
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            string code = error switch
            {
                SemanticException semantic => semantic.Code,
                JsonException => SemanticErrorCodes.InvalidRequest,
                _ => SemanticErrorCodes.BackendFailure,
            };
            object? details = error is SemanticAmbiguousException ambiguous
                ? new { candidates = ambiguous.Candidates }
                : null;
            return JsonSerializer.Serialize(new
            {
                id = requestId,
                status = "error",
                error = new { commandIndex, code, message = error.Message, details },
            }, JsonOptions);
        }
    }

    private async Task<object?> ExecuteAsync(
        JsonElement command,
        string? lastReference,
        int resultByteBudget,
        CancellationToken cancellationToken)
    {
        if (command.ValueKind != JsonValueKind.Object)
            throw new SemanticProtocolException("Each command must be a JSON object.");

        string type = ReadRequiredString(command, "type").ToLowerInvariant();
        if (HostCommands.IsHostCommand(type))
        {
            if (_ports is null)
                throw new SemanticCapabilityException($"Host command '{type}' is unavailable in this agent configuration.");
            return await HostCommands.ExecuteAsync(type, command, _ports, resultByteBudget, JsonOptions, cancellationToken)
                .ConfigureAwait(false);
        }

        SemanticScope? scope = DeserializeOptional<SemanticScope>(command, "scope");
        switch (type)
        {
            case "snapshot":
                return scope is null
                    ? await _session.SnapshotAsync(cancellationToken).ConfigureAwait(false)
                    : await _session.SnapshotAsync(scope, cancellationToken).ConfigureAwait(false);

            case "find":
            {
                SemanticLocator locator = DeserializeRequired<SemanticLocator>(command, "locator");
                return scope is null
                    ? await _session.FindAsync(locator, cancellationToken).ConfigureAwait(false)
                    : await _session.FindAsync(locator, scope, cancellationToken).ConfigureAwait(false);
            }

            case "interact":
            {
                string reference = ResolveReference(ReadRequiredString(command, "ref"), lastReference);
                SemanticAction action = DeserializeRequired<SemanticAction>(command, "action");
                await _session.InteractAsync(reference, action, cancellationToken).ConfigureAwait(false);
                return new { reference, completed = true };
            }

            case "assert":
            {
                SemanticAssertion assertion = DeserializeRequired<SemanticAssertion>(command, "assertion");
                if (!command.TryGetProperty("locator", out _))
                {
                    string reference = ResolveReference(ReadRequiredString(command, "ref"), lastReference);
                    return await _session.AssertAsync(reference, assertion, cancellationToken).ConfigureAwait(false);
                }

                SemanticLocator locator = DeserializeRequired<SemanticLocator>(command, "locator");
                return scope is null
                    ? await _session.AssertAsync(locator, assertion, cancellationToken).ConfigureAwait(false)
                    : await _session.AssertAsync(locator, assertion, scope, cancellationToken).ConfigureAwait(false);
            }

            case "wait":
            {
                SemanticLocator locator = DeserializeRequired<SemanticLocator>(command, "locator");
                SemanticAssertion assertion = DeserializeRequired<SemanticAssertion>(command, "assertion");
                TimeSpan timeout = ReadDuration(command, "timeoutMs", TimeSpan.FromSeconds(10));
                TimeSpan interval = ReadDuration(command, "pollIntervalMs", TimeSpan.FromMilliseconds(100));
                return scope is null
                    ? await _session.WaitForAsync(locator, assertion, timeout, interval, cancellationToken).ConfigureAwait(false)
                    : await _session.WaitForAsync(locator, assertion, timeout, interval, scope, cancellationToken).ConfigureAwait(false);
            }

            default:
                throw new SemanticProtocolException($"Unknown command type '{type}'.");
        }
    }

    private static string? ExtractReference(object? result) =>
        result?.GetType().GetProperty(nameof(SemanticNode.Reference))?.GetValue(result) as string;

    private static string ResolveReference(string value, string? lastReference) => value == "$last"
        ? lastReference ?? throw new SemanticProtocolException("$last is unavailable before a reference-producing command.")
        : value;

    private static string ReadRequiredString(JsonElement owner, string property)
    {
        string? value = ReadOptionalString(owner, property);
        return string.IsNullOrWhiteSpace(value)
            ? throw new SemanticProtocolException($"'{property}' must be a non-empty string.")
            : value;
    }

    private static string? ReadOptionalString(JsonElement owner, string property)
    {
        if (!owner.TryGetProperty(property, out JsonElement value)) return null;
        if (value.ValueKind != JsonValueKind.String)
            throw new SemanticProtocolException($"'{property}' must be a string.");
        return value.GetString();
    }

    private static T DeserializeRequired<T>(JsonElement owner, string property)
    {
        if (!owner.TryGetProperty(property, out JsonElement value))
            throw new SemanticProtocolException($"Command is missing '{property}'.");
        return value.Deserialize<T>(JsonOptions)
            ?? throw new SemanticProtocolException($"'{property}' has an invalid value.");
    }

    private static T? DeserializeOptional<T>(JsonElement owner, string property) where T : class =>
        owner.TryGetProperty(property, out JsonElement value) ? value.Deserialize<T>(JsonOptions) : null;

    private static TimeSpan ReadDuration(JsonElement owner, string property, TimeSpan fallback)
    {
        if (!owner.TryGetProperty(property, out JsonElement value)) return fallback;
        if (!value.TryGetDouble(out double milliseconds) || milliseconds < 0)
            throw new SemanticProtocolException($"'{property}' must be a non-negative number.");
        return TimeSpan.FromMilliseconds(milliseconds);
    }
}
