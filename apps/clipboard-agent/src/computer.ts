import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ComputerAction, ComputerResult } from '@pocket/protocol';
import { keyCode, parseKeys } from './keys.js';

/** Computer use on this machine: one step at a time, in physical desktop pixels. */
export interface ComputerBackend {
  act(action: ComputerAction): Promise<ComputerResult>;
  /** The kill switch: drops queued steps, ends the one in flight and lets go of every key and button. */
  release(): void;
  close(): void;
}

/** Screenshot size that suits computer use: big enough to read, small enough for quick turns. */
export const SHOT_MAX = { width: 1280, height: 800 };
export const ZOOM_MAX = { width: 1600, height: 1200 };

/** What the PowerShell host reads, one JSON line per step. Key names are already codes here. */
export type HostCommand =
  | { op: 'screenshot'; display: number; maxWidth: number; maxHeight: number; settleMs: number; peek?: boolean }
  | { op: 'zoom'; x: number; y: number; width: number; height: number; maxWidth: number; maxHeight: number }
  | { op: 'move'; x: number; y: number }
  | { op: 'click'; x: number; y: number; at: boolean; button: string; count: number; mods: number[]; modNames: string[] }
  | { op: 'button'; button: string; down: boolean }
  | { op: 'drag'; path: number[]; button: string }
  | { op: 'scroll'; x: number; y: number; at: boolean; dx: number; dy: number; mods: number[]; modNames: string[] }
  | { op: 'type'; text: string }
  | { op: 'keys'; combos: number[][]; holdMs: number; names: string[][] }
  | { op: 'cursor' }
  | { op: 'windows' }
  | { op: 'window'; handle: string; what: string }
  | { op: 'open'; target: string; args: string }
  | { op: 'release' };

const mods = (names: readonly string[] | undefined) => (names ?? []).map((n) => keyCode(n));
const at = (x: number | undefined, y: number | undefined) => x !== undefined && y !== undefined;
const keyNames = (text: string): string[][] => text.trim().split(/\s+/).filter(Boolean).map((combo) => combo.split(/\+(?!$)/));

export function hostCommand(a: ComputerAction): HostCommand {
  switch (a.action) {
    case 'screenshot':
      return { op: 'screenshot', display: a.display ?? -1, maxWidth: a.maxWidth ?? SHOT_MAX.width, maxHeight: a.maxHeight ?? SHOT_MAX.height, settleMs: a.settleMs ?? 0 };
    case 'zoom':
      return { op: 'zoom', x: a.x, y: a.y, width: a.width, height: a.height, maxWidth: a.maxWidth ?? ZOOM_MAX.width, maxHeight: a.maxHeight ?? ZOOM_MAX.height };
    case 'move':
      return { op: 'move', x: a.x, y: a.y };
    case 'click':
      return { op: 'click', x: a.x ?? 0, y: a.y ?? 0, at: at(a.x, a.y), button: a.button, count: a.count, mods: mods(a.modifiers), modNames: [...(a.modifiers ?? [])] };
    case 'button':
      return { op: 'button', button: a.button, down: a.down };
    case 'drag':
      return { op: 'drag', path: a.path.flat(), button: a.button ?? 'left' };
    case 'scroll':
      return { op: 'scroll', x: a.x ?? 0, y: a.y ?? 0, at: at(a.x, a.y), dx: a.dx, dy: a.dy, mods: mods(a.modifiers), modNames: [...(a.modifiers ?? [])] };
    case 'type':
      return { op: 'type', text: a.text };
    case 'key':
      return { op: 'keys', combos: parseKeys(a.keys), holdMs: a.holdMs ?? 0, names: keyNames(a.keys) };
    case 'cursor':
      return { op: 'cursor' };
    case 'windows':
      return { op: 'windows' };
    case 'window':
      return { op: 'window', handle: a.handle, what: a.op };
    case 'open':
      return { op: 'open', target: a.target, args: a.args ?? '' };
    case 'release':
      return { op: 'release' };
  }
}

/** How long a step may take before the host is presumed stuck and restarted. */
export function timeoutFor(c: HostCommand): number {
  if (c.op === 'type') return 10_000 + c.text.length * 20;
  if (c.op === 'keys') return 10_000 + c.combos.length * (c.holdMs + 100);
  if (c.op === 'drag') return 10_000 + c.path.length * 200;
  if (c.op === 'screenshot') return 20_000 + c.settleMs;
  return 20_000;
}

/**
 * How long the stub lock screen must step aside for each kind of step: undefined when the step cannot hit it, 0 when the
 * window has to become opaque again right away. The time covers the step itself: each click holds the button for a
 * moment, a scroll goes notch by notch, a drag pauses at both ends.
 */
export function throughMsFor(c: HostCommand): number | undefined {
  switch (c.op) {
    case 'click':
      return 300 + 110 * Math.max(1, c.count);
    // A held button must stay click-through until it is let go, or the release lands on the lock screen.
    case 'button':
      return c.down ? 15_000 : 400;
    case 'scroll':
      return 400 + 25 * (Math.abs(c.dx) + Math.abs(c.dy));
    case 'drag':
      return 900 + 600 * Math.max(1, c.path.length / 2 - 1);
    case 'release':
      return 0;
    // A screenshot taken while the window is stepped aside could catch it: make it opaque (and so uncapturable) first.
    case 'screenshot':
    case 'zoom':
      return 0;
    default:
      return undefined;
  }
}

/**
 * The host: Windows PowerShell 5.1 with a C# helper compiled once by Add-Type (C# 5: no newer syntax), then a loop
 * of JSON lines. Per-monitor DPI awareness keeps every coordinate in physical pixels. ASCII only and no backticks:
 * PowerShell reads a BOM-less file in the ANSI code page, and this lives in a template literal.
 */
