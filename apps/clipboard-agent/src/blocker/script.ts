/**
 * A local-owner privacy overlay styled after Windows 11, not Windows authentication. The only credential it accepts is
 * the PocketClipboard PIN; it never submits input to the operating system.
 *
 * The window is opaque on purpose. WPF cannot exclude a per-pixel layered window from screen capture
 * (SetWindowDisplayAffinity fails on it), so AllowsTransparency stays off and Claude's screenshots show the desktop
 * under the window instead of the window.
 *
 * What the person does: keys are swallowed by a low-level keyboard hook and typed into the local PIN box by hand, so
 * nothing reaches the desktop; clicks land on the window itself. What the agent does: injected input is let through the
 * hook, and an injected click is preceded by "through", which makes the window click-through for a moment so the click
 * reaches the desktop underneath.
 *
 * Kept as a string so the single-file PocketClipboard.exe can write it next to its state and run it. Because this is a
 * JS template literal the code must avoid backticks and the dollar-brace sequence. Add-Type compiles with the C# 5
 * compiler of .NET Framework: no string interpolation, no ?. and no expression-bodied members.
 */
export const BLOCKER_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Web.Extensions, System.Drawing, System.Windows.Forms
$refs = @(
  [System.Windows.Window], [System.Windows.Media.Brush], [System.Windows.Threading.Dispatcher], [System.Xaml.XamlType],
  [System.Web.Script.Serialization.JavaScriptSerializer], [System.Drawing.Color], [System.Windows.Forms.Screen]
) | ForEach-Object { $_.Assembly.Location } | Select-Object -Unique

