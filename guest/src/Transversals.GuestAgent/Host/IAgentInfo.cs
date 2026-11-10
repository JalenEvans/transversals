namespace Transversals.GuestAgent.Host;

public interface IAgentInfo
{
    string AgentVersion { get; }
    int ProtocolVersion { get; }
    int SessionId { get; }
    bool IsInteractiveSession { get; }

    /// <summary>Required native DLLs absent from the agent's directory; empty when the install is complete.</summary>
    IReadOnlyList<string> MissingNativeFiles { get; }
}