export const COMPUTER_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PocketComputer {
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  const uint WHEEL = 0x0800, HWHEEL = 0x1000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
  const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;
  const int EXT = 0x100, CHAR = 0x10000;
  const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_RETURN = 0x0D, VK_TAB = 0x09, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }

  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] static extern IntPtr GetLastActivePopup(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int needed);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanEx(char ch, IntPtr layout);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

  struct KeyCode { public ushort Vk; public bool Ext; public KeyCode(ushort vk, bool ext) { Vk = vk; Ext = ext; } }
  class Display { public RECT R; public bool Primary; public double Scale; }
  /** A thinned-out copy of a picture of the screen, to tell whether and where two moments differ. */
  class Frame { public int Step; public int Cols; public int Rows; public int[] V; }

  static ImageCodecInfo jpeg;
  /** The last picture sent of each display, to say what changed since. */
  static Dictionary<string, Frame> frames = new Dictionary<string, Frame>();
  /** The screen never stood still the last time it was waited for: a video or an animation is playing. */
  static bool restless;
  static int selfElevated = -1;

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
    try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
  }

  static string Q(string s) {
    StringBuilder b = new StringBuilder(s.Length + 2);
    b.Append('"');
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c == '\n') b.Append("\\n");
      else if (c == '\r') b.Append("\\r");
      else if (c == '\t') b.Append("\\t");
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static string Text(string s) { return "{\"text\":" + Q(s) + "}"; }

  static bool Until(Func<bool> test, int ms) {
    Stopwatch watch = Stopwatch.StartNew();
    while (true) {
      if (test()) return true;
      if (watch.ElapsedMilliseconds >= ms) return false;
      Thread.Sleep(25);
    }
  }

  static List<Display> Displays() {
    List<Display> list = new List<Display>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr h, IntPtr hdc, IntPtr rect, IntPtr data) {
      MONITORINFOEX info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (GetMonitorInfo(h, ref info)) {
        Display m = new Display();
        m.R = info.rcMonitor;
        m.Primary = (info.dwFlags & 1) != 0;
        m.Scale = 1.0;
        try {
          uint dx, dy;
          if (GetDpiForMonitor(h, 0, out dx, out dy) == 0 && dx > 0) m.Scale = dx / 96.0;
        } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
        list.Add(m);
      }
      return true;
    }, IntPtr.Zero);
    list.Sort(delegate(Display a, Display b) {
      if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
      if (a.R.Left != b.R.Left) return a.R.Left.CompareTo(b.R.Left);
      return a.R.Top.CompareTo(b.R.Top);
    });
    if (list.Count == 0) throw new InvalidOperationException("No display found");
    return list;
  }

  static string DisplaysJson(List<Display> list) {
    StringBuilder b = new StringBuilder("[");
    for (int i = 0; i < list.Count; i++) {
      RECT r = list[i].R;
      if (i > 0) b.Append(',');
      b.Append("{\"index\":").Append(i).Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
        .Append(",\"width\":").Append(r.Right - r.Left).Append(",\"height\":").Append(r.Bottom - r.Top)
        .Append(",\"primary\":").Append(list[i].Primary ? "true" : "false")
        .Append(",\"scale\":").Append(list[i].Scale.ToString("0.###", CultureInfo.InvariantCulture)).Append('}');
    }
    return b.Append(']').ToString();
  }

  static int DisplayOf(List<Display> list, int x, int y) {
    for (int i = 0; i < list.Count; i++) {
      RECT r = list[i].R;
      if (x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom) return i;
    }
    return -1;
  }

  static string CursorJson() {
    POINT p;
    GetCursorPos(out p);
    return "{\"x\":" + p.X + ",\"y\":" + p.Y + "}";
  }

  public static string Cursor() { return "{\"cursor\":" + CursorJson() + "}"; }

  static string Jpeg(Bitmap bmp) {
    if (jpeg == null) foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
    using (EncoderParameters p = new EncoderParameters(1)) {
      p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
      using (MemoryStream ms = new MemoryStream()) {
        bmp.Save(ms, jpeg, p);
        return Convert.ToBase64String(ms.ToArray());
      }
    }
  }

  static void DrawCursor(Graphics g, int ox, int oy) {
    CURSORINFO ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
    int hx = 0, hy = 0;
    ICONINFO ii;
    if (GetIconInfo(ci.hCursor, out ii)) {
      hx = ii.xHotspot;
      hy = ii.yHotspot;
      if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
      if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
    }
    IntPtr hdc = g.GetHdc();
    try { DrawIconEx(hdc, ci.pt.X - ox - hx, ci.pt.Y - oy - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); } finally { g.ReleaseHdc(hdc); }
  }

  /** The part of the desktop at x,y,w,h as it is this moment, without the pointer. */
  static Bitmap Grab(int x, int y, int w, int h) {
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    try {
      // .NET Framework rejects SourceCopy | CaptureBlt as an undefined CopyPixelOperation value: plain SourceCopy only.
      using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      return bmp;
    } catch (Win32Exception e) {
      bmp.Dispose();
      throw new InvalidOperationException("Windows did not let the screen be read (" + e.Message + "): the lock screen, a UAC prompt or a protected window is in front");
    } catch (Exception) {
      bmp.Dispose();
      throw;
    }
  }

  /** Every third pixel of every third row, each row shifted by one, so a thin line cannot hide between the samples. */
  static Frame Thin(Bitmap bmp) {
    Frame f = new Frame();
    f.Step = (long)bmp.Width * bmp.Height > 3000000 ? 4 : 3;
    f.Cols = (bmp.Width + f.Step - 1) / f.Step;
    f.Rows = (bmp.Height + f.Step - 1) / f.Step;
    f.V = new int[f.Cols * f.Rows];
    BitmapData d = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      byte[] line = new byte[Math.Abs(d.Stride)];
      int n = 0;
      for (int r = 0; r < f.Rows; r++) {
        Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)(r * f.Step) * d.Stride), line, 0, line.Length);
        int shift = r % f.Step;
        for (int c = 0; c < f.Cols; c++) {
          int o = Math.Min(bmp.Width - 1, c * f.Step + shift) * 3;
          f.V[n++] = line[o] | (line[o + 1] << 8) | (line[o + 2] << 16);
        }
      }
    } finally { bmp.UnlockBits(d); }
    return f;
  }

  static bool Alike(Frame a, Frame b) { return a != null && b != null && a.Step == b.Step && a.Cols == b.Cols && a.Rows == b.Rows; }

  /** How many samples differ clearly between two frames; box gets the samples' bounds as left, top, right, bottom. */
  static int Differ(Frame a, Frame b, int[] box) {
    int n = 0, x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
    for (int i = 0; i < a.V.Length; i++) {
      int p = a.V[i], q = b.V[i];
      if (p == q) continue;
      if (Math.Abs((p & 0xFF) - (q & 0xFF)) <= 24 && Math.Abs(((p >> 8) & 0xFF) - ((q >> 8) & 0xFF)) <= 24 && Math.Abs(((p >> 16) & 0xFF) - ((q >> 16) & 0xFF)) <= 24) continue;
      n++;
      int x = i % a.Cols, y = i / a.Cols;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (box != null) { box[0] = x0; box[1] = y0; box[2] = x1; box[3] = y1; }
    return n;
  }

  /** Whether the screen changed between two frames by more than a blinking caret or a clock digit. */
  static bool Moved(Frame a, Frame b) { return !Alike(a, b) || Differ(a, b, null) > a.V.Length / 4000; }

  /** What changed since the last picture: the share of the screen and the box around it, in pixels of the picture sent. */
  static string ChangeJson(Frame a, Frame b, double k) {
    int[] box = new int[4];
    int n = Differ(a, b, box);
    string s = ",\"change\":{\"fraction\":" + ((double)n / a.V.Length).ToString("0.#####", CultureInfo.InvariantCulture);
    if (n > 0) {
      int x = (int)(box[0] * a.Step * k), y = (int)(box[1] * a.Step * k);
      int right = (int)Math.Ceiling((box[2] + 1) * a.Step * k), bottom = (int)Math.Ceiling((box[3] + 1) * a.Step * k);
      s += ",\"box\":{\"x\":" + x + ",\"y\":" + y + ",\"width\":" + Math.Max(1, right - x) + ",\"height\":" + Math.Max(1, bottom - y) + "}";
    }
    return s + "}";
  }

  /** A picture of the desktop from x,y with the pointer drawn in, shrunk to fit maxW x maxH; k is how much it shrank. */
  static string Encode(Bitmap full, int x, int y, int maxW, int maxH, out double k) {
    int w = full.Width, h = full.Height;
    using (Graphics g = Graphics.FromImage(full)) DrawCursor(g, x, y);
    k = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / h));
    int ow = Math.Max(1, (int)Math.Round(w * k));
    int oh = Math.Max(1, (int)Math.Round(h * k));
    string data;
    if (ow == w && oh == h) {
      data = Jpeg(full);
    } else {
      using (Bitmap small = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
        using (Graphics g2 = Graphics.FromImage(small)) {
          g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g2.DrawImage(full, 0, 0, ow, oh);
        }
        data = Jpeg(small);
      }
    }
    return "\"image\":{\"mime\":\"image/jpeg\",\"dataBase64\":\"" + data + "\",\"width\":" + ow + ",\"height\":" + oh + "}"
      + ",\"region\":{\"x\":" + x + ",\"y\":" + y + ",\"width\":" + w + ",\"height\":" + h + "}";
  }

  /**
   * A picture of one display. With settleMs it first waits, at most that long, for the screen to stand still: what a
   * step set off may take a moment to show and to finish, and a picture taken in between misleads.
   */
  public static string Screenshot(int display, int maxW, int maxH, int settleMs) {
    List<Display> mons = Displays();
    int i = display < 0 ? 0 : display;
    if (i >= mons.Count) throw new ArgumentException("There is no display " + display + ": this computer has " + mons.Count + ".");
    RECT r = mons[i].R;
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    string key = r.Left + "," + r.Top + "," + w + "," + h;
    Frame before;
    frames.TryGetValue(key, out before);
    Bitmap shot = Grab(r.Left, r.Top, w, h);
    try {
      Frame now = Thin(shot);
      string settled = "";
      if (settleMs > 0) {
        // A video never stops: do not spend the whole wait on it every time.
        int limit = restless ? Math.Min(settleMs, 600) : settleMs;
        int grace = Math.Min(limit, 500);
        bool reacted = before == null || Moved(before, now);
        bool still = false;
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < limit) {
          Thread.Sleep(100);
          Bitmap next = Grab(r.Left, r.Top, w, h);
          Frame latest = Thin(next);
          bool same = !Moved(now, latest);
          shot.Dispose();
          shot = next;
          now = latest;
          if (!reacted && Moved(before, now)) reacted = true;
          // Nothing has reacted yet: give it the grace period before taking the picture as it is.
          if (same && (reacted || watch.ElapsedMilliseconds >= grace)) { still = true; break; }
        }
        restless = !still;
        settled = ",\"settled\":" + (still ? "true" : "false");
      }
      double k;
      string picture = Encode(shot, r.Left, r.Top, maxW, maxH, out k);
      string change = Alike(before, now) ? ChangeJson(before, now, k) : "";
      frames[key] = now;
      return "{" + picture + change + settled + ",\"displays\":" + DisplaysJson(mons) + ",\"cursor\":" + CursorJson() + "}";
    } finally { shot.Dispose(); }
  }

  public static string Zoom(int x, int y, int w, int h, int maxW, int maxH) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int left = Math.Max(vx, x), top = Math.Max(vy, y);
    int right = Math.Min(vx + vw, x + w), bottom = Math.Min(vy + vh, y + h);
    if (right - left < 4 || bottom - top < 4) throw new ArgumentException("That region is outside the screen");
    using (Bitmap shot = Grab(left, top, right - left, bottom - top)) {
      double k;
      return "{" + Encode(shot, left, top, maxW, maxH, out k) + ",\"cursor\":" + CursorJson() + "}";
    }
  }

  static void Send(params INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows blocked the input: a window running as administrator, a UAC prompt or the lock screen is in front");
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = dx;
    i.u.mi.dy = dy;
    i.u.mi.mouseData = data;
    i.u.mi.dwFlags = flags;
    return i;
  }

  static INPUT Key(ushort vk, bool up, bool ext) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i.u.ki.dwFlags = (up ? KEY_UP : 0) | (ext ? KEY_EXTENDED : 0);
    return i;
  }

  static INPUT Unicode(char c, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = KEY_UNICODE | (up ? KEY_UP : 0);
    return i;
  }

  /** Whether a process runs as administrator. One that does drops input from one that does not, without any error. */
  static bool Elevated(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return false;
    try {
      IntPtr t;
      if (!OpenProcessToken(p, 8, out t)) return false;
      try {
        int on, needed;
        return GetTokenInformation(t, 20, out on, 4, out needed) && on != 0;
      } finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
  }

  /** Throws when the window is out of this helper's reach, so a click that Windows would drop is not reported as done. */
  static void Reachable(IntPtr h) {
    if (h == IntPtr.Zero) return;
    if (selfElevated < 0) selfElevated = Elevated((uint)Process.GetCurrentProcess().Id) ? 1 : 0;
    if (selfElevated == 1) return;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0 || !Elevated(pid)) return;
    throw new InvalidOperationException("That window runs as administrator, and Windows keeps PocketClipboard's mouse and keyboard out of it. The user has to do this step, or start PocketClipboard as administrator.");
  }

  static IntPtr Under() {
    POINT p;
    return GetCursorPos(out p) ? WindowFromPoint(p) : IntPtr.Zero;
  }

  static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    Send(Mouse(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny, 0));
    SetCursorPos(x, y);
  }

  /** Moves the pointer and makes sure it got there: a click somewhere else must not pass for a click at x,y. */
  static void Park(int x, int y) {
    MoveTo(x, y);
    POINT p;
    for (int i = 0; i < 3; i++) {
      if (GetCursorPos(out p) && Math.Abs(p.X - x) <= 1 && Math.Abs(p.Y - y) <= 1) return;
      Thread.Sleep(15);
      SetCursorPos(x, y);
    }
    if (GetCursorPos(out p) && (Math.Abs(p.X - x) > 2 || Math.Abs(p.Y - y) > 2))
      throw new InvalidOperationException("The pointer did not go to " + x + "," + y + " (it is at " + p.X + "," + p.Y + "): a full-screen program, a remote session or the lock screen is holding it");
  }

  static uint ButtonFlag(string button, bool down) {
    if (button == "right") return down ? RIGHTDOWN : RIGHTUP;
    if (button == "middle") return down ? MIDDLEDOWN : MIDDLEUP;
    return down ? LEFTDOWN : LEFTUP;
  }

  static bool IsExtended(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == VK_LWIN || vk == VK_RWIN || vk == 0x5D || vk == 0xA3 || vk == 0xA5 || vk == 0x90 || vk == 0x6F;
  }

  /** The key a character sits on in the US layout, 0x100 added when it takes Shift; -1 for any other character. */
  static int UsKey(char ch) {
    string plain = "\u0060-=[]\\;',./", shifted = "~_+{}|:\"<>?";
    int[] vks = { 0xC0, 0xBD, 0xBB, 0xDB, 0xDD, 0xDC, 0xBA, 0xDE, 0xBC, 0xBE, 0xBF };
    int i = plain.IndexOf(ch);
    if (i >= 0) return vks[i];
    i = shifted.IndexOf(ch);
    if (i >= 0) return vks[i] | 0x100;
    i = ")!@#$%^&*(".IndexOf(ch);
    if (i >= 0) return (0x30 + i) | 0x100;
    return -1;
  }

  static List<KeyCode> Resolve(int[] codes) {
    List<KeyCode> keys = new List<KeyCode>();
    if (codes == null) return keys;
    uint pid;
    IntPtr layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), out pid));
    // With ctrl, alt or the Windows key a character is a shortcut, and programs know shortcuts by the US key, whatever layout is on.
    bool shortcut = false;
    foreach (int c in codes) {
      int vk = c & 0xFF;
      if ((c & CHAR) == 0 && (vk == VK_CONTROL || vk == VK_MENU || vk == VK_LWIN || vk == VK_RWIN || (vk >= 0xA2 && vk <= 0xA5))) shortcut = true;
    }
    foreach (int c in codes) {
      if ((c & CHAR) == 0) { keys.Add(new KeyCode((ushort)(c & 0xFF), (c & EXT) != 0)); continue; }
      char ch = (char)(c & 0xFFFF);
      int us = UsKey(ch);
      int r = shortcut && us >= 0 ? us : VkKeyScanEx(ch, layout);
      if (r == -1) r = us;
      if (r == -1) throw new ArgumentException("The keyboard layout in use has no key for '" + ch + "'; type it as text instead");
      int state = (r >> 8) & 0xFF;
      if ((state & 1) != 0) AddOnce(keys, VK_SHIFT);
      if ((state & 2) != 0) AddOnce(keys, VK_CONTROL);
      if ((state & 4) != 0) AddOnce(keys, VK_MENU);
      keys.Add(new KeyCode((ushort)(r & 0xFF), false));
    }
    return keys;
  }

  static void AddOnce(List<KeyCode> keys, ushort vk) {
    foreach (KeyCode k in keys) if (k.Vk == vk) return;
    keys.Add(new KeyCode(vk, false));
  }

  /** Presses keys in order; down fills as they go, so the caller can lift exactly those when one of them fails. */
  static void Press(int[] codes, List<KeyCode> down) {
    foreach (KeyCode k in Resolve(codes)) {
      Send(Key(k.Vk, false, k.Ext));
      down.Add(k);
      Thread.Sleep(10);
    }
  }

  static void Lift(List<KeyCode> down) {
    for (int i = down.Count - 1; i >= 0; i--) {
      try { Send(Key(down[i].Vk, true, down[i].Ext)); } catch (Win32Exception) { }
      Thread.Sleep(5);
    }
  }

  /** Lets go of a modifier a step that was cut short left down: it would turn the next click or text into shortcuts. */
  static void Calm() {
    int[] mods = { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, VK_LWIN, VK_RWIN };
    foreach (int vk in mods) {
      if ((GetAsyncKeyState(vk) & 0x8000) == 0) continue;
      try { Send(Key((ushort)vk, true, IsExtended(vk))); } catch (Win32Exception) { }
    }
  }

  public static string Move(int x, int y) {
    Park(x, y);
    return Cursor();
  }

  public static string Click(int x, int y, bool at, string button, int count, int[] mods) {
    Calm();
    if (at) { Park(x, y); Thread.Sleep(60); }
    Reachable(Under());
    List<KeyCode> held = new List<KeyCode>();
    try {
      Press(mods, held);
      int n = Math.Max(1, Math.Min(3, count));
      for (int i = 0; i < n; i++) {
        if (i > 0) Thread.Sleep(80);
        Send(Mouse(ButtonFlag(button, true), 0, 0, 0));
        // Held for a moment: some programs miss a button that goes down and up in the same instant.
        Thread.Sleep(35);
        Send(Mouse(ButtonFlag(button, false), 0, 0, 0));
      }
    } finally { Lift(held); }
    return Cursor();
  }

  public static string Button(string button, bool down) {
    if (down) Reachable(Under());
    Send(Mouse(ButtonFlag(button, down), 0, 0, 0));
    return Cursor();
  }

  public static string Drag(int[] path, string button) {
    if (path == null || path.Length < 4) throw new ArgumentException("A drag needs a start and an end point");
    Calm();
    Park(path[0], path[1]);
    Thread.Sleep(60);
    Reachable(Under());
    Send(Mouse(ButtonFlag(button, true), 0, 0, 0));
    try {
      // Programs tell a drag from a click by a held button that then moves, and a drop by a pause over the target.
      Thread.Sleep(80);
      int cx = path[0], cy = path[1];
      for (int i = 2; i + 1 < path.Length; i += 2) {
        int tx = path[i], ty = path[i + 1];
        double dist = Math.Sqrt((double)(tx - cx) * (tx - cx) + (double)(ty - cy) * (ty - cy));
        int steps = Math.Max(4, Math.Min(40, (int)(dist / 20)));
        for (int s = 1; s <= steps; s++) {
          MoveTo(cx + (tx - cx) * s / steps, cy + (ty - cy) * s / steps);
          Thread.Sleep(12);
        }
        cx = tx;
        cy = ty;
      }
      Thread.Sleep(120);
    } finally { Send(Mouse(ButtonFlag(button, false), 0, 0, 0)); }
    return Cursor();
  }

  public static string Scroll(int x, int y, bool at, int dx, int dy, int[] mods) {
    Calm();
    if (at) { Park(x, y); Thread.Sleep(40); }
    Reachable(Under());
    List<KeyCode> held = new List<KeyCode>();
    try {
      Press(mods, held);
      for (int i = 0; i < Math.Abs(dy); i++) { Send(Mouse(WHEEL, 0, 0, unchecked((uint)(dy > 0 ? -120 : 120)))); Thread.Sleep(20); }
      for (int i = 0; i < Math.Abs(dx); i++) { Send(Mouse(HWHEEL, 0, 0, unchecked((uint)(dx > 0 ? 120 : -120)))); Thread.Sleep(20); }
    } finally { Lift(held); }
    return Cursor();
  }

  public static string TypeText(string text) {
    Calm();
    Reachable(GetForegroundWindow());
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == '\r') {
        if (i + 1 < text.Length && text[i + 1] == '\n') continue;
        c = '\n';
      }
      if (c == '\n') Send(Key(VK_RETURN, false, false), Key(VK_RETURN, true, false));
      else if (c == '\t') Send(Key(VK_TAB, false, false), Key(VK_TAB, true, false));
      else if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) {
        // The two halves of an emoji go in together, or a program may show them as two broken characters.
        char low = text[++i];
        Send(Unicode(c, false), Unicode(c, true), Unicode(low, false), Unicode(low, true));
      } else Send(Unicode(c, false), Unicode(c, true));
      Thread.Sleep(c == '\n' ? 40 : 8);
    }
    return Cursor();
  }

  public static string Keys(int[] codes, int holdMs) {
    Calm();
    List<KeyCode> held = new List<KeyCode>();
    try {
      Press(codes, held);
      Thread.Sleep(holdMs > 0 ? holdMs : 40);
    } finally { Lift(held); }
    return Cursor();
  }

  static string ClassOf(IntPtr h) {
    StringBuilder b = new StringBuilder(256);
    GetClassName(h, b, b.Capacity);
    return b.ToString();
  }

  static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len <= 0) return "";
    StringBuilder b = new StringBuilder(len + 1);
    GetWindowText(h, b, b.Capacity);
    return b.ToString();
  }

  static string ProcessName(uint pid) {
    try { using (Process p = Process.GetProcessById((int)pid)) return p.ProcessName; } catch (ArgumentException) { } catch (InvalidOperationException) { } catch (Win32Exception) { }
    return "";
  }

  /** A window a person can switch to: what the taskbar and Alt+Tab show. */
  static bool Listed(IntPtr h) {
    if (!IsWindowVisible(h)) return false;
    int style = GetWindowLong(h, -20);
    if ((style & 0x80) != 0) return false;
    // An owned window is a dialog of its owner, unless it asks for a taskbar button of its own.
    if (GetWindow(h, 4) != IntPtr.Zero && (style & 0x40000) == 0) return false;
    try {
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
    } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
    if (GetWindowTextLength(h) <= 0) return false;
    // The desktop itself lists as "Program Manager".
    return ClassOf(h) != "Progman";
  }

  static List<IntPtr> TopWindows() {
    List<IntPtr> all = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { all.Add(h); return true; }, IntPtr.Zero);
    List<IntPtr> shown = new List<IntPtr>();
    foreach (IntPtr h in all) if (Listed(h)) shown.Add(h);
    return shown;
  }

  public static string Windows() {
    IntPtr front = GetForegroundWindow();
    List<Display> mons = Displays();
    StringBuilder b = new StringBuilder("{\"windows\":[");
    bool first = true;
    foreach (IntPtr h in TopWindows()) {
      RECT r;
      GetWindowRect(h, out r);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string proc = ProcessName(pid);
      if (proc == "ApplicationFrameHost") {
        // A Store app's window belongs to a host process; the app itself owns the part inside it.
        IntPtr core = FindWindowEx(h, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
        uint inner = 0;
        if (core != IntPtr.Zero) GetWindowThreadProcessId(core, out inner);
        string real = inner != 0 && inner != pid ? ProcessName(inner) : "";
        if (real.Length > 0) proc = real;
      }
      bool minimized = IsIconic(h);
      int display = minimized ? -1 : DisplayOf(mons, (r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2);
      if (!first) b.Append(',');
      first = false;
      b.Append("{\"handle\":").Append(Q(h.ToInt64().ToString(CultureInfo.InvariantCulture)))
        .Append(",\"title\":").Append(Q(Title(h))).Append(",\"process\":").Append(Q(proc))
        .Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
        .Append(",\"width\":").Append(Math.Max(0, r.Right - r.Left)).Append(",\"height\":").Append(Math.Max(0, r.Bottom - r.Top))
        .Append(",\"minimized\":").Append(minimized ? "true" : "false").Append(",\"maximized\":").Append(IsZoomed(h) ? "true" : "false")
        .Append(",\"focused\":").Append(InFront(h, front) ? "true" : "false");
      if (display >= 0) b.Append(",\"display\":").Append(display);
      b.Append('}');
    }
    return b.Append("],\"displays\":").Append(DisplaysJson(mons)).Append('}').ToString();
  }

  /** The window is in front when it is the foreground window or owns it (a Save box in front of its editor). */
  static bool InFront(IntPtr h, IntPtr front) {
    for (int i = 0; i < 12 && front != IntPtr.Zero; i++) {
      if (front == h) return true;
      front = GetWindow(front, 4);
    }
    return false;
  }

  static bool WaitFront(IntPtr h, int ms) {
    return Until(delegate() { return InFront(h, GetForegroundWindow()); }, ms);
  }

  /** Brings a window to the front and says whether it got there: Windows refuses background programs more often than not. */
  static bool Focus(IntPtr h) {
    if (IsIconic(h)) { ShowWindowAsync(h, 9); Until(delegate() { return !IsIconic(h); }, 800); }
    if (InFront(h, GetForegroundWindow())) return true;
    // A window with a dialog open is disabled: the dialog is the one to activate.
    IntPtr target = GetLastActivePopup(h);
    if (target == IntPtr.Zero || !IsWindowVisible(target)) target = h;
    // Windows lets the process behind the last input set the foreground window: an empty mouse event is that input.
    try { Send(Mouse(MOVE, 0, 0, 0)); } catch (Win32Exception) { }
    SetForegroundWindow(target);
    if (WaitFront(h, 250)) return true;
    uint pid;
    uint frontThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    if (frontThread != 0 && frontThread != me && AttachThreadInput(me, frontThread, true)) {
      try { BringWindowToTop(target); SetForegroundWindow(target); } finally { AttachThreadInput(me, frontThread, false); }
    }
    if (WaitFront(h, 250)) return true;
    // A synthetic Alt press lifts the lock that keeps background processes from taking the foreground.
    try {
      Send(Key(VK_MENU, false, false));
      SetForegroundWindow(target);
      Send(Key(VK_MENU, true, false));
    } catch (Win32Exception) { }
    if (WaitFront(h, 250)) return true;
    // What Alt+Tab itself does.
    SwitchToThisWindow(target, true);
    return WaitFront(h, 400);
  }

  const string FRONT = "The window is now in front.";
  const string NOT_FRONT = "Windows did not bring the window to the front; click on it or on its taskbar button instead.";

  public static string Window(long handle, string what) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) throw new ArgumentException("That window no longer exists; list the windows again");
    string text;
    if (what == "focus") text = Focus(h) ? FRONT : NOT_FRONT;
    else if (what == "minimize") {
      ShowWindowAsync(h, 6);
      text = Until(delegate() { return IsIconic(h); }, 800) ? "Minimized." : "The window did not minimize.";
    } else if (what == "maximize") {
      ShowWindowAsync(h, 3);
      bool full = Until(delegate() { return IsZoomed(h); }, 800);
      bool front = Focus(h);
      text = (full ? "Maximized." : "The window did not maximize; it may have a fixed size.") + (front ? "" : " " + NOT_FRONT);
    } else if (what == "restore") {
      // Restoring is asked for, not done on the spot: wait until the window has left the state it was in.
      bool wasMinimized = IsIconic(h), wasMaximized = IsZoomed(h);
      ShowWindowAsync(h, 9);
      Until(delegate() { return wasMinimized ? !IsIconic(h) : !wasMaximized || !IsZoomed(h); }, 800);
      text = Focus(h) ? "Restored." : "Restored. " + NOT_FRONT;
    } else if (what == "close") {
      PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
      bool gone = Until(delegate() { return !IsWindow(h) || !IsWindowVisible(h); }, 1500);
      text = gone ? "Closed." : "Asked the window to close; it is still open, maybe asking to save.";
    } else throw new ArgumentException("Unknown window operation: " + what);
    return Text(text);
  }

  // A program the shell cannot find by name (not on PATH, e.g. "telegram") is looked up among the Start menu shortcuts.
  static string StartMenuShortcut(string name) {
    string want = name.Trim().ToLowerInvariant();
    if (want.Length == 0 || want.IndexOfAny(new char[] { '\\', '/', ':' }) >= 0) return null;
    string best = null;
    int bestRank = int.MaxValue;
    string[] roots = { Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu) };
    foreach (string root in roots) {
      if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) continue;
      string[] links;
      try { links = Directory.GetFiles(root, "*.lnk", SearchOption.AllDirectories); } catch (Exception) { continue; }
      foreach (string link in links) {
        string n = Path.GetFileNameWithoutExtension(link).ToLowerInvariant();
        if (n.Contains("uninstall")) continue;
        int rank = n == want ? 0 : n.StartsWith(want) ? 1 : n.Contains(want) ? 2 : -1;
        if (rank < 0) continue;
        rank = rank * 1000 + n.Length;
        if (rank < bestRank) { bestRank = rank; best = link; }
      }
    }
    return best;
  }

  /**
   * Starts a program, file, folder or address and sees its window to the front. A program started from the
   * background opens behind the others, and from a picture without it the same thing gets opened twice.
   */
  public static string Open(string target, string args) {
    target = Environment.ExpandEnvironmentVariables(target);
    List<IntPtr> before = TopWindows();
    IntPtr front = GetForegroundWindow();
    // The process behind the last input may pass the foreground on: what starts now can come to the front by itself.
    try { Send(Mouse(MOVE, 0, 0, 0)); } catch (Win32Exception) { }
    AllowSetForegroundWindow(-1);
    string started;
    try {
      started = StartTarget(target, args);
    } catch (Win32Exception e) {
      string link = e.NativeErrorCode == 2 ? StartMenuShortcut(target) : null;
      if (link == null) throw new ArgumentException("Could not open " + target + ": " + e.Message);
      try {
        started = StartTarget(link, args);
      } catch (Win32Exception e2) {
        throw new ArgumentException("Could not open " + target + ": " + e2.Message);
      }
    }
    IntPtr fresh = IntPtr.Zero;
    Until(delegate() {
      foreach (IntPtr h in TopWindows()) if (!before.Contains(h)) { fresh = h; return true; }
      // A program that was already running answers by bringing its own window forward.
      IntPtr now = GetForegroundWindow();
      return now != front && before.Contains(now);
    }, 4000);
    if (fresh != IntPtr.Zero) {
      Thread.Sleep(150);
      if (IsWindow(fresh)) return Text(started + " Its window \"" + Title(fresh) + "\" " + (Focus(fresh) ? "is in front." : "is open but not in front: focus_window it."));
    }
    IntPtr top = GetForegroundWindow();
    if (top != front && top != IntPtr.Zero && Title(top).Length > 0) return Text(started + " \"" + Title(top) + "\" came to the front.");
    return Text(started + " No new window has appeared yet: wait and look again, or find it with list_windows, rather than opening it twice.");
  }

  static string StartTarget(string target, string args) {
    ProcessStartInfo info = new ProcessStartInfo(target);
    if (!string.IsNullOrEmpty(args)) info.Arguments = args;
    info.UseShellExecute = true;
    info.WindowStyle = ProcessWindowStyle.Normal;
    info.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    using (Process p = Process.Start(info)) {
      return p != null ? "Started " + target + " (process " + p.Id + ")." : "Opened " + target + ".";
    }
  }

  public static string ReleaseAll() {
    // Every key Windows still counts as down; 0x10 to 0x12 are shift, ctrl and alt without a side, which their left and right codes cover.
    for (int vk = 0x08; vk <= 0xFE; vk++) {
      if (vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU) continue;
      if ((GetAsyncKeyState(vk) & 0x8000) == 0) continue;
      try { Send(Key((ushort)vk, true, IsExtended(vk))); } catch (Win32Exception) { }
    }
    int[] buttons = { 0x01, 0x02, 0x04 };
    uint[] ups = { LEFTUP, RIGHTUP, MIDDLEUP };
    for (int i = 0; i < buttons.Length; i++) {
      if ((GetAsyncKeyState(buttons[i]) & 0x8000) == 0) continue;
      try { Send(Mouse(ups[i], 0, 0, 0)); } catch (Win32Exception) { }
    }
    return "{\"text\":\"Let go of all keys and mouse buttons.\"}";
  }
}
'@
[PocketComputer]::Init()

