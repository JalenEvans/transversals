using System.Diagnostics;
using System.Reflection;

namespace Transversals.GuestAgent.Host.Win32;

public sealed class WindowsAgentInfo : IAgentInfo
{
    /// <summary>
    /// Version of the NDJSON host protocol (hello/exec/screenshot/input/windows) this agent speaks.
    /// 2: blank stdin lines are keepalives (no response), and an idle stdin ends the session.
    /// </summary>
    public const int CurrentProtocolVersion = 2;

    private readonly Lazy<int> _sessionId = new(() =>
    {
        using Process current = Process.GetCurrentProcess();
        return current.SessionId;
    });

    public string AgentVersion { get; } = ResolveAgentVersion();

    public int ProtocolVersion => CurrentProtocolVersion;

    public int SessionId => _sessionId.Value;

    /// <summary>Session 0 is the isolated services session; it has no interactive desktop.</summary>
    public bool IsInteractiveSession => SessionId != 0;

    // Only a single-file bundle ships the natives beside the exe; other builds load them from the shared framework.
    // IL3000 is the point here: an empty Location is how we detect the bundle.
#pragma warning disable IL3000
    public IReadOnlyList<string> MissingNativeFiles =>
        string.IsNullOrEmpty(typeof(WindowsAgentInfo).Assembly.Location)
            ? NativeFileCheck.FindMissing(AppContext.BaseDirectory)
            : [];
#pragma warning restore IL3000

    private static string ResolveAgentVersion()
    {
        Assembly assembly = typeof(WindowsAgentInfo).Assembly;
        return assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
               ?? assembly.GetCustomAttribute<AssemblyFileVersionAttribute>()?.Version
               ?? assembly.GetName().Version?.ToString()
               ?? "0.0.0";
    }
}
