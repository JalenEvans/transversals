namespace Transversals.GuestAgent.Host;

public enum MouseButton
{
    Left,
    Right,
}

public interface IInputSender
{
    void TypeText(string text);

    /// <summary>Sends a chord of already-validated, normalized key names, e.g. ["ctrl", "shift", "s"].</summary>
    void SendChord(IReadOnlyList<string> keys);

    void Click(int x, int y, MouseButton button, bool isDouble);

    bool IsKnownKey(string key);
}