function Num($v, $d) { if ($null -eq $v) { return $d }; return [int]$v }
function Codes($v) { if ($null -eq $v) { return ,([int[]]@()) }; return ,([int[]]@($v)) }

# A Store app (Calculator, Settings, WhatsApp) has no program file or shortcut to start: its Start menu entry does it.
function Find-StartApp([string]$name) {
  $want = $name.Trim().ToLowerInvariant()
  if ($want.Length -eq 0 -or $want.IndexOfAny([char[]]'\/:') -ge 0) { return $null }
  try { $apps = @(Get-StartApps) } catch { return $null }
  $best = $null
  $bestRank = [int]::MaxValue
  foreach ($a in $apps) {
    $n = ([string]$a.Name).ToLowerInvariant()
    if ($n.Contains('uninstall')) { continue }
    $rank = -1
    if ($n -eq $want) { $rank = 0 } elseif ($n.StartsWith($want)) { $rank = 1 } elseif ($n.Contains($want)) { $rank = 2 }
    if ($rank -lt 0) { continue }
    $rank = $rank * 1000 + $n.Length
    if ($rank -lt $bestRank) { $bestRank = $rank; $best = $a }
  }
  return $best
}

function Invoke-Op($c) {
  switch ([string]$c.op) {
    'screenshot' { return [PocketComputer]::Screenshot((Num $c.display -1), (Num $c.maxWidth 1280), (Num $c.maxHeight 800), (Num $c.settleMs 0)) }
    'zoom' { return [PocketComputer]::Zoom([int]$c.x, [int]$c.y, [int]$c.width, [int]$c.height, (Num $c.maxWidth 1600), (Num $c.maxHeight 1200)) }
    'move' { return [PocketComputer]::Move([int]$c.x, [int]$c.y) }
    'click' { return [PocketComputer]::Click((Num $c.x 0), (Num $c.y 0), [bool]$c.at, [string]$c.button, (Num $c.count 1), (Codes $c.mods)) }
    'button' { return [PocketComputer]::Button([string]$c.button, [bool]$c.down) }
    'drag' { return [PocketComputer]::Drag((Codes $c.path), [string]$c.button) }
    'scroll' { return [PocketComputer]::Scroll((Num $c.x 0), (Num $c.y 0), [bool]$c.at, (Num $c.dx 0), (Num $c.dy 0), (Codes $c.mods)) }
    'type' { return [PocketComputer]::TypeText([string]$c.text) }
    'keys' {
      $out = $null
      foreach ($combo in @($c.combos)) {
        $out = [PocketComputer]::Keys((Codes $combo), (Num $c.holdMs 0))
        Start-Sleep -Milliseconds 40
      }
      return $out
    }
    'cursor' { return [PocketComputer]::Cursor() }
    'windows' { return [PocketComputer]::Windows() }
    'window' { return [PocketComputer]::Window([long]$c.handle, [string]$c.what) }
    'open' {
      try {
        return [PocketComputer]::Open([string]$c.target, [string]$c.args)
      } catch {
        $app = Find-StartApp ([string]$c.target)
        if ($null -eq $app) { throw }
        return [PocketComputer]::Open('shell:AppsFolder\' + [string]$app.AppID, '')
      }
    }
    'release' { return [PocketComputer]::ReleaseAll() }
    default { throw ('Unknown operation: ' + $c.op) }
  }
}

function Send-Line([string]$s) {
  [Console]::Out.WriteLine($s)
  [Console]::Out.Flush()
}

Send-Line '{"ready":true}'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = [int]$req.id
    $json = Invoke-Op $req.cmd
    Send-Line ('{"id":' + $id + ',"ok":true,"result":' + $json + '}')
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Send-Line ('{"id":' + $id + ',"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$e.Message) -Compress) + '}')
  }
}
`;

const POWERSHELL = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File'] };
const START_TIMEOUT_MS = 60_000;

type Pending = { resolve: (r: ComputerResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Keeps the PowerShell host running and feeds it one step at a time. */
export class ComputerHost implements ComputerBackend {
  private child: ChildProcess | undefined;
  private starting: Promise<ChildProcess> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by release(): steps queued before it are dropped. */
  private epoch = 0;
  private inFlight = 0;
  private used = false;
  private closed = false;
  private lettingGo = false;

  constructor(
    private readonly opts: {
      /** Path of the host script; the caller writes COMPUTER_PS there. */
      script: string;
      log: (m: string) => void;
      /** The stub lock screen, when one is up: a click or drag has to step aside for it to reach the desktop. */
      blocker?: () => { locked(): boolean; through(ms: number): void } | undefined;
      /** Linux also steps aside for the keyboard grab and for screenshots; Windows uses throughMsFor. */
      throughFor?: (command: HostCommand) => number | undefined;
      /** X11 grab release is asynchronous and needs a little longer than the Windows click-through switch. */
      throughDelayMs?: number;
      spawn?: typeof nodeSpawn;
      shell?: { command: string; args: string[] };
      /** What the helper runs with instead of this process's environment: a per-chat desktop passes its own display here. */
      env?: NodeJS.ProcessEnv;
      /**
       * The signal that ends a helper which is only being replaced (a step was stopped, or took too long), where the
       * helper tells that apart from the end of everything, which is always SIGTERM. Without it both are SIGTERM.
       */
      restartSignal?: NodeJS.Signals;
    },
  ) {}

  /** A step is running right now. */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  /**
   * A picture for someone looking in. It waits its turn behind the steps, but the helper leaves its "what changed
   * since the last screenshot" bookkeeping alone, so the agent's next screenshot still compares with its own last one.
   */
  peek(): Promise<ComputerResult> {
    const step = () => this.call({ op: 'screenshot', display: -1, maxWidth: SHOT_MAX.width, maxHeight: SHOT_MAX.height, settleMs: 0, peek: true }, 20_000);
    const run = this.chain.then(step, step);
    this.chain = run.catch(() => undefined);
    return run;
  }

  act(action: ComputerAction): Promise<ComputerResult> {
    const epoch = this.epoch;
    const step = async (): Promise<ComputerResult> => {
      if (epoch !== this.epoch) throw new Error('Stopped by the user.');
      const cmd = hostCommand(action);
      // The lock screen covers the desktop: a click of Claude's would land on the picture instead.
      const blocker = this.opts.blocker?.();
      let aside = false;
      if (blocker?.locked()) {
        const ms = (this.opts.throughFor ?? throughMsFor)(cmd);
        if (ms !== undefined) {
          blocker.through(ms);
          aside = ms > 0;
          // The window has to be click-through (or opaque again) before the input goes in, not after.
          await new Promise((r) => setTimeout(r, this.opts.throughDelayMs ?? 90));
          if (epoch !== this.epoch) throw new Error('Stopped by the user.');
        }
      }
      this.inFlight++;
      try {
        return await this.call(cmd, timeoutFor(cmd));
      } finally {
        this.inFlight--;
        // A picture needs the lock out of the way only until it is taken: the time asked for was the longest it may
        // wait for the screen, and the desktop must not stay in plain sight for the rest of it.
        if (aside && (cmd.op === 'screenshot' || cmd.op === 'zoom')) blocker?.through(0);
      }
    };
    const run = this.chain.then(step, step);
    this.chain = run.catch(() => undefined);
    return run;
  }

  release(): void {
    this.epoch++;
    const blocker = this.opts.blocker?.();
    if (blocker?.locked()) blocker.through(0);
    if (!this.used) return;
    // A step in flight may be typing a long text; ending the host stops it at once, a fresh one lets go of the keys.
    if (this.inFlight > 0) this.stopChild('stopped by the user');
    // Once the host is closing nobody is left to hold a key: a release cut short by that is not worth a line.
    void this.call({ op: 'release' }, 20_000).catch((e: Error) => !this.closed && this.opts.log(`computer: release failed: ${e.message}`));
  }

  close(): void {
    this.closed = true;
    this.stopChild('PocketClipboard is closing');
  }

  private call(cmd: HostCommand, timeoutMs: number): Promise<ComputerResult> {
    return this.ensure().then(
      (child) =>
        new Promise<ComputerResult>((resolve, reject) => {
          const id = this.nextId++;
          const timer = setTimeout(() => {
            if (!this.pending.delete(id)) return;
            reject(new Error('The computer did not finish the step in time'));
            this.stopChild(`step ${cmd.op} timed out`);
            if (cmd.op !== 'release') this.letGo();
          }, timeoutMs);
          this.pending.set(id, { resolve, reject, timer });
          child.stdin?.write(`${JSON.stringify({ id, cmd })}\n`);
        }),
    );
  }

  private ensure(): Promise<ChildProcess> {
    if (this.closed) return Promise.reject(new Error('PocketClipboard is closing'));
    if (this.child && !this.starting) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.used = true;
    const spawn = this.opts.spawn ?? nodeSpawn;
    const shell = this.opts.shell ?? POWERSHELL;
    const child = spawn(shell.command, [...shell.args, this.opts.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(this.opts.env ? { env: this.opts.env } : {}) });
    this.child = child;
    let errors = '';
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The computer control helper did not start'));
        this.stopChild('start timed out');
      }, START_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not start ${shell.command}: ${e.message}`));
      });
      child.stdin?.on('error', () => {});
      child.stderr && createInterface({ input: child.stderr }).on('line', (line) => {
        if (!line.trim()) return;
        errors = `${errors}${line.trim()}\n`.slice(-2000);
        this.opts.log(`computer: ${line.trim()}`);
      });
      child.stdout &&
        createInterface({ input: child.stdout }).on('line', (raw) => {
          const line = raw.replace(/^\uFEFF/, '').trim();
          if (!line) return;
          let msg: { ready?: boolean; id?: number; ok?: boolean; result?: ComputerResult; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            this.opts.log(`computer: ${line.slice(0, 200)}`);
            return;
          }
          if (msg.ready) {
            clearTimeout(timer);
            if (this.child === child) this.starting = undefined;
            resolve(child);
            return;
          }
          const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (!p || msg.id === undefined) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result ?? {});
          else p.reject(new Error(msg.error || 'The step failed'));
        });
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Not stopped on purpose: it crashed, and a step it was in the middle of may have left a key held.
        const crashedMidStep = this.child === child && this.pending.size > 0;
        if (this.child === child) {
          this.child = undefined;
          this.starting = undefined;
        }
        reject(new Error(`The computer control helper stopped (code ${code})${errors ? `: ${errors.trim().split('\n').pop()}` : ''}`));
        this.failPending(`The computer control helper stopped (code ${code})`);
        if (crashedMidStep) this.letGo();
      });
    });
    return this.starting;
  }

  /** A helper that died mid-step may have left a key or a mouse button held down: a fresh one lets go of them. */
  private letGo(): void {
    if (this.closed || this.lettingGo) return;
    this.lettingGo = true;
    void this.call({ op: 'release' }, 20_000)
      .catch((e: Error) => this.opts.log(`computer: release failed: ${e.message}`))
      .finally(() => {
        this.lettingGo = false;
      });
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private stopChild(reason: string): void {
    const child = this.child;
    if (!child) return;
    this.opts.log(`computer: restarting the helper (${reason})`);
    this.child = undefined;
    this.starting = undefined;
    this.failPending(reason === 'stopped by the user' ? 'Stopped by the user.' : `The computer control helper was restarted: ${reason}`);
    child.kill(this.closed ? 'SIGTERM' : (this.opts.restartSignal ?? 'SIGTERM'));
  }
}
