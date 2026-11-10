using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

using Transversals.GuestAgent.Host.Streaming;

namespace Transversals.GuestAgent.Host.Win32;

/// <summary>
/// GDI capture of the whole virtual desktop, downscaled with HALFTONE StretchBlt, encoded as PNG
/// (screenshot command) or JPEG (stream mode).
/// </summary>
public sealed class WindowsScreenCapture : IScreenCapture, IJpegFrameSource
{
    public ScreenBounds VirtualScreen => ReadVirtualScreen();

    public CapturedImage Capture(int maxLongEdge)
    {
        BitmapSource source = CaptureBitmap(maxLongEdge);
        // GDI leaves alpha 0 on every pixel, so a 32-bit PNG renders fully transparent; drop the alpha channel.
        BitmapSource opaque = new FormatConvertedBitmap(source, PixelFormats.Bgr24, null, 0);
        PngBitmapEncoder encoder = new();
        encoder.Frames.Add(BitmapFrame.Create(opaque));
        using MemoryStream png = new();
        encoder.Save(png);
        return new CapturedImage(source.PixelWidth, source.PixelHeight, png.ToArray());
    }

    byte[] IJpegFrameSource.Capture(int maxLongEdge, int quality)
    {
        if (quality is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(quality));

        BitmapSource source = CaptureBitmap(maxLongEdge);
        JpegBitmapEncoder encoder = new() { QualityLevel = quality };
        encoder.Frames.Add(BitmapFrame.Create(source));
        using MemoryStream jpeg = new();
        encoder.Save(jpeg);
        return jpeg.ToArray();
    }

    /// <summary>
    /// Copies the virtual screen into a managed bitmap whose long edge is at most <paramref name="maxLongEdge"/>.
    /// All GDI handles are released before returning (the BitmapSource holds its own pixel copy).
    /// </summary>
    private static BitmapSource CaptureBitmap(int maxLongEdge)
    {
        if (maxLongEdge < 1) throw new ArgumentOutOfRangeException(nameof(maxLongEdge));

        ScreenBounds screen = ReadVirtualScreen();
        if (screen.Width <= 0 || screen.Height <= 0)
            throw new InvalidOperationException("The virtual screen has no area (no interactive desktop?).");

        (int width, int height) = FitLongEdge(screen.Width, screen.Height, maxLongEdge);

        IntPtr screenDc = NativeMethods.GetDC(IntPtr.Zero);
        if (screenDc == IntPtr.Zero)
            throw new InvalidOperationException("GetDC failed for the screen.");
        IntPtr memoryDc = IntPtr.Zero;
        IntPtr bitmap = IntPtr.Zero;
        try
        {
            memoryDc = NativeMethods.CreateCompatibleDC(screenDc);
            if (memoryDc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateCompatibleDC failed.");
            bitmap = NativeMethods.CreateCompatibleBitmap(screenDc, width, height);
            if (bitmap == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateCompatibleBitmap failed.");

            IntPtr previous = NativeMethods.SelectObject(memoryDc, bitmap);
            bool copied;
            const uint rop = NativeMethods.SRCCOPY | NativeMethods.CAPTUREBLT;
            if (width == screen.Width && height == screen.Height)
            {
                copied = NativeMethods.BitBlt(memoryDc, 0, 0, width, height, screenDc, screen.Left, screen.Top, rop);
            }
            else
            {
                NativeMethods.SetStretchBltMode(memoryDc, NativeMethods.HALFTONE);
                NativeMethods.SetBrushOrgEx(memoryDc, 0, 0, IntPtr.Zero);
                copied = NativeMethods.StretchBlt(
                    memoryDc, 0, 0, width, height, screenDc, screen.Left, screen.Top, screen.Width, screen.Height, rop);
            }
            int bltError = Marshal.GetLastWin32Error();
            NativeMethods.SelectObject(memoryDc, previous);
            if (!copied) throw new Win32Exception(bltError, "Screen copy (BitBlt/StretchBlt) failed.");

            return Imaging.CreateBitmapSourceFromHBitmap(
                bitmap, IntPtr.Zero, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
        }
        finally
        {
            if (bitmap != IntPtr.Zero) NativeMethods.DeleteObject(bitmap);
            if (memoryDc != IntPtr.Zero) NativeMethods.DeleteDC(memoryDc);
            NativeMethods.ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    internal static ScreenBounds ReadVirtualScreen() => new(
        NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN),
        NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN),
        NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN),
        NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN));

    private static (int Width, int Height) FitLongEdge(int width, int height, int maxLongEdge)
    {
        int longEdge = Math.Max(width, height);
        if (longEdge <= maxLongEdge) return (width, height);
        double scale = (double)maxLongEdge / longEdge;
        return (
            Math.Clamp((int)Math.Floor(width * scale), 1, maxLongEdge),
            Math.Clamp((int)Math.Floor(height * scale), 1, maxLongEdge));
    }
}
