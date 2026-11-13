#!/usr/bin/env python3
"""Local-owner privacy overlay styled after the Kali/Xfce greeter; not system authentication."""

import getpass
import glob
import io
import json
import os
import queue
import select
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

from computer import displays


OUT_LOCK = threading.Lock()


def emit(event, **values):
    message = {"ev": event}
    message.update(values)
    with OUT_LOCK:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def uri_path(value):
    value = value.strip().strip("'\"")
    if value.startswith("file://"):
        return urllib.parse.unquote(urllib.parse.urlparse(value).path)
    return value


def kde_wallpaper_candidates(home):
    """Reads the active KDE wallpaper plugin, including Smart Video Wallpaper's LastVideo and VideoUrls."""
    config = Path(home) / ".config/plasma-org.kde.plasma.desktop-appletsrc"
    section = ""
    keys = {"lastvideo", "image", "videourls", "wallpapersource", "source", "url", "video", "path"}
    try:
        lines = config.read_text(encoding="utf8", errors="replace").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if line.startswith("["):
            section = line
            continue
        if "[wallpaper]" not in section.lower() or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip().lower() not in keys:
            continue
        if key.strip().lower() == "videourls":
            try:
                entries = json.loads(value)
            except (ValueError, TypeError):
                entries = []
            for entry in entries:
                if isinstance(entry, dict):
                    for field in ("filename", "path", "source", "url"):
                        if entry.get(field):
                            yield uri_path(str(entry[field]))
                            break
        else:
            yield uri_path(value)


def wallpaper_candidates(home=None):
    home = Path(home or Path.home())
    configured = os.environ.get("POCKET_WALLPAPER")
    if configured:
        yield uri_path(configured)
    yield from kde_wallpaper_candidates(home)
    commands = [
        ["xfconf-query", "-c", "xfce4-desktop", "-lv"],
        ["gsettings", "get", "org.gnome.desktop.background", "picture-uri-dark"],
        ["gsettings", "get", "org.gnome.desktop.background", "picture-uri"],
    ]
    for command in commands:
        try:
            proc = subprocess.run(command, text=True, capture_output=True, timeout=5)
            if proc.returncode != 0:
                continue
            for line in proc.stdout.splitlines():
                if command[0] == "xfconf-query":
                    if "last-image" not in line and "image-path" not in line:
                        continue
                    parts = line.split(None, 1)
                    if len(parts) == 2:
                        yield uri_path(parts[1])
                else:
                    yield uri_path(line)
        except (OSError, subprocess.SubprocessError):
            pass
    config = home / ".config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml"
    try:
        tree = ET.parse(str(config))
        for prop in tree.iter("property"):
            if prop.get("name") not in ("last-image", "image-path"):
                continue
            value = prop.get("value")
            if value:
                yield uri_path(value)
    except (OSError, ET.ParseError):
        pass
    for pattern in [
        "/usr/share/backgrounds/kali*/*.jpg", "/usr/share/backgrounds/kali*/*.png",
        "/usr/share/images/desktop-base/*.jpg", "/usr/share/images/desktop-base/*.png",
    ]:
        for name in sorted(glob.glob(pattern)):
            yield name


def find_wallpaper():
    for candidate in wallpaper_candidates():
        if not candidate or not os.path.isfile(candidate):
            continue
        extension = Path(candidate).suffix.lower()
        if extension in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
            return candidate
        if extension == ".xml":
            # Kali sometimes points last-image at a GNOME slideshow XML instead of the actual picture.
            try:
                tree = ET.parse(candidate)
                for element in tree.iter():
                    if element.tag.rsplit("}", 1)[-1] != "filename" or not element.text:
                        continue
                    image = Path(element.text.strip())
                    if not image.is_absolute():
                        image = Path(candidate).parent / image
                    if image.is_file():
                        return str(image)
            except (OSError, ET.ParseError):
                pass
    return None


def find_video_wallpaper():
    if not shutil.which("ffmpeg"):
        return None
    for candidate in wallpaper_candidates():
        if candidate and os.path.isfile(candidate) and Path(candidate).suffix.lower() in (".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"):
            return candidate
    return None


