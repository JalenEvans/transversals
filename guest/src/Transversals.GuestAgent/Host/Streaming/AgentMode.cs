namespace Transversals.GuestAgent.Host.Streaming;

/// <summary>How the agent runs, chosen from the first command-line argument.</summary>
internal enum AgentMode
{
    /// <summary>No arguments: the NDJSON request/response session on stdin/stdout.</summary>
    Ndjson,

    /// <summary><c>stream [flags]</c>: length-prefixed JPEG frames on stdout.</summary>
    Stream,

    /// <summary>Anything else; the process exits 2.</summary>
    Invalid,
}
