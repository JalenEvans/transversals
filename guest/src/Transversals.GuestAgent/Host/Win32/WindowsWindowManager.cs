using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using static Transversals.GuestAgent.Host.Win32.NativeMethods;

namespace Transversals.GuestAgent.Host.Win32;

/// <summary>Lists visible, titled, uncloaked top-level windows and brings one to the foreground.</summary>
public sealed class WindowsWindowManager : IWindowManager
{
    private const ushort VK_MENU = 0x12;

    public IReadOnlyList<WindowInfo> List()
    {
        IntPtr foreground = GetForegroundWindow();
        Dictionary<uint, string> processNames = [];
        List<WindowInfo> windows = [];

        bool Visit(IntPtr hwnd, IntPtr _)
        {
            if (!IsWindowVisible(hwnd) || IsCloaked(hwnd)) return true;
            string title = ReadTitle(hwnd);
            if (title.Length == 0) return true;

            GetWindowThreadProcessId(hwnd, out uint processId);
            if (!processNames.TryGetValue(processId, out string? processName))
            {
                processName = ResolveProcessName(processId);
                processNames[processId] = processName;
            }

            windows.Add(new WindowInfo(hwnd.ToInt64(), title, (int)processId, processName, hwnd == foreground));
            return true;
        }

        EnumWindowsProc callback = Visit;
        if (!EnumWindows(callback, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "EnumWindows failed.");
        GC.KeepAlive(callback);
        return windows;
    }

    public bool Focus(long handle)
    {
        IntPtr hwnd = new(handle);
        if (handle == 0 || !IsWindow(hwnd)) return false;

        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        if (GetForegroundWindow() == hwnd) return true;

        if (!SetForegroundWindow(hwnd))
        {
            // Foreground lock: a synthetic Alt tap counts as the "last input" and unlocks SetForegroundWindow.
            TapAlt();
            if (!SetForegroundWindow(hwnd))
                throw new InvalidOperationException($"SetForegroundWindow refused window {handle}.");
        }

        return true;
    }

    private static string ReadTitle(IntPtr hwnd)
    {
        int length = GetWindowTextLengthW(hwnd);
        if (length <= 0) return string.Empty;
        char[] buffer = new char[length + 1];
        int copied = GetWindowTextW(hwnd, buffer, buffer.Length);
        return copied <= 0 ? string.Empty : new string(buffer, 0, copied);
    }

    private static bool IsCloaked(IntPtr hwnd) =>
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0;

    private static string ResolveProcessName(uint processId)
    {
        try
        {
            using Process process = Process.GetProcessById((int)processId);
            return process.ProcessName;
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return string.Empty;
        }
    }

    private static void TapAlt()
    {
        INPUT[] inputs =
        [
            new() { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = VK_MENU } } },
            new()
            {
                type = INPUT_KEYBOARD,
                u = new InputUnion { ki = new KEYBDINPUT { wVk = VK_MENU, dwFlags = KEYEVENTF_KEYUP } },
            },
        ];
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }
}