def monitor_signature(monitors):
    return tuple(
        (
            int(monitor.get("index", index)),
            int(monitor.get("x", 0)),
            int(monitor.get("y", 0)),
            int(monitor.get("width", 0)),
            int(monitor.get("height", 0)),
            bool(monitor.get("primary")),
            float(monitor.get("scale", 1.0)),
        )
        for index, monitor in enumerate(monitors)
    )


def login_layout(width, height, scale=1.0):
    width = max(1, int(width))
    height = max(1, int(height))
    try:
        scale = max(0.75, min(2.0, float(scale)))
    except (TypeError, ValueError):
        scale = 1.0
    center = width // 2
    field_width = max(1, min(round(360 * scale), width - round(48 * scale)))
    field_left = center - field_width // 2
    field_right = field_left + field_width
    field_height = max(36, round(48 * scale))
    avatar_size = max(72, round(104 * scale))
    avatar_y = round(height * 0.36)
    password_y = round(height * 0.56)
    error_y = round(height * 0.64)
    return {
        "center_x": center,
        "clock_y": round(height * 0.13),
        "date_y": round(height * 0.22),
        "avatar_y": avatar_y,
        "avatar_size": avatar_size,
        "name_y": round(height * 0.47),
        "pin_label_y": password_y - field_height // 2 - round(18 * scale),
        "field_left": field_left,
        "field_right": field_right,
        "field_width": field_width,
        "field_height": field_height,
        "button_width": max(1, min(round(44 * scale), field_width // 3)),
        "password_y": password_y,
        "error_y": error_y,
        "footer_height": round(44 * scale),
    }


def apply_input_regions(connection, windows, passthrough, shape_api):
    root_id = connection.screen().root.id
    seen = set()
    for window_id, width, height in windows:
        window = connection.create_resource_object("window", int(window_id))
        while window.id != root_id and window.id not in seen:
            seen.add(window.id)
            geometry = window.get_geometry()
            rectangles = [] if passthrough else [(0, 0, int(geometry.width), int(geometry.height))]
            window.shape_rectangles(shape_api.SO.Set, shape_api.SK.Input, 0, 0, 0, rectangles)
            parent = window.query_tree().parent
            if parent.id == root_id:
                break
            window = parent
    connection.sync()


class XInput(threading.Thread):
    """Global hotkey while unlocked; a keyboard grab while the overlay is up."""

    def __init__(self, events):
        super().__init__(daemon=True)
        self.events = events
        self.locked = False
        self.through = False
        self.grabbed = False
        self.hotkeys_grabbed = False
        self.stopping = False
        self.x = None
        self.root = None
        self.pressed = set()
        self.state_lock = threading.Lock()
        self.input_windows = ()
        self.hotkey_keys = []
        self.shape_api = None
        self.applied_input_state = None

    def configure(self, locked, through, windows):
        with self.state_lock:
            self.locked = bool(locked)
            self.through = bool(through)
            self.input_windows = tuple(windows)

    def set_locked(self, locked):
        with self.state_lock:
            self.locked = bool(locked)

    def stop(self):
        self.stopping = True
        self.configure(False, False, ())

    def run(self):
        try:
            from Xlib import X, XK, display
            from Xlib.ext import shape

            self.X = X
            self.XK = XK
            self.shape_api = shape
            self.x = display.Display()
            if not self.x.has_extension("SHAPE"):
                raise RuntimeError("The X11 SHAPE extension is required for non-disruptive input pass-through.")
            self.root = self.x.screen().root
            self.root.change_attributes(event_mask=X.KeyPressMask | X.KeyReleaseMask)
            space = XK.string_to_keysym("space")
            keycode = self.x.keysym_to_keycode(space)
            # KDE/KRunner already owns Alt+Shift+Space; Ctrl+Alt+Space works there as an alternative.
            self.hotkey_mods = (X.ShiftMask | X.Mod1Mask, X.ControlMask | X.Mod1Mask)
            for base in self.hotkey_mods:
                for extra in [0, X.LockMask, X.Mod2Mask, X.LockMask | X.Mod2Mask]:
                    self.hotkey_keys.append((keycode, base | extra))
            self.x.flush()
            while not self.stopping:
                self.sync_input_regions()
                self.sync_grab()
                self.sync_hotkeys()
                select.select([self.x.fileno()], [], [], 0.01)
                while self.x.pending_events():
                    self.handle(self.x.next_event())
            if self.grabbed:
                self.x.ungrab_keyboard(X.CurrentTime)
            if self.hotkeys_grabbed:
                for keycode, modifiers in self.hotkey_keys:
                    self.root.ungrab_key(keycode, modifiers)
            self.x.flush()
        except Exception as error:
            emit("error", message="X11 input: %s" % error)
        finally:
            if self.x is not None:
                try:
                    self.x.close()
                except Exception:
                    pass

    def current_state(self):
        with self.state_lock:
            return self.locked, self.through, self.input_windows

    def sync_input_regions(self):
        _, through, windows = self.current_state()
        state = (through, windows)
        if state == self.applied_input_state:
            return
        if windows:
            try:
                apply_input_regions(self.x, windows, through, self.shape_api)
            except Exception as error:
                emit("error", message="X11 input transparency: %s" % error)
        self.applied_input_state = state

    def sync_grab(self):
        locked, through, _ = self.current_state()
        should_grab = locked and not through
        if should_grab and not self.grabbed:
            status = self.root.grab_keyboard(False, self.X.GrabModeAsync, self.X.GrabModeAsync, self.X.CurrentTime)
            self.grabbed = status == 0
            self.x.flush()
        elif not should_grab and self.grabbed:
            self.x.ungrab_keyboard(self.X.CurrentTime)
            self.x.flush()
            self.grabbed = False
            self.pressed.clear()

    def sync_hotkeys(self):
        locked, through, _ = self.current_state()
        should_grab = not locked and not through
        if should_grab == self.hotkeys_grabbed:
            return
        for keycode, modifiers in self.hotkey_keys:
            if should_grab:
                self.root.grab_key(keycode, modifiers, False, self.X.GrabModeAsync, self.X.GrabModeAsync)
            else:
                self.root.ungrab_key(keycode, modifiers)
        self.x.flush()
        self.hotkeys_grabbed = should_grab

    def handle(self, event):
        X = self.X
        if event.type not in (X.KeyPress, X.KeyRelease):
            return
        keysym = self.x.keycode_to_keysym(event.detail, 0)
        name = self.XK.keysym_to_string(keysym) or ""
        if event.type == X.KeyRelease:
            self.pressed.discard(keysym)
            return
        self.pressed.add(keysym)
        space = self.XK.string_to_keysym("space")
        locked, through, _ = self.current_state()
        if not locked and not through:
            if keysym == space:
                if (event.state & (X.ControlMask | X.Mod1Mask)) == (X.ControlMask | X.Mod1Mask):
                    self.events.put(("x", {"kind": "hotkey", "keys": "ctrl+alt+space"}))
                elif (event.state & (X.ShiftMask | X.Mod1Mask)) == (X.ShiftMask | X.Mod1Mask):
                    self.events.put(("x", {"kind": "hotkey", "keys": "alt+shift+space"}))
            return
        if not locked or through:
            return
        shift_space_q = name.lower() == "q" and (event.state & X.ShiftMask) and space in self.pressed
        if shift_space_q:
            self.events.put(("x", {"kind": "unlock", "how": "spaceq"}))
            return
        if len(name) == 1 and name.isdigit():
            self.events.put(("x", {"kind": "digit", "value": name}))
        elif name.startswith("KP_") and len(name) == 4 and name[-1].isdigit():
            self.events.put(("x", {"kind": "digit", "value": name[-1]}))
        elif len(name) == 1 and "a" <= name.lower() <= "z":
            self.events.put(("x", {"kind": "letter", "value": name.lower()}))
        elif name in ("BackSpace", "\x08") or event.detail == 22:
            self.events.put(("x", {"kind": "backspace"}))
        # keysym_to_string returns a control character for Return on some Xlib versions.
        elif name in ("Return", "KP_Enter", "\r", "\n") or event.detail in (36, 104):
            self.events.put(("x", {"kind": "enter"}))


class VideoWallpaper:
    """Streams the original KDE video wallpaper as scaled RGB frames, only while the overlay is visible."""

    def __init__(self, source, width, height):
        self.source = source
        self.width = width
        self.height = height
        self.size = width * height * 3
        self.frames = queue.Queue(maxsize=1)
        self.process = None
        self.reader = None

    def start(self):
        if self.process is not None:
            return
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", self.source,
            "-vf", "fps=15,scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d" % (self.width, self.height, self.width, self.height),
            "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ]
        self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.reader = threading.Thread(target=self.read_frames, daemon=True)
        self.reader.start()

    def read_frames(self):
        process = self.process
        stream = process.stdout
        while process.poll() is None and stream is not None:
            frame = stream.read(self.size)
            if len(frame) != self.size:
                break
            if self.frames.full():
                try:
                    self.frames.get_nowait()
                except queue.Empty:
                    pass
            self.frames.put(frame)

    def latest(self):
        try:
            return self.frames.get_nowait()
        except queue.Empty:
            return None

    def stop(self):
        process = self.process
        self.process = None
        if process is not None:
            try:
                process.terminate()
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
            if process.stdout is not None:
                process.stdout.close()
        if self.reader is not None:
            self.reader.join(timeout=0.2)
            self.reader = None
        while not self.frames.empty():
            try:
                self.frames.get_nowait()
            except queue.Empty:
                break


class LockOverlay:
    def __init__(self):
        import tkinter as tk
        from tkinter import font as tkfont
        from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageTk

        self.tk = tk
        self.Image = Image
        self.ImageDraw = ImageDraw
        self.ImageEnhance = ImageEnhance
        self.ImageFilter = ImageFilter
        self.ImageTk = ImageTk
        self.events = queue.Queue()
        self.locked = False
        self.through = False
        self.pin = ""
        self.word = ""
        self.windows = []
        self.primary = None
        self.password_text = None
        self.password_placeholder = None
        self.error_text = None
        self.clock_texts = []
        self.date_texts = []
        self.layout_signature = None
        self.monitor_error = ""
        self.through_timer = None
        self.stopping = False
        self.screenshot_connection = None
        self.screenshot_root = None
        self.screenshot_property = None
        # Static wallpaper by default: no background video process and no decoding load.
        self.video_source = find_video_wallpaper() if os.environ.get("POCKET_VIDEO_WALLPAPER") == "1" else None
        self.video = None
        self.animation_after = None
        self.root = tk.Tk(className="pocket-clipboard-privacy")
        self.root.withdraw()
        try:
            self.font_family = str(tkfont.nametofont("TkDefaultFont").actual("family"))
        except Exception:
            self.font_family = "DejaVu Sans"
        self.username = getpass.getuser()
        self.xinput = XInput(self.events)
        self.build_windows()
        self.xinput.start()
        self.root.after(30, self.process_events)
        self.root.after(250, self.update_clock)
        self.root.after(300, self.keep_on_top)
        self.root.after(2000, self.refresh_layout)
        threading.Thread(target=self.read_stdin, daemon=True).start()
        emit("ready")

    def read_stdin(self):
        try:
            for raw in sys.stdin:
                if raw.strip():
                    self.events.put(("op", json.loads(raw)))
        except Exception as error:
            emit("error", message="stdin: %s" % error)

    def wallpaper(self, width, height):
        image = None
        source = find_wallpaper()
        if source:
            try:
                image = self.Image.open(source).convert("RGB")
            except Exception as error:
                emit("log", message="wallpaper failed: %s" % error)
        if image is None:
            image = self.Image.new("RGB", (width, height), "#182b3a")
        scale = max(width / image.width, height / image.height)
        resized = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), self.Image.Resampling.LANCZOS)
        left = max(0, (resized.width - width) // 2)
        top = max(0, (resized.height - height) // 2)
        image = resized.crop((left, top, left + width, top + height))
        image = image.filter(self.ImageFilter.GaussianBlur(2.2))
        return self.ImageEnhance.Brightness(image).enhance(0.52)

    def avatar(self, size=104):
        image = self.Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = self.ImageDraw.Draw(image)
        draw.ellipse((1, 1, size - 2, size - 2), fill="#38566d", outline="#8ba8bc", width=2)
        face = Path.home() / ".face"
        if face.is_file():
            try:
                # SDDM's extension-less ~/.face may still contain SVG; suffix alone is not enough.
                header = face.read_bytes()[:512].lstrip().lower()
                if face.suffix.lower() == ".svg" or b"<svg" in header:
                    rendered = subprocess.run([
                        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(face),
                        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
                    ], capture_output=True, timeout=15)
                    if rendered.returncode != 0:
                        raise RuntimeError("ffmpeg could not render the SVG avatar")
                    photo = self.Image.open(io.BytesIO(rendered.stdout)).convert("RGBA")
                else:
                    photo = self.Image.open(str(face)).convert("RGBA")
                side = min(photo.size)
                left = (photo.width - side) // 2
                top = (photo.height - side) // 2
                photo = photo.crop((left, top, left + side, top + side)).resize((size - 8, size - 8), self.Image.Resampling.LANCZOS)
                mask = self.Image.new("L", photo.size, 0)
                self.ImageDraw.Draw(mask).ellipse((0, 0, photo.width, photo.height), fill=255)
                image.paste(photo, (4, 4), mask)
                return self.ImageTk.PhotoImage(image)
            except Exception:
                pass
        portrait = self.Image.new("RGBA", (size, size), (0, 0, 0, 0))
        portrait_draw = self.ImageDraw.Draw(portrait)
        portrait_draw.ellipse((round(size * 0.33), round(size * 0.19), round(size * 0.67), round(size * 0.54)), fill="#d7e4ec")
        portrait_draw.ellipse((round(size * 0.18), round(size * 0.56), round(size * 0.82), round(size * 1.08)), fill="#d7e4ec")
        mask = self.Image.new("L", (size, size), 0)
        self.ImageDraw.Draw(mask).ellipse((4, 4, size - 5, size - 5), fill=255)
        image.paste(portrait, (0, 0), mask)
        return self.ImageTk.PhotoImage(image)

    def fallback_monitors(self):
        return [{
            "index": 0,
            "x": 0,
            "y": 0,
            "width": self.root.winfo_screenwidth(),
            "height": self.root.winfo_screenheight(),
            "primary": True,
            "scale": 1.0,
        }]

    def detect_monitors(self):
        try:
            monitors = displays()
        except Exception as error:
            if str(error) != self.monitor_error:
                emit("log", message="monitor detection failed: %s" % error)
                self.monitor_error = str(error)
            return self.fallback_monitors()
        self.monitor_error = ""
        return monitors or self.fallback_monitors()

    def ui_scale(self):
        try:
            scale = float(self.root.tk.call("tk", "scaling")) * 72.0 / 96.0
        except (TypeError, ValueError, self.tk.TclError):
            scale = 1.0
        return max(0.75, min(2.0, scale))

    def build_windows(self, monitors=None):
        monitors = self.detect_monitors() if monitors is None else monitors
        scale = self.ui_scale()
        self.layout_signature = (monitor_signature(monitors), round(scale, 3))
        self.primary = None
        self.password_text = None
        self.password_placeholder = None
        self.error_text = None
        self.clock_texts = []
        self.date_texts = []
        primary = next((m for m in monitors if m.get("primary")), monitors[0])
        for monitor in monitors:
            is_primary = monitor is primary
            window = self.root if is_primary else self.tk.Toplevel(self.root)
            if not is_primary:
                window.withdraw()
            window.title("PocketClipboard privacy overlay")
            window.overrideredirect(True)
            window.attributes("-topmost", True)
            window.geometry("%sx%s%+d%+d" % (monitor["width"], monitor["height"], monitor["x"], monitor["y"]))
            window.configure(bg="#101c28")
            canvas = self.tk.Canvas(window, width=monitor["width"], height=monitor["height"], highlightthickness=0, bd=0, bg="#101c28")
            canvas.pack(fill="both", expand=True)
            background = self.ImageTk.PhotoImage(self.wallpaper(monitor["width"], monitor["height"]))
            background_item = canvas.create_image(0, 0, image=background, anchor="nw")
            entry = {"window": window, "canvas": canvas, "background": background, "background_item": background_item, "monitor": monitor}
            self.windows.append(entry)
            cx = monitor["width"] // 2
            layout = login_layout(monitor["width"], monitor["height"], scale)
            entry["layout"] = layout
            clock_size = max(36, min(58, round(monitor["height"] / 13.2)))
            self.clock_texts.append(canvas.create_text(cx, layout["clock_y"], fill="white", font=(self.font_family, clock_size, "bold"), text=""))
            self.date_texts.append(canvas.create_text(cx, layout["date_y"], fill="#e2edf4", font=(self.font_family, 19), text=""))
            self.build_footer(entry, scale)
            if is_primary:
                self.primary = entry
                self.build_login(entry)
            window.withdraw()

    def build_footer(self, entry, scale):
        canvas = entry["canvas"]
        width = entry["monitor"]["width"]
        height = entry["monitor"]["height"]
        footer_height = entry["layout"]["footer_height"]
        canvas.create_rectangle(0, height - footer_height, width, height, fill="#101923", outline="#293642", width=1)
        button_size = max(28, round(34 * scale))
        gap = max(5, round(8 * scale))
        labels = ("⌁", "♿", "⏻")
        for index, label in enumerate(labels):
            left = width - round(20 * scale) - (index + 1) * button_size - index * gap
            top = height - (footer_height + button_size) // 2
            canvas.create_oval(left, top, left + button_size, top + button_size, fill="#1c2a37", outline="#607487", width=1)
            canvas.create_text(left + button_size // 2, top + button_size // 2, text=label, fill="#e7edf2", font=(self.font_family, 13))

    def build_login(self, entry):
        canvas = entry["canvas"]
        layout = entry["layout"]
        cx = layout["center_x"]
        field_left = layout["field_left"]
        field_right = layout["field_right"]
        field_top = layout["password_y"] - layout["field_height"] // 2
        field_bottom = field_top + layout["field_height"]
        padding = max(10, round(16 * self.ui_scale()))
        button_width = layout["button_width"]
        button_left = field_right - button_width
        self.avatar_image = self.avatar(layout["avatar_size"])
        canvas.create_image(cx, layout["avatar_y"], image=self.avatar_image)
        canvas.create_text(cx, layout["name_y"], text=self.username, fill="white", font=(self.font_family, 22, "bold"))
        canvas.create_text(cx, layout["pin_label_y"], text="PIN", fill="#d9e1e8", font=(self.font_family, 12, "bold"))
        canvas.create_rectangle(field_left, field_top, field_right, field_bottom, fill="#0d1721", outline="#8094a5", width=1)
        submit_bg = canvas.create_rectangle(
            button_left, field_top + 1, field_right - 1, field_bottom - 1,
            fill="#2869a6", outline="", tags=("submit", "submit-button"),
        )
        canvas.tag_bind("submit", "<Enter>", lambda _event: canvas.itemconfigure("submit-button", fill="#3883c8"))
        canvas.tag_bind("submit", "<Leave>", lambda _event: canvas.itemconfigure("submit-button", fill="#2869a6"))
        canvas.create_line(
            button_left + button_width * 0.32,
            layout["password_y"],
            button_left + button_width * 0.68,
            layout["password_y"],
            fill="#f4f7fa",
            width=2,
            arrow=self.tk.LAST,
            arrowshape=(8, 9, 4),
            tags=("submit",),
        )
        canvas.tag_bind("submit", "<Button-1>", self.submit_input)
        self.password_placeholder = canvas.create_text(
            field_left + padding, layout["password_y"], text="PIN", anchor="w",
            fill="#93a1ae", font=(self.font_family, 14),
        )
        self.password_text = canvas.create_text(
            (field_left + button_left) // 2, layout["password_y"], text="",
            fill="#f4f7fa", font=(self.font_family, 16),
        )
        self.error_text = canvas.create_text(
            cx, layout["error_y"], text="", fill="#ff9a9a", font=(self.font_family, 13),
        )

    def process_events(self):
        if self.stopping:
            return
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "x":
                    self.on_input(value)
                elif value.get("op") == "state":
                    self.apply_state(bool(value.get("locked")), str(value.get("error") or ""))
                elif value.get("op") == "through":
                    self.step_aside(int(value.get("ms", 0)))
                elif value.get("op") == "quit":
                    self.close()
                    return
        except queue.Empty:
            pass
        except Exception as error:
            emit("error", message=str(error))
        self.root.after(30, self.process_events)

    def on_input(self, event):
        kind = event.get("kind")
        if kind == "hotkey":
            emit("hotkey", keys=event.get("keys", "alt+shift+space"))
        elif kind == "unlock":
            emit("unlock", how=event.get("how", "keys"))
        elif not self.locked or self.through:
            return
        elif kind == "digit" and len(self.pin) < 12:
            self.pin += event["value"]
            self.word = ""
        elif kind == "letter" and len(self.word) < 24:
            self.word += event["value"]
        elif kind == "backspace":
            if self.pin:
                self.pin = self.pin[:-1]
            else:
                self.word = self.word[:-1]
        elif kind == "enter":
            self.submit_input()
            return
        self.update_password()

    def submit_input(self, _event=None):
        if not self.locked or self.through:
            return
        pin, word = self.pin, self.word
        self.pin = ""
        self.word = ""
        if pin:
            emit("pin", text=pin)
        elif word:
            emit("word", text=word)
        self.update_password()

    def update_password(self):
        if self.primary is not None:
            canvas = self.primary["canvas"]
            canvas.itemconfigure(self.password_text, text="●" * len(self.pin))
            canvas.itemconfigure(self.password_placeholder, state="hidden" if self.pin else "normal")

    def apply_state(self, locked, error):
        self.cancel_through()
        self.through = False
        self.locked = locked
        self.pin = ""
        self.word = ""
        self.update_password()
        if self.primary is not None:
            self.primary["canvas"].itemconfigure(self.error_text, text=error)
        if locked:
            self.show()
        else:
            self.xinput.configure(False, False, self.input_targets())
            self.stop_animation()
            for entry in self.windows:
                entry["window"].withdraw()
            self.stop_screenshot_redirection()

    def show(self):
        self.start_screenshot_redirection()
        for entry in self.windows:
            window = entry["window"]
            window.deiconify()
            window.attributes("-topmost", True)
            window.lift()
        self.xinput.configure(self.locked, self.through, self.input_targets())
        self.start_animation()

    def start_screenshot_redirection(self):
        if self.screenshot_connection is not None:
            return
        connection = None
        try:
            from Xlib import X, Xatom, display
            from Xlib.ext import composite

            connection = display.Display()
            if not connection.has_extension("Composite"):
                raise RuntimeError("X11 Composite is required for screenshots beneath the privacy overlay")
            owner = connection.get_selection_owner(
                connection.intern_atom("_NET_WM_CM_S%d" % connection.get_default_screen()),
            )
            if getattr(owner, "id", owner):
                connection.close()
                return
            root = connection.screen().root
            property_atom = connection.intern_atom("_POCKET_CLIPBOARD_COMPOSITE_REDIRECT")
            errors = []
            root.composite_redirect_subwindows(
                composite.RedirectAutomatic,
                onerror=lambda error, request: errors.append(error),
            )
            connection.sync()
            if errors:
                raise RuntimeError("could not preserve obscured desktop windows: %s" % errors[0])
            root.change_property(property_atom, Xatom.CARDINAL, 32, [1])
            connection.sync()
            self.screenshot_connection = connection
            self.screenshot_root = root
            self.screenshot_property = property_atom
        except Exception as error:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            emit("error", message="X11 screenshot redirection: %s" % error)

    def stop_screenshot_redirection(self):
        connection = self.screenshot_connection
        if connection is None:
            return
        try:
            self.screenshot_root.delete_property(self.screenshot_property)
            connection.sync()
        except Exception:
            pass
        try:
            connection.close()
        except Exception:
            pass
        self.screenshot_connection = None
        self.screenshot_root = None
        self.screenshot_property = None

    def input_targets(self):
        targets = {}
        for entry in self.windows:
            monitor = entry["monitor"]
            width = int(monitor["width"])
            height = int(monitor["height"])
            for widget in (entry["window"], entry["canvas"]):
                try:
                    window_id = int(widget.winfo_id())
                    targets[window_id] = (window_id, width, height)
                except Exception:
                    pass
        return tuple(targets.values())

    def step_aside(self, milliseconds):
        if not self.locked:
            return
        self.cancel_through()
        if milliseconds <= 0:
            self.restore()
            return
        self.through = True
        self.xinput.configure(self.locked, True, self.input_targets())
        self.through_timer = self.root.after(min(milliseconds, 240000), self.restore)

    def cancel_through(self):
        if self.through_timer is not None:
            try:
                self.root.after_cancel(self.through_timer)
            except Exception:
                pass
            self.through_timer = None

    def restore(self):
        self.cancel_through()
        self.through = False
        if self.locked:
            self.xinput.configure(self.locked, False, self.input_targets())

    def start_animation(self):
        if self.video is not None or not self.video_source or self.primary is None:
            return
        monitor = self.primary["monitor"]
        self.video = VideoWallpaper(self.video_source, monitor["width"], monitor["height"])
        try:
            self.video.start()
        except Exception as error:
            self.video = None
            emit("log", message="video wallpaper failed: %s" % error)
            return
        self.animation_after = self.root.after(0, self.update_animation)

    def stop_animation(self):
        if self.animation_after is not None:
            try:
                self.root.after_cancel(self.animation_after)
            except Exception:
                pass
            self.animation_after = None
        if self.video is not None:
            self.video.stop()
            self.video = None

    def update_animation(self):
        if self.video is None or self.primary is None:
            return
        frame = self.video.latest()
        if frame is not None:
            monitor = self.primary["monitor"]
            image = self.Image.frombytes("RGB", (monitor["width"], monitor["height"]), frame)
            image = self.ImageEnhance.Brightness(image).enhance(0.52)
            self.primary["background"] = self.ImageTk.PhotoImage(image)
            self.primary["canvas"].itemconfigure(self.primary["background_item"], image=self.primary["background"])
        self.animation_after = self.root.after(66, self.update_animation)

    def keep_on_top(self):
        if self.stopping:
            return
        if self.locked and not self.through:
            for entry in self.windows:
                entry["window"].attributes("-topmost", True)
                entry["window"].lift()
            self.xinput.configure(True, False, self.input_targets())
        self.root.after(300, self.keep_on_top)

    def refresh_layout(self):
        if self.stopping:
            return
        monitors = self.detect_monitors()
        signature = (monitor_signature(monitors), round(self.ui_scale(), 3))
        if signature != self.layout_signature:
            self.stop_animation()
            for entry in self.windows:
                try:
                    entry["canvas"].destroy()
                    if entry["window"] is self.root:
                        entry["window"].withdraw()
                    else:
                        entry["window"].destroy()
                except Exception:
                    pass
            self.windows = []
            self.build_windows(monitors)
            if self.locked:
                self.show()
            emit("log", message="monitor layout updated")
        self.root.after(2000, self.refresh_layout)

    def update_clock(self):
        if self.stopping:
            return
        now = time.localtime()
        clock = time.strftime("%H:%M", now)
        date = time.strftime("%A, %d %B %Y", now)
        for index, entry in enumerate(self.windows):
            entry["canvas"].itemconfigure(self.clock_texts[index], text=clock)
            entry["canvas"].itemconfigure(self.date_texts[index], text=date)
        self.root.after(1000, self.update_clock)

    def close(self):
        self.stopping = True
        self.cancel_through()
        self.stop_animation()
        self.xinput.stop()
        try:
            self.root.destroy()
        except Exception:
            pass
        self.stop_screenshot_redirection()

    def run(self):
        self.root.mainloop()


def main():
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("DISPLAY is empty. Start the lock overlay inside the Kali X11 graphical session.")
    if os.environ.get("XDG_SESSION_TYPE", "x11").lower() == "wayland":
        raise RuntimeError("Wayland is not supported. Choose the X11 session at the Kali login screen.")
    overlay = LockOverlay()
    overlay.run()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", message=str(error))
        raise
