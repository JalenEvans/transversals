namespace Transversals.GuestAgent.Host;

public sealed record WindowInfo(long Handle, string Title, int ProcessId, string ProcessName, bool IsForeground);

public interface IWindowManager
{
    IReadOnlyList<WindowInfo> List();

    /// <summary>Returns false if the handle is unknown.</summary>
    bool Focus(long handle);
}