Add-Type -ReferencedAssemblies $refs -IgnoreWarnings -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace PocketBlocker
{
    public static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
        [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int type, KeyboardProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
        [DllImport("ole32.dll")] public static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr instance);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] public static extern int RegSetKeyValue(IntPtr key, string sub, string name, int type, ref int data, int bytes);
        [DllImport("user32.dll")] public static extern IntPtr SetTimer(IntPtr hWnd, IntPtr id, uint ms, IntPtr proc);
        [DllImport("user32.dll")] public static extern bool KillTimer(IntPtr hWnd, IntPtr id);
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint key);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] public static extern int NetUserGetInfo(string server, string user, int level, out IntPtr buffer);
        [DllImport("netapi32.dll")] public static extern int NetApiBufferFree(IntPtr buffer);

        public const int WH_KEYBOARD_LL = 13;
        public const int LLKHF_INJECTED = 0x10;
        public const int LLKHF_UP = 0x80;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x80;
        public const int WS_EX_APPWINDOW = 0x40000;
        public const int WS_EX_TRANSPARENT = 0x20;
        public const int WS_EX_LAYERED = 0x80000;
        public const int WS_EX_NOACTIVATE = 0x8000000;
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
        public const uint LWA_ALPHA = 0x2;
        public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
        // HWND_TOPMOST with SWP_NOACTIVATE: over everything, without taking the desktop's focus.
        public static readonly IntPtr Topmost = new IntPtr(-1);
        public const uint SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40, SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2;
        // Alt+Shift+Space locks the picture in place: registered with the system so it works while the window is hidden.
        public const int HotkeyId = 1;
        public const int WM_HOTKEY = 0x0312;
        public const int WM_DISPLAYCHANGE = 0x007E, WM_DPICHANGED = 0x02E0;
        public const uint MOD_ALT = 0x1, MOD_SHIFT = 0x4, MOD_NOREPEAT = 0x4000;
        public const uint VK_SPACE = 0x20, VK_MENU = 0x12, VK_SHIFT = 0x10, VK_Q = 0x51;
        public const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;
        public const int WM_TIMER = 0x0113;
        public const byte VK_ESCAPE = 0x1B;
        public const int HKEY_CURRENT_USER = unchecked((int)0x80000001);
        public const int REG_DWORD = 4;
        public static readonly IntPtr HwndBroadcast = new IntPtr(0xffff);
        public const uint WM_SETTINGCHANGE = 0x001A, SMTO_ABORTIFHUNG = 0x0002;
        public const uint KEYEVENTF_KEYUP = 0x2;

        [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IVirtualDesktopManager
        {
            int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrent);
            int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktop);
            int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktop);
        }

        public static IVirtualDesktopManager Desktops()
        {
            Guid clsid = new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a");
            Guid iid = typeof(IVirtualDesktopManager).GUID;
            IntPtr raw;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out raw);
            if (hr != 0 || raw == IntPtr.Zero) return null;
            return (IVirtualDesktopManager)Marshal.GetObjectForIUnknown(raw);
        }

        // The Task View, the search flyout, the window switcher: full-screen shell UI a touchpad gesture opens.
        public static bool IsShellOverlay(IntPtr h)
        {
            StringBuilder name = new StringBuilder(64);
            if (GetClassName(h, name, name.Capacity) == 0) return false;
            string cls = name.ToString();
            return cls == "Windows.UI.Core.CoreWindow" || cls == "XamlExplorerHostIslandWindow" || cls == "MultitaskingViewFrame"
                || cls == "Windows.Internal.Shell.TabProxyWindow" || cls == "Shell_TrayWnd" || cls == "TaskListThumbnailWnd";
        }

        static IVirtualDesktopManager desktops;
        static bool desktopChecked;

        // The picture is on one virtual desktop; on another the desktop is in plain sight. Bringing the window forward
        // is all a program may do, and Windows switches to its desktop with it. Once every couple of seconds at most: a
        // person may be typing on another desktop for a reason.
        public static bool OnPictureDesktop(IntPtr window)
        {
            int now = Environment.TickCount;
            if (desktopAt != 0 && unchecked(now - desktopAt) < 2000) return false;
            desktopAt = now;
            if (!desktopChecked)
            {
                desktopChecked = true;
                try { desktops = Desktops(); } catch (Exception) { desktops = null; }
            }
            if (desktops == null) return false;
            try
            {
                int onCurrent;
                if (desktops.IsWindowOnCurrentVirtualDesktop(window, out onCurrent) != 0) { desktops = null; return false; }
                return onCurrent == 0;
            }
            catch (Exception) { desktops = null; return false; }
        }

        static int desktopAt;

        [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
        [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }
        // USER_INFO_11, as far as the full name: what the real lock screen writes under the avatar.
        [StructLayout(LayoutKind.Sequential)] public struct USER_INFO_11
        {
            public IntPtr usr_name;
            public IntPtr usr_comment;
            public int usr_priv;
            public IntPtr usr_home_dir;
            public IntPtr usr_parms;
            public IntPtr usr_script_path;
            public int usr_auth_flags;
            public IntPtr usr_full_name;
        }

        public delegate IntPtr KeyboardProc(int code, IntPtr wParam, IntPtr lParam);

        // The account's display name, as Windows' own lock screen shows it; the account name when there is none.
        public static string DisplayName()
        {
            IntPtr buffer = IntPtr.Zero;
            try
            {
                if (NetUserGetInfo(null, Environment.UserName, 11, out buffer) == 0 && buffer != IntPtr.Zero)
                {
                    USER_INFO_11 info = (USER_INFO_11)Marshal.PtrToStructure(buffer, typeof(USER_INFO_11));
                    if (info.usr_full_name != IntPtr.Zero)
                    {
                        string full = Marshal.PtrToStringUni(info.usr_full_name);
                        if (full != null && full.Trim().Length > 0) return full.Trim();
                    }
                }
            }
            catch (Exception) { }
            finally
            {
                if (buffer != IntPtr.Zero)
                {
                    try { NetApiBufferFree(buffer); } catch (Exception) { }
                }
            }
            return Environment.UserName;
        }

        // Letters are not shown anywhere: they only feed the owner's escape word.
        public static char LetterOf(uint vk)
        {
            if (vk >= 0x41 && vk <= 0x5A) return (char)('a' + (vk - 0x41));
            return '\0';
        }

        // The password box takes digits the way a Windows PIN does.
        public static char DigitOf(uint vk)
        {
            if (vk >= 0x30 && vk <= 0x39) return (char)('0' + (vk - 0x30));
            if (vk >= 0x60 && vk <= 0x69) return (char)('0' + (vk - 0x60));
            return '\0';
        }
    }

    public sealed class Blocker
    {
        static readonly FontFamily UiFont = new FontFamily("Segoe UI");
        static readonly FontFamily IconFont = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets");
        static readonly object OutLock = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        public static void Run()
        {
            new Blocker().Start();
        }

        Window win;
        Grid root;
        TextBlock clockText, dateText, errorText, pinPlaceholder;
        PasswordBox box;
        Grid errorMark;
        Canvas login, cornerCanvas;
        Grid loginPanel;
        StackPanel loginStack, cornerPanel;
        DispatcherTimer clockTimer, throughTimer;
        IntPtr hwnd, hook;
        Native.KeyboardProc hookProc;
        bool locked = true;
        int lastHotkey;
        int placedX = int.MinValue, placedY = int.MinValue, placedWidth = int.MinValue, placedHeight = int.MinValue;
        readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
        int drainQueued;
        bool inputClosed;

        void Start()
        {
            Json.MaxJsonLength = int.MaxValue;
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch (Exception) { try { Native.SetProcessDPIAware(); } catch (Exception) { } }
            var app = new Application();
            app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            app.DispatcherUnhandledException += OnCrash;
            win = new Window();
            win.Title = "PocketClipboard privacy overlay";
            win.WindowStyle = WindowStyle.None;
            win.ResizeMode = ResizeMode.NoResize;
            win.ShowInTaskbar = false;
            win.ShowActivated = false;
            win.Topmost = true;
            win.WindowStartupLocation = WindowStartupLocation.Manual;
            win.FontFamily = UiFont;
            win.UseLayoutRounding = true;
            win.SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(win, TextFormattingMode.Display);
            win.SourceInitialized += delegate { StyleHwnd(); Place(); PositionLogin(); };
            win.Closing += OnClosing;
            Build();
            StartClock();
            StartInput(app.Dispatcher);
            StartHook();
            StartRaise();
            StartGuard();
            // Hidden until the agent says otherwise: the process stays resident so Alt+Shift+Space always works.
            win.Show();
            win.Hide();
            HookMessages();
            Emit("ready");
            app.Run();
        }

        // The window closing with the picture up must not leave the person's gestures switched off.
        void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            GesturesBack();
        }

        void OnCrash(object sender, DispatcherUnhandledExceptionEventArgs e)
        {
            Emit("error", "message", e.Exception.Message);
            e.Handled = true;
        }

        // ---------------------------------------------------------------- the window itself

        // Out of Alt+Tab and the taskbar, never takes focus (so the desktop keeps it), invisible to screen capture.
        void StyleHwnd()
        {
            hwnd = new WindowInteropHelper(win).Handle;
            int ex = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, (ex | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE) & ~Native.WS_EX_APPWINDOW);
            if (!Native.SetWindowDisplayAffinity(hwnd, Native.WDA_EXCLUDEFROMCAPTURE))
                Emit("log", "message", "capture exclusion failed: " + Marshal.GetLastWin32Error());
            try
            {
                int square = 0;
                Native.DwmSetWindowAttribute(hwnd, 33, ref square, 4);
            }
            catch (Exception) { }
            // Alt+Shift+Space: the one way in from outside the picture, and it works while the window is hidden.
            if (!Native.RegisterHotKey(hwnd, Native.HotkeyId, Native.MOD_ALT | Native.MOD_SHIFT | Native.MOD_NOREPEAT, Native.VK_SPACE))
                Emit("log", "message", "lock hotkey Alt+Shift+Space is taken by another program: " + Marshal.GetLastWin32Error());
        }

        // WM_HOTKEY arrives at the window procedure even while the window is hidden; the hook is added once there is
        // a source to hang it on.
        void HookMessages()
        {
            HwndSource src = HwndSource.FromHwnd(hwnd);
            if (src == null) return;
            src.AddHook(OnMessage);
        }

        IntPtr OnMessage(IntPtr h, int msg, IntPtr w, IntPtr l, ref bool handled)
        {
            if (msg == Native.WM_DISPLAYCHANGE || msg == Native.WM_DPICHANGED)
            {
                placedWidth = int.MinValue;
                win.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate { Place(); PositionLogin(); }));
            }
            if (msg == Native.WM_HOTKEY && w.ToInt32() == Native.HotkeyId)
            {
                // Always reported: the agent knows whether the picture is up, and a window that came back from a crash
                // believes it is locked while it is not on screen.
                handled = true;
                Hotkey();
            }
            return IntPtr.Zero;
        }

        // Over every monitor, in physical pixels: the per-monitor DPI mode means WPF's own left/top are DIPs, which at
        // 125 or 150 percent would leave a strip of desktop showing.
        void Place()
        {
            if (hwnd == IntPtr.Zero) return;
            int x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int width = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int height = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (x == placedX && y == placedY && width == placedWidth && height == placedHeight) return;
            uint flags = Native.SWP_NOACTIVATE;
            if (locked) flags |= Native.SWP_SHOWWINDOW;
            if (Native.SetWindowPos(
                hwnd, Native.Topmost,
                x, y, width, height, flags))
            {
                placedX = x;
                placedY = y;
                placedWidth = width;
                placedHeight = height;
            }
        }

        // The picture spans the whole desktop; the clock, avatar and box stay over the primary monitor at its DPI, so
        // they look the same size on a scaled laptop display and a large monitor beside it.
        void PositionLogin()
        {
            if (loginPanel == null) return;
            System.Drawing.Rectangle primary = global::System.Windows.Forms.Screen.PrimaryScreen.Bounds;
            System.Drawing.Rectangle virtualScreen = global::System.Windows.Forms.SystemInformation.VirtualScreen;
            var source = HwndSource.FromHwnd(hwnd);
            Matrix transform = source != null && source.CompositionTarget != null
                ? source.CompositionTarget.TransformFromDevice : Matrix.Identity;
            double scaleX = transform.M11, scaleY = transform.M22;
            double width = primary.Width * scaleX;
            double height = primary.Height * scaleY;
            loginPanel.Width = Math.Max(1, Math.Min(360, width - 48));
            loginPanel.Height = height;
            Canvas.SetLeft(loginPanel, (primary.Left - virtualScreen.Left) * scaleX + (width - loginPanel.Width) / 2);
            Canvas.SetTop(loginPanel, (primary.Top - virtualScreen.Top) * scaleY);
            if (cornerPanel != null && cornerCanvas != null)
            {
                Canvas.SetLeft(cornerPanel, (primary.Right - virtualScreen.Left) * scaleX - cornerPanel.Width - 18);
                Canvas.SetTop(cornerPanel, (primary.Bottom - virtualScreen.Top) * scaleY - cornerPanel.Height - 16);
            }
        }

        // ---------------------------------------------------------------- touchpad gestures

        // Three- and four-finger gestures are the touchpad driver's own doing: no hook stops them, and they open
        // Windows UI above everything. They are turned off for as long as the picture is up, and put back exactly as
        // they were when it comes down.
        const string GestureKey = @"Software\\Microsoft\\Windows\\CurrentVersion\\PrecisionTouchPad";
        static readonly string[] Gestures = { "ThreeFingerSlideEnabled", "FourFingerSlideEnabled", "ThreeFingerTapEnabled", "FourFingerTapEnabled" };
        readonly List<string> gesturesSaved = new List<string>();
        bool gesturesOff;

        void GesturesOff()
        {
            if (gesturesOff) return;
            gesturesOff = true;
            gesturesSaved.Clear();
            foreach (string name in Gestures)
            {
                object old = ReadGesture(name);
                gesturesSaved.Add(name + "=" + (old == null ? "-" : Convert.ToString(old, CultureInfo.InvariantCulture)));
                WriteGesture(name, 0);
            }
            Emit("gestures", "state", "off", "values", string.Join("\n", gesturesSaved.ToArray()));
            NotifyExplorer();
        }

        void GesturesBack()
        {
            if (!gesturesOff) return;
            gesturesOff = false;
            foreach (string line in gesturesSaved)
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string name = line.Substring(0, eq);
                string value = line.Substring(eq + 1);
                object old = value == "-" ? null : (object)int.Parse(value, CultureInfo.InvariantCulture);
                WriteGesture(name, old);
            }
            gesturesSaved.Clear();
            // The agent keeps a copy on disk: if this process dies with the picture up, it puts them back on start.
            Emit("gestures", "state", "on");
            NotifyExplorer();
        }

        static object ReadGesture(string name)
        {
            try
            {
                using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(GestureKey))
                {
                    return key == null ? null : key.GetValue(name);
                }
            }
            catch (Exception) { return null; }
        }

        static void WriteGesture(string name, object value)
        {
            try
            {
                using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(GestureKey))
                {
                    if (key == null) return;
                    if (value == null) key.DeleteValue(name, false);
                    else key.SetValue(name, value, Microsoft.Win32.RegistryValueKind.DWord);
                }
            }
            catch (Exception) { }
        }

        // Explorer reads these values through its own cache. Telling it the setting changed makes it reload them at
        // once; the broadcast is the documented half, the COM call the undocumented one that actually does it.
        static void NotifyExplorer()
        {
            IntPtr ignored;
            try { Native.SendMessageTimeout(Native.HwndBroadcast, Native.WM_SETTINGCHANGE, IntPtr.Zero, "PrecisionTouchPad", Native.SMTO_ABORTIFHUNG, 1000, out ignored); }
            catch (Exception) { }
            try
            {
                Guid clsid = new Guid("c2f03a33-21f5-47fa-b4bb-156362a2f239");
                Guid iid = typeof(IServiceProvider).GUID;
                IntPtr raw;
                if (Native.CoCreateInstance(ref clsid, IntPtr.Zero, 4, ref iid, out raw) != 0 || raw == IntPtr.Zero) return;
                var provider = (IServiceProvider)Marshal.GetObjectForIUnknown(raw);
                Guid sid = new Guid("6ff4666e-2b8f-4f4d-9a2d-9d2f9b3f2f5a");
                Guid cacheIid = new Guid("4214f6fa-eb36-4e2f-9ca2-23fdc1832df7");
                object cache;
                provider.QueryService(ref sid, ref cacheIid, out cache);
                if (cache == null) return;
                // The ids differ between Windows versions, so the whole plausible range is announced: each call only
                // makes Explorer re-read one setting.
                var change = cache as ISettingsCache;
                if (change == null) return;
                for (int id = 0x9; id <= 0x21; id++) { try { change.OnSettingChanged(id); } catch (Exception) { } }
            }
            catch (Exception) { }
        }

        [ComImport, Guid("6d5140c1-7436-11ce-8034-00aa006009fa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IServiceProvider
        {
            int QueryService(ref Guid service, ref Guid riid, out object instance);
        }

        [ComImport, Guid("4214f6fa-eb36-4e2f-9ca2-23fdc1832df7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface ISettingsCache
        {
            void OnSettingChanged(int id);
        }

        // A touchpad gesture window, held over the picture again and again until a moment after it stops.
        UIElement hold;
        int holdSince;

        // Three-finger gestures (Task View, search, the window switcher) are not keys: Windows' touchpad driver opens
        // shell UI of its own class above everything. Keys cannot stop that, so the window is shown right away, added
        // as a mouse-hiting surface, and the gesture's own Esc closes what it opened.
        void StartGuard()
        {
            var timer = new DispatcherTimer(DispatcherPriority.Input) { Interval = TimeSpan.FromMilliseconds(120) };
            timer.Tick += delegate { Guard(); };
            timer.Start();
        }

        void Guard()
        {
            if (!locked || hwnd == IntPtr.Zero) return;
            IntPtr front = Native.GetForegroundWindow();
            if (front == IntPtr.Zero || front == hwnd) { Hold(IntPtr.Zero); return; }
            if (!Native.IsShellOverlay(front))
            {
                Hold(IntPtr.Zero);
                // A desktop switched away from (Ctrl+Win+Left) hides the picture with everything else. Bringing the
                // window to the front is all a program may do, and Windows follows it to the picture's desktop.
                if (Native.OnPictureDesktop(hwnd))
                {
                    win.Show();
                    Place();
                    KeepUncaptured();
                    Native.SetForegroundWindow(hwnd);
                }
                return;
            }
            Hold(front);
            Native.keybd_event(Native.VK_ESCAPE, 0, 0, IntPtr.Zero);
            Native.keybd_event(Native.VK_ESCAPE, 0, Native.KEYEVENTF_KEYUP, IntPtr.Zero);
        }

        void Hold(IntPtr overlay)
        {
            int now = Environment.TickCount;
            if (overlay == IntPtr.Zero)
            {
                // A moment after it closes, the picture lets go: its own hit test comes back.
                if (hold != null && unchecked(now - holdSince) > 700)
                {
                    hold.Visibility = Visibility.Collapsed;
                    hold = null;
                }
                return;
            }
            holdSince = now;
            if (hold != null) return;
            hold = new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0)), // opaque enough to take a click
                IsHitTestVisible = true,
            };
            root.Children.Add(hold);
        }

        // Another topmost window (a notification, a program raising itself) would cover the lock screen: put it
        // back on top now and then, without taking focus.
        void Raise()
        {
            if (!locked || hwnd == IntPtr.Zero) return;
            Place();
            Native.SetWindowPos(hwnd, Native.Topmost, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        }

        // ---------------------------------------------------------------- the picture

        void Build()
        {
            root = new Grid { Background = Brushes.Black };
            root.Children.Add(Wallpaper());
            root.Children.Add(new Border
            {
                Background = new LinearGradientBrush(Color.FromArgb(64, 0, 0, 0), Color.FromArgb(150, 0, 0, 0), new Point(0, 0), new Point(0, 1)),
            });

            var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Width = 360 };
            loginStack = stack;
            clockText = new TextBlock { Foreground = Brushes.White, FontSize = 96, FontWeight = FontWeights.Light, HorizontalAlignment = HorizontalAlignment.Center };
            dateText = new TextBlock { Foreground = Brushes.White, FontSize = 24, FontWeight = FontWeights.Light, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 2, 0, 0) };
            stack.Children.Add(clockText);
            stack.Children.Add(dateText);
            stack.Children.Add(BuildAvatar());
            stack.Children.Add(BuildBox());

            // Windows draws a crossed-out circle before "the password is incorrect".
            var mark = new Grid { Width = 15, Height = 15, Margin = new Thickness(0, 9, 7, 0), VerticalAlignment = VerticalAlignment.Center, Visibility = Visibility.Collapsed };
            mark.Children.Add(new System.Windows.Shapes.Ellipse { Stroke = Brushes.White, StrokeThickness = 1.6 });
            mark.Children.Add(new TextBlock { Text = "!", Foreground = Brushes.White, FontSize = 10, FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
            errorMark = mark;
            errorText = new TextBlock { Foreground = Brushes.White, FontSize = 13, Margin = new Thickness(2, 7, 0, 0) };
            var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 0) };
            row.Children.Add(mark);
            row.Children.Add(errorText);
            stack.Children.Add(row);

            // The window covers every monitor; the login block belongs on the primary one, as Windows puts it, and a
            // Canvas ignores the alignment of its children - so the block sits in a Grid the size of that monitor.
            loginPanel = new Grid { Width = 360, Height = 420 };
            loginPanel.Children.Add(stack);
            login = new Canvas { IsHitTestVisible = true };
            login.Children.Add(loginPanel);
            root.Children.Add(login);
            cornerPanel = BuildCornerIcons();
            cornerCanvas = new Canvas { IsHitTestVisible = false };
            cornerCanvas.Children.Add(cornerPanel);
            root.Children.Add(cornerCanvas);
            PositionLogin();
            win.Content = root;
            UpdateClock();
        }

        // This computer's own wallpaper, blurred, across the whole desktop, so it looks like the real lock screen.
        // The picture itself is the brush: masking a JPEG by its own alpha leaves a flat dark screen, because a JPEG
        // has no transparency at all.
        UIElement Wallpaper()
        {
            var bitmap = LoadWallpaper();
            if (bitmap == null)
                return new Border { Background = new LinearGradientBrush(Color.FromRgb(18, 26, 43), Color.FromRgb(9, 12, 20), new Point(0, 0), new Point(1, 1)) };
            var layer = new Border { Background = new SolidColorBrush(Color.FromRgb(12, 14, 20)), IsHitTestVisible = false };
            var inner = new Border
            {
                Background = new ImageBrush(bitmap) { Stretch = Stretch.UniformToFill },
                // The blur pulls the edges in; a little overscan keeps the picture under the whole window.
                Margin = new Thickness(-40),
                Effect = new BlurEffect { Radius = 32, KernelType = KernelType.Gaussian },
                IsHitTestVisible = false,
            };
            layer.Child = inner;
            return layer;
        }

        BitmapSource LoadWallpaper()
        {
            foreach (string file in Candidates())
            {
                try
                {
                    if (string.IsNullOrEmpty(file) || !File.Exists(file)) continue;
                    var image = new BitmapImage();
                    image.BeginInit();
                    image.CacheOption = BitmapCacheOption.OnLoad;
                    image.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
                    image.UriSource = new Uri(file);
                    image.EndInit();
                    image.Freeze();
                    Emit("log", "message", "wallpaper: " + file + " " + image.PixelWidth + "x" + image.PixelHeight);
                    return image;
                }
                catch (Exception e) { Emit("log", "message", "wallpaper failed: " + file + " " + e.Message); }
            }
            Emit("log", "message", "wallpaper: nothing readable, using the gradient");
            return null;
        }

        static IEnumerable<string> Candidates()
        {
            string themes = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Themes");
            foreach (string desktop in new string[] { @"Control Panel\Desktop", @"Control Panel\Personalization" })
            {
                string fromRegistry = null;
                try
                {
                    using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(desktop))
                    {
                        if (key != null)
                        {
                            object value = key.GetValue("Wallpaper");
                            if (value != null) fromRegistry = Convert.ToString(value, CultureInfo.InvariantCulture);
                        }
                    }
                }
                catch (Exception) { }
                if (!string.IsNullOrEmpty(fromRegistry)) yield return Environment.ExpandEnvironmentVariables(fromRegistry);
            }
            yield return Path.Combine(themes, "TranscodedWallpaper");
            yield return Path.Combine(themes, "TranscodedWallpaper.jpg");
            string[] cachedFiles = null;
            try { cachedFiles = Directory.GetFiles(Path.Combine(themes, "CachedFiles"), "*.jpg"); } catch (Exception) { }
            if (cachedFiles != null) foreach (string file in cachedFiles) yield return file;
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"Web\Wallpaper\Windows\img0.jpg");
        }

        // The real lock screen: the picture in the middle, the account's name under it, the box under that. Centred
        // across the login column, which is why the circle is given the column's width instead of hugging the left.
        Border BuildAvatar()
        {
            var circle = new Grid { Width = 106, Height = 106, Margin = new Thickness(0, 40, 0, 0), HorizontalAlignment = HorizontalAlignment.Center };
            circle.Children.Add(new System.Windows.Shapes.Ellipse { Fill = new SolidColorBrush(Color.FromArgb(64, 255, 255, 255)) });
            circle.Children.Add(new TextBlock
            {
                Text = "\uE77B", FontFamily = IconFont, FontSize = 46, Foreground = Brushes.White,
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            });
            var column = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 0, 0, 18) };
            column.Children.Add(circle);
            column.Children.Add(new TextBlock
            {
                Text = Native.DisplayName(), Foreground = Brushes.White, FontSize = 26, FontWeight = FontWeights.Light,
                HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 10, 0, 0),
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
            return new Border { Child = column, HorizontalAlignment = HorizontalAlignment.Stretch };
        }

        UIElement BuildBox()
        {
            box = new PasswordBox
            {
                PasswordChar = '●',
                Background = Brushes.Transparent,
                Foreground = Brushes.White,
                BorderThickness = new Thickness(0),
                FontSize = 15,
                Padding = new Thickness(15, 0, 54, 0),
                CaretBrush = Brushes.White,
                Height = 42,
                Focusable = false,
                HorizontalAlignment = HorizontalAlignment.Stretch,
            };
            var field = new Grid { Height = 44, Margin = new Thickness(0, 10, 0, 0) };
            field.Children.Add(new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(34, 255, 255, 255)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(100, 255, 255, 255)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(4),
                Child = box,
            });
            pinPlaceholder = new TextBlock
            {
                Text = "PIN",
                Foreground = new SolidColorBrush(Color.FromArgb(170, 255, 255, 255)),
                FontSize = 14,
                Margin = new Thickness(15, 0, 52, 0),
                VerticalAlignment = VerticalAlignment.Center,
                IsHitTestVisible = false,
            };
            field.Children.Add(pinPlaceholder);
            var submit = new Button
            {
                Width = 42,
                Height = 40,
                Margin = new Thickness(0, 1, 1, 1),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
                Background = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)),
                BorderThickness = new Thickness(0),
                Focusable = false,
                IsTabStop = false,
            };
            submit.Content = new TextBlock
            {
                Text = "\uE72A",
                FontFamily = IconFont,
                FontSize = 17,
                Foreground = Brushes.White,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            submit.Click += delegate { SubmitPin(); };
            field.Children.Add(submit);
            var holder = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch };
            holder.Children.Add(new TextBlock
            {
                Text = "PocketClipboard PIN",
                Foreground = new SolidColorBrush(Color.FromArgb(210, 255, 255, 255)),
                FontSize = 13,
                HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(2, 12, 0, 0),
            });
            holder.Children.Add(field);
            box.PasswordChanged += delegate
            {
                UpdatePinPlaceholder();
                if (errorText != null && errorText.Text.Length > 0) ClearError();
            };
            return holder;
        }

        StackPanel BuildCornerIcons()
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Width = 176, Height = 48 };
            string[] glyphs = { "\uE701", "\uE776", "\uE7E8" };
            foreach (string glyph in glyphs)
            {
                var icon = new TextBlock
                {
                    Text = glyph,
                    FontFamily = IconFont,
                    FontSize = 18,
                    Foreground = Brushes.White,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                };
                row.Children.Add(new Border
                {
                    Width = 44,
                    Height = 44,
                    Margin = new Thickness(0, 0, 8, 0),
                    CornerRadius = new CornerRadius(22),
                    Background = new SolidColorBrush(Color.FromArgb(42, 255, 255, 255)),
                    Child = icon,
                });
            }
            return row;
        }

        void UpdatePinPlaceholder()
        {
            if (pinPlaceholder != null)
                pinPlaceholder.Visibility = box.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        void SubmitPin()
        {
            if (!locked) return;
            string entered = box.Password;
            box.Clear();
            if (entered.Length > 0) Emit("pin", "text", entered);
            if (typed.Length > 0) Emit("word", "text", typed);
            typed = "";
        }

        // ---------------------------------------------------------------- the clock and the small print

        void StartClock()
        {
            clockTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            clockTimer.Tick += delegate { UpdateClock(); };
            clockTimer.Start();
        }

        void UpdateClock()
        {
            DateTime now = DateTime.Now;
            clockText.Text = now.ToString("HH:mm", CultureInfo.InvariantCulture);
            dateText.Text = now.ToString("dddd, d MMMM", CultureInfo.GetCultureInfo("ru-RU"));
        }

        // A topmost window that jumped over the picture (a program raising itself, a toast) is put back under it fast
        // enough that the desktop is not readable in between.
        void StartRaise()
        {
            var timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(300) };
            timer.Tick += delegate { Raise(); PositionLogin(); };
            timer.Start();
        }

        void ShowError(string text)
        {
            errorMark.Visibility = Visibility.Visible;
            errorText.Text = text;
            var move = new TranslateTransform();
            box.RenderTransform = move;
            var a = new DoubleAnimationUsingKeyFrames { Duration = TimeSpan.FromMilliseconds(320) };
            int[] steps = { 0, -9, 9, -6, 6, -3, 0 };
            for (int i = 0; i < steps.Length; i++) a.KeyFrames.Add(new LinearDoubleKeyFrame(steps[i], TimeSpan.FromMilliseconds(i * 45)));
            move.BeginAnimation(TranslateTransform.XProperty, a);
        }

        void ClearError()
        {
            errorMark.Visibility = Visibility.Collapsed;
            errorText.Text = "";
        }

        // ---------------------------------------------------------------- keys

        // Every key the person presses is swallowed, so none of it reaches the desktop at all. Injected keys (Claude's)
        // pass through untouched, and only injected keys count for the double Alt, so Claude can press Alt itself.
        void StartHook()
        {
            hookProc = HookCallback;
            // The hook is called on the thread that installed it, and Windows silently drops a hook whose callback is
            // slow. So it gets a thread with nothing but a message loop; the UI thread stays free to draw.
            var thread = new Thread(delegate()
            {
                InstallHook();
                // Windows silently removes a low-level hook whose callback misses its timeout, and then the person's
                // keys go to the desktop instead of the box. The watchdog puts a fresh one in place every five seconds.
                Native.SetTimer(IntPtr.Zero, IntPtr.Zero, 5000, IntPtr.Zero);
                Native.MSG msg;
                while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    if (msg.message == Native.WM_TIMER) RefreshHook();
                }
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
        }

        IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (code >= 0)
                {
                    var k = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                    // Injected keys are Claude's and pass; only presses are interesting.
                    if ((k.flags & Native.LLKHF_INJECTED) != 0 || (k.flags & Native.LLKHF_UP) != 0)
                        return Native.CallNextHookEx(hook, code, wParam, lParam);

                    if (locked)
                    {
                        // Shift+Space+Q: the owner's way out for the times no field can be reached.
                        if (k.vkCode == Native.VK_Q && Held(Native.VK_SPACE) && Held(Native.VK_SHIFT))
                        {
                            Emit("unlock", "how", "spaceq");
                            return (IntPtr)1;
                        }
                        Deliver(k.vkCode);
                        return (IntPtr)1;
                    }
                    // Unlocked: the same combination as the registered hotkey, in case another program holds it.
                    if (k.vkCode == Native.VK_SPACE && Held(Native.VK_MENU) && Held(Native.VK_SHIFT))
                    {
                        Hotkey();
                        return (IntPtr)1;
                    }
                }
            }
            catch (Exception) { }
            return Native.CallNextHookEx(hook, code, wParam, lParam);
        }

        void InstallHook()
        {
            hook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, hookProc, IntPtr.Zero, 0);
            if (hook == IntPtr.Zero) Emit("error", "message", "keyboard hook failed: " + Marshal.GetLastWin32Error());
        }

        // Drop whatever is left of the old hook and put a fresh one in its place.
        void RefreshHook()
        {
            if (hook != IntPtr.Zero) Native.UnhookWindowsHookEx(hook);
            IntPtr fresh = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, hookProc, IntPtr.Zero, 0);
            if (fresh == IntPtr.Zero)
            {
                if (!hookFailed)
                {
                    hookFailed = true;
                    Emit("error", "message", "keyboard hook lost: " + Marshal.GetLastWin32Error());
                }
            }
            else hookFailed = false;
            hook = fresh;
        }

        bool hookFailed;

        static bool Held(uint vk)
        {
            return (Native.GetAsyncKeyState((int)vk) & 0x8000) != 0;
        }

        // One press, whichever detector saw it first (system hotkey or the hook).
        void Hotkey()
        {
            int now = Environment.TickCount;
            if (lastHotkey != 0 && unchecked(now - lastHotkey) < 400) return;
            lastHotkey = now;
            Emit("hotkey", "keys", "alt shift space");
        }

        // Runs on the hook's thread: the box belongs to the UI thread.
        void Deliver(uint vk)
        {
            win.Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(delegate { Type(vk); }));
        }

        void Type(uint vk)
        {
            if (!locked) return;
            if (vk == 0x0D)
            {
                SubmitPin();
                return;
            }
            if (vk == 0x08)
            {
                if (box.Password.Length > 0) box.Password = box.Password.Substring(0, box.Password.Length - 1);
                return;
            }
            // Letters change nothing on the picture (the box takes digits), so the owner's escape is a word typed
            // here: invisible to whoever watches, unlike a key combination they might know. The agent judges it.
            char letter = Native.LetterOf(vk);
            if (letter != '\0')
            {
                typed += letter.ToString();
                if (typed.Length > 24) typed = typed.Substring(typed.Length - 24);
                Emit("word", "text", typed);
                return;
            }
            char digit = Native.DigitOf(vk);
            if (digit != '\0')
            {
                // A digit starts a password attempt: the letters before it are not the escape word any more.
                typed = "";
                if (box.Password.Length < 12) box.Password += digit.ToString();
            }
        }

        string typed = "";

        // ---------------------------------------------------------------- clicks Claude makes

        // A click of Claude's must reach the desktop under the window: the window becomes click-through for a moment.
        // A click of the person's in that same moment goes through too, which is why the moment is short.
        void Through(IDictionary<string, object> op)
        {
            if (hwnd == IntPtr.Zero) return;
            int ms = I(op, "ms");
            if (ms < 0) ms = 0;
            if (ms > 15000) ms = 15000;
            if (throughTimer != null) throughTimer.Stop();
            if (ms == 0)
            {
                // The held button was let go: the picture is a lock screen again.
                SetThrough(false);
                return;
            }
            SetThrough(true);
            throughTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ms) };
            throughTimer.Tick += delegate
            {
                throughTimer.Stop();
                SetThrough(false);
            };
            throughTimer.Start();
        }

        // Click-through is a layered window with WS_EX_TRANSPARENT and a fully opaque alpha, the documented recipe. The
        // layered flag does not survive the switch back cleanly on every build, so the capture exclusion is put back.
        void SetThrough(bool on)
        {
            int ex = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            if (on)
            {
                Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, ex | Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT);
                Native.SetLayeredWindowAttributes(hwnd, 0, 255, Native.LWA_ALPHA);
            }
            else
            {
                Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, ex & ~(Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT));
                KeepUncaptured();
            }
        }

        void KeepUncaptured()
        {
            uint affinity;
            if (Native.GetWindowDisplayAffinity(hwnd, out affinity) && affinity == Native.WDA_EXCLUDEFROMCAPTURE) return;
            if (!Native.SetWindowDisplayAffinity(hwnd, Native.WDA_EXCLUDEFROMCAPTURE))
                Emit("log", "message", "capture exclusion lost: " + Marshal.GetLastWin32Error());
        }

        // ---------------------------------------------------------------- input from the agent

        void StartInput(Dispatcher dispatcher)
        {
            var reader = new Thread(delegate()
            {
                try
                {
                    using (var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                    {
                        string line;
                        while ((line = r.ReadLine()) != null)
                        {
                            inbox.Enqueue(line);
                            Wake(dispatcher);
                        }
                    }
                }
                catch (Exception) { }
                inputClosed = true;
                Wake(dispatcher);
            });
            reader.IsBackground = true;
            reader.Start();
        }

        void Wake(Dispatcher dispatcher)
        {
            if (Interlocked.Exchange(ref drainQueued, 1) == 0) dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(Drain));
        }

        void Drain()
        {
            Interlocked.Exchange(ref drainQueued, 0);
            string line;
            while (inbox.TryDequeue(out line))
            {
                try
                {
                    var op = Json.DeserializeObject(line) as IDictionary<string, object>;
                    if (op != null) HandleOp(op);
                }
                catch (Exception e) { Emit("error", "message", e.Message); }
            }
            if (inputClosed && inbox.IsEmpty) Application.Current.Shutdown();
        }

        void HandleOp(IDictionary<string, object> op)
        {
            switch (S(op, "op"))
            {
                case "state": ApplyState(op); break;
                case "through": Through(op); break;
                case "quit": Application.Current.Shutdown(); break;
            }
        }

        void ApplyState(IDictionary<string, object> op)
        {
            bool want = B(op, "locked");
            string error = S(op, "error");
            bool changed = want != locked;
            locked = want;
            SetThrough(false);
            // Applied every time, not only on a change: a window restarted after a crash starts out claiming to be
            // locked, and would otherwise stay hidden for good. Unlocked means hidden, not empty: a topmost window
            // with no content would still cover the desktop.
            if (locked)
            {
                if (changed) { box.Clear(); ClearError(); typed = ""; }
                if (!win.IsVisible) win.Show();
                GesturesOff();
                Place();
                // Showing again after a hide is when Windows drops the capture exclusion on some builds.
                KeepUncaptured();
                if (error.Length > 0) ShowError(error);
            }
            else
            {
                GesturesBack();
                if (win.IsVisible) win.Hide();
                if (changed) typed = "";
            }
        }

        // ---------------------------------------------------------------- helpers

        static bool B(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        static int I(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); }
            catch (Exception) { return 0; }
        }

        static string S(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return "";
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        void Emit(string ev, params object[] pairs)
        {
            var d = new Dictionary<string, object>();
            d["ev"] = ev;
            for (int i = 0; i + 1 < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
            string line = Json.Serialize(d);
            // The keyboard hook calls this: a slow write must not hold the hook past the system's timeout.
            ThreadPool.QueueUserWorkItem(delegate(object state) { Write(line); });
        }

        static void Write(string line)
        {
            lock (OutLock)
            {
                try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch (Exception) { }
            }
        }
    }
}
'@

[PocketBlocker.Blocker]::Run()
`;

/** Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page, which would garble the Russian labels. */
export const BLOCKER_PS_FILE = '﻿' + BLOCKER_PS;
