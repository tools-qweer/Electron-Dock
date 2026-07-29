using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

internal static class WindowsDragHelper
{
    private const int VkLeftButton = 0x01;
    private const int VkEscape = 0x1B;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpAsyncWindowPos = 0x4000;
    private const int PollIntervalMilliseconds = 16;
    private const int MaximumDragDurationMilliseconds = 30000;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out Rect rectangle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    public static int Main()
    {
        Console.Out.WriteLine("READY");
        Console.Out.Flush();
        TryEnablePerMonitorDpi();

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                continue;
            }
            if (string.Equals(parts[0], "QUIT", StringComparison.Ordinal))
            {
                return 0;
            }
            if (
                parts.Length == 2
                && (
                    string.Equals(parts[0], "BEGIN", StringComparison.Ordinal)
                    || string.Equals(parts[0], "MONITOR", StringComparison.Ordinal)
                )
            )
            {
                ulong rawHandle;
                if (ulong.TryParse(parts[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out rawHandle))
                {
                    TrackWindow(
                        new IntPtr(unchecked((long)rawHandle)),
                        string.Equals(parts[0], "BEGIN", StringComparison.Ordinal)
                    );
                }
            }
        }
        return 0;
    }

    private static void TrackWindow(IntPtr window, bool moveWindow)
    {
        Point cursor;
        Rect rectangle;
        if (
            !IsWindow(window)
            || !GetCursorPos(out cursor)
            || !GetWindowRect(window, out rectangle)
        )
        {
            Emit("ERROR", 0, 0);
            return;
        }

        uint initialDpi = TryGetWindowDpi(window);
        double anchorDipX = (cursor.X - rectangle.Left) * 96.0 / initialDpi;
        double anchorDipY = (cursor.Y - rectangle.Top) * 96.0 / initialDpi;
        if (!IsPressed(VkLeftButton))
        {
            Emit("CANCEL", cursor.X, cursor.Y);
            return;
        }

        int startedAt = Environment.TickCount;
        int previousX = int.MinValue;
        int previousY = int.MinValue;
        while (IsPressed(VkLeftButton))
        {
            if (IsPressed(VkEscape))
            {
                Emit("CANCEL", cursor.X, cursor.Y);
                return;
            }
            if (ElapsedMilliseconds(startedAt) >= MaximumDragDurationMilliseconds)
            {
                Emit("CANCEL", cursor.X, cursor.Y);
                return;
            }
            if (!GetCursorPos(out cursor))
            {
                Emit("ERROR", 0, 0);
                return;
            }
            if (!IsWindow(window))
            {
                Emit("CANCEL", cursor.X, cursor.Y);
                return;
            }
            uint currentDpi = TryGetWindowDpi(window);
            int anchorX = (int)Math.Round(anchorDipX * currentDpi / 96.0);
            int anchorY = (int)Math.Round(anchorDipY * currentDpi / 96.0);
            if (
                moveWindow
                && (cursor.X != previousX || cursor.Y != previousY)
                && !SetWindowPos(
                    window,
                    IntPtr.Zero,
                    cursor.X - anchorX,
                    cursor.Y - anchorY,
                    0,
                    0,
                    SwpNoSize
                        | SwpNoZOrder
                        | SwpNoActivate
                        | SwpAsyncWindowPos
                )
            )
            {
                Emit("ERROR", cursor.X, cursor.Y);
                return;
            }
            if (cursor.X != previousX || cursor.Y != previousY)
            {
                previousX = cursor.X;
                previousY = cursor.Y;
                Emit("MOVE", cursor.X, cursor.Y);
            }
            Thread.Sleep(PollIntervalMilliseconds);
        }

        GetCursorPos(out cursor);
        Emit("RELEASE", cursor.X, cursor.Y);
    }

    private static int ElapsedMilliseconds(int startedAt)
    {
        return unchecked(Environment.TickCount - startedAt);
    }

    private static bool IsPressed(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
    }

    private static void Emit(string kind, int x, int y)
    {
        Console.Out.WriteLine(
            string.Format(
                CultureInfo.InvariantCulture,
                "{0} {1} {2}",
                kind,
                x,
                y
            )
        );
        Console.Out.Flush();
    }

    private static void TryEnablePerMonitorDpi()
    {
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
        }
        catch (EntryPointNotFoundException)
        {
        }
    }

    private static uint TryGetWindowDpi(IntPtr window)
    {
        try
        {
            uint dpi = GetDpiForWindow(window);
            return dpi == 0 ? 96u : dpi;
        }
        catch (EntryPointNotFoundException)
        {
            return 96u;
        }
    }
}
