using System.ComponentModel;
using System.Runtime.InteropServices;
using static Transversals.GuestAgent.Host.Win32.NativeMethods;

namespace Transversals.GuestAgent.Host.Win32;

/// <summary>Synthesizes keyboard and mouse input with SendInput.</summary>
public sealed class WindowsInputSender : IInputSender
{
    private const ushort VK_RETURN = 0x0D;
    private const ushort VK_TAB = 0x09;

    private static readonly IReadOnlyDictionary<string, ushort> VirtualKeys = BuildKeyMap();

    // Keys that need KEYEVENTF_EXTENDEDKEY to avoid being read as their numpad twins.
    private static readonly HashSet<ushort> ExtendedKeys =
    [
        0x21, 0x22, 0x23, 0x24, // pageup, pagedown, end, home
        0x25, 0x26, 0x27, 0x28, // left, up, right, down
        0x2D, 0x2E,             // insert, delete
        0x5B,                   // left win
    ];

    public bool IsKnownKey(string key) => VirtualKeys.ContainsKey(key);

    public void TypeText(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        List<INPUT> inputs = new(text.Length * 2);
        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            switch (character)
            {
                case '\r':
                    if (index + 1 < text.Length && text[index + 1] == '\n') continue;
                    AddVirtualKeyPress(inputs, VK_RETURN);
                    break;
                case '\n':
                    AddVirtualKeyPress(inputs, VK_RETURN);
                    break;
                case '\t':
                    AddVirtualKeyPress(inputs, VK_TAB);
                    break;
                default:
                    inputs.Add(Keyboard(0, character, KEYEVENTF_UNICODE));
                    inputs.Add(Keyboard(0, character, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                    break;
            }
        }

        Send(inputs);
    }

    public void SendChord(IReadOnlyList<string> keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        ushort[] virtualKeys = keys
            .Select(key => VirtualKeys.TryGetValue(key, out ushort vk)
                ? vk
                : throw new ArgumentException($"Unknown key '{key}'.", nameof(keys)))
            .ToArray();

        List<INPUT> inputs = new(virtualKeys.Length * 2);
        foreach (ushort vk in virtualKeys)
            inputs.Add(Keyboard(vk, 0, ExtendedFlag(vk)));
        for (int index = virtualKeys.Length - 1; index >= 0; index--)
            inputs.Add(Keyboard(virtualKeys[index], 0, ExtendedFlag(virtualKeys[index]) | KEYEVENTF_KEYUP));

        Send(inputs);
    }

    public void Click(int x, int y, MouseButton button, bool isDouble)
    {
        ScreenBounds screen = WindowsScreenCapture.ReadVirtualScreen();
        if (screen.Width <= 1 || screen.Height <= 1)
            throw new InvalidOperationException("The virtual screen has no area (no interactive desktop?).");

        // Normalize to 0..65535 across the whole virtual desktop.
        int normalizedX = (int)Math.Round((x - screen.Left) * 65535.0 / (screen.Width - 1));
        int normalizedY = (int)Math.Round((y - screen.Top) * 65535.0 / (screen.Height - 1));
        (uint down, uint up) = button switch
        {
            MouseButton.Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            MouseButton.Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            _ => throw new ArgumentOutOfRangeException(nameof(button)),
        };

        const uint position = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        List<INPUT> inputs = [Mouse(normalizedX, normalizedY, position | MOUSEEVENTF_MOVE)];
        int clicks = isDouble ? 2 : 1;
        for (int click = 0; click < clicks; click++)
        {
            inputs.Add(Mouse(normalizedX, normalizedY, position | down));
            inputs.Add(Mouse(normalizedX, normalizedY, position | up));
        }

        Send(inputs);
    }

    private static uint ExtendedFlag(ushort vk) => ExtendedKeys.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0;

    private static void AddVirtualKeyPress(List<INPUT> inputs, ushort vk)
    {
        inputs.Add(Keyboard(vk, 0, 0));
        inputs.Add(Keyboard(vk, 0, KEYEVENTF_KEYUP));
    }

    private static INPUT Keyboard(ushort vk, ushort scan, uint flags) => new()
    {
        type = INPUT_KEYBOARD,
        u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } },
    };

    private static INPUT Mouse(int dx, int dy, uint flags) => new()
    {
        type = INPUT_MOUSE,
        u = new InputUnion { mi = new MOUSEINPUT { dx = dx, dy = dy, dwFlags = flags } },
    };

    private static void Send(List<INPUT> inputs)
    {
        if (inputs.Count == 0) return;
        INPUT[] array = inputs.ToArray();
        uint sent = SendInput((uint)array.Length, array, Marshal.SizeOf<INPUT>());
        if (sent != array.Length)
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                $"SendInput delivered {sent} of {array.Length} events (blocked by UIPI or a secure desktop?).");
    }

    private static Dictionary<string, ushort> BuildKeyMap()
    {
        Dictionary<string, ushort> map = new(StringComparer.Ordinal)
        {
            ["ctrl"] = 0x11,
            ["shift"] = 0x10,
            ["alt"] = 0x12,
            ["win"] = 0x5B,
            ["enter"] = VK_RETURN,
            ["tab"] = VK_TAB,
            ["esc"] = 0x1B,
            ["space"] = 0x20,
            ["backspace"] = 0x08,
            ["delete"] = 0x2E,
            ["insert"] = 0x2D,
            ["home"] = 0x24,
            ["end"] = 0x23,
            ["pageup"] = 0x21,
            ["pagedown"] = 0x22,
            ["left"] = 0x25,
            ["up"] = 0x26,
            ["right"] = 0x27,
            ["down"] = 0x28,
        };
        for (char letter = 'a'; letter <= 'z'; letter++)
            map[letter.ToString()] = (ushort)('A' + (letter - 'a'));
        for (char digit = '0'; digit <= '9'; digit++)
            map[digit.ToString()] = digit;
        for (int function = 1; function <= 24; function++)
            map[$"f{function}"] = (ushort)(0x70 + function - 1);
        return map;
    }
}
