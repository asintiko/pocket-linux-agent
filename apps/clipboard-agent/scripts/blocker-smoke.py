#!/usr/bin/env python3
"""Render and exercise the native Tk blocker on an isolated X11 display."""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
from pathlib import Path

from PIL import Image, ImageDraw


LINUX_DIR = Path(__file__).resolve().parents[1] / "src/linux"
sys.path.insert(0, str(LINUX_DIR))

import blocker


ERROR_TEXT = "Неверный пароль. Попробуйте снова."
PLACEHOLDER = "Enter your password"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--dpi", type=int, choices=(96, 120, 144, 192), required=True)
    parser.add_argument("--screenshot", type=Path, required=True)
    args = parser.parse_args()
    if args.width not in (1366, 1920) or args.height != args.width * 9 // 16:
        parser.error("use 1366x768 or 1920x1080")
    return args


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def bounds(canvas, item):
    result = canvas.bbox(item)
    require(result is not None, "canvas item %s has no visible bounds" % item)
    return tuple(result)


def contains(outer, inner):
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def overlap(first, second):
    return first[0] < second[2] and first[2] > second[0] and first[1] < second[3] and first[3] > second[1]


def find_text(canvas, expected):
    matches = [
        item for item in canvas.find_all()
        if canvas.type(item) == "text" and canvas.itemcget(item, "text") == expected
    ]
    require(len(matches) == 1, "expected one canvas text item %r, got %d" % (expected, len(matches)))
    return matches[0]


def find_rectangle(canvas, fill, content_bounds=None):
    matches = []
    for item in canvas.find_all():
        if canvas.type(item) != "rectangle" or canvas.itemcget(item, "fill").lower() != fill.lower():
            continue
        coords = tuple(round(value) for value in canvas.coords(item))
        if content_bounds is None or contains(coords, content_bounds):
            matches.append((item, coords))
    require(bool(matches), "no %s rectangle contains the requested content" % fill)
    return min(matches, key=lambda pair: (pair[1][2] - pair[1][0]) * (pair[1][3] - pair[1][1]))


def assert_inside_card(canvas, card_bounds, item, label):
    item_bounds = bounds(canvas, item)
    require(contains(card_bounds, item_bounds), "%s is outside the greeter card: %r not in %r" % (label, item_bounds, card_bounds))
    return item_bounds


class NativeBlockerSmoke:
    def __init__(self, args, home, wallpaper):
        self.args = args
        self.events = []
        self.failure = None
        self.overlay = None
        self.original_emit = blocker.emit
        self.emit_lock = threading.Lock()
        self.control_bounds = {}

        def record_emit(event, **values):
            with self.emit_lock:
                self.events.append((event, values))

        blocker.emit = record_emit
        # A single-screen fixture avoids depending on xrandr; Tk still owns the real Xvfb display.
        blocker.displays = lambda: [{
            "index": 0,
            "x": 0,
            "y": 0,
            "width": args.width,
            "height": args.height,
            "primary": True,
        }]
        os.environ["HOME"] = str(home)
        os.environ["USER"] = "demo"
        os.environ["LOGNAME"] = "demo"
        os.environ["USERNAME"] = "demo"
        os.environ["POCKET_WALLPAPER"] = str(wallpaper)
        os.environ.pop("POCKET_VIDEO_WALLPAPER", None)
        self.overlay = blocker.LockOverlay()

    def check_render(self):
        overlay = self.overlay
        args = self.args
        root = overlay.root
        require(root.winfo_screenwidth() == args.width, "Tk screen width differs from requested Xvfb width")
        require(root.winfo_screenheight() == args.height, "Tk screen height differs from requested Xvfb height")
        actual_dpi = float(root.winfo_fpixels("1i"))
        require(abs(actual_dpi - args.dpi) <= 2, "Tk reports %.2f DPI, expected %d" % (actual_dpi, args.dpi))
        require(abs(overlay.ui_scale - actual_dpi / 96.0) < 0.01, "overlay scale does not follow Tk DPI")
        require(overlay.username == "demo", "overlay did not use the isolated demo identity")
        require(overlay.locked and not overlay.through, "state operation did not lock the overlay")
        require(overlay.xinput.locked and overlay.xinput.grabbed, "X11 input hook did not grab the isolated display")
        require(any(name.lower() == "cantarell" for name in root.tk.call("font", "families")), "Cantarell is not available to Tk")

        entry = overlay.primary
        canvas = entry["canvas"]
        require(entry["window"].winfo_ismapped(), "locked overlay window is not mapped")
        require(canvas.winfo_width() == args.width and canvas.winfo_height() == args.height, "canvas size differs from the Xvfb screen")
        require(canvas.type(entry["background_item"]) == "image", "generated wallpaper is not drawn on the native canvas")

        card, card_bounds = find_rectangle(canvas, blocker.KALI_CARD)
        require(canvas.type(card) == "rectangle", "greeter card is not a native canvas rectangle")
        password_id = overlay.password_text
        require(canvas.itemcget(password_id, "text") == PLACEHOLDER, "empty password field placeholder differs")
        password_bounds = bounds(canvas, password_id)
        _, field_bounds = find_rectangle(canvas, blocker.KALI_PANEL, password_bounds)
        require(contains(field_bounds, password_bounds), "password text escapes its input field")
        require(contains(card_bounds, field_bounds), "password field escapes the greeter card")

        error_id = overlay.error_text
        require(canvas.itemcget(error_id, "text") == ERROR_TEXT, "error label was not rendered")
        error_bounds = assert_inside_card(canvas, card_bounds, error_id, "error label")
        require(not overlap(error_bounds, field_bounds), "error label overlaps the password field")

        username_id = find_text(canvas, "demo")
        assert_inside_card(canvas, card_bounds, username_id, "username")
        avatar_ids = [item for item in canvas.find_all() if canvas.type(item) == "image" and item != entry["background_item"]]
        require(len(avatar_ids) == 1, "expected one user avatar on the primary canvas")
        avatar_bounds = bounds(canvas, avatar_ids[0])
        require(contains(card_bounds, avatar_bounds), "avatar escapes the greeter card")

        unlock_id = find_text(canvas, "Unlock")
        unlock_bounds = bounds(canvas, unlock_id)
        _, button_bounds = find_rectangle(canvas, blocker.KALI_ACCENT, unlock_bounds)
        require(contains(card_bounds, button_bounds), "Unlock button escapes the greeter card")
        require(contains(button_bounds, unlock_bounds), "Unlock label escapes its button")
        require(
            not overlap(error_bounds, button_bounds),
            "error label bounds %r overlap Unlock button bounds %r" % (error_bounds, button_bounds),
        )
        require(field_bounds[3] <= error_bounds[1], "error label bounds %r start inside password field bounds %r" % (error_bounds, field_bounds))
        require(
            error_bounds[3] <= button_bounds[1],
            "error label bounds %r do not fit above Unlock button bounds %r" % (error_bounds, button_bounds),
        )
        require(field_bounds[3] <= button_bounds[1], "password field overlaps the Unlock button")
        self.control_bounds = {
            "field": field_bounds,
            "error": error_bounds,
            "button": button_bounds,
        }

        for item in overlay.clock_texts + overlay.date_texts:
            text = canvas.itemcget(item, "text")
            require(bool(text), "panel clock/date has not been drawn")
            require("Cantarell" in canvas.itemcget(item, "font"), "panel text is not using Cantarell")
            panel_text_bounds = bounds(canvas, item)
            require(0 <= panel_text_bounds[1] and panel_text_bounds[3] <= overlay.ui_scale * 32 + 2, "panel clock/date escapes the panel")

        # Escape words stay hidden; numeric PIN input is masked in the password field.
        overlay.on_input({"kind": "letter", "value": "x"})
        require(canvas.itemcget(password_id, "text") == PLACEHOLDER, "escape word became visible in the password field")
        overlay.on_input({"kind": "backspace"})
        overlay.on_input({"kind": "digit", "value": "7"})
        require(canvas.itemcget(password_id, "text") == "●", "PIN input is not masked")
        overlay.on_input({"kind": "backspace"})
        require(canvas.itemcget(password_id, "text") == PLACEHOLDER, "empty password field did not restore its placeholder")

        self.args.screenshot.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["scrot", "-o", str(self.args.screenshot)], check=True, env=os.environ)
        with Image.open(self.args.screenshot) as image:
            require(image.size == (args.width, args.height), "screenshot dimensions differ from the Xvfb screen")
            extrema = image.convert("RGB").getextrema()
            require(any(low != high for low, high in extrema), "native screenshot is blank")

    def guarded(self, callback):
        def run():
            try:
                callback()
            except Exception:
                self.failure = traceback.format_exc()
                if self.overlay is not None and not self.overlay.stopping:
                    self.overlay.close()
        return run

    def begin(self):
        require(not self.overlay.locked and not self.overlay.through, "overlay did not start unlocked")
        require(all(not entry["window"].winfo_ismapped() for entry in self.overlay.windows), "unlocked overlay window was visible")
        self.overlay.events.put(("op", {"op": "state", "locked": True, "error": ERROR_TEXT}))
        self.overlay.root.after(400, self.guarded(self.locked))

    def locked(self):
        self.check_render()
        self.overlay.events.put(("op", {"op": "through", "ms": 600}))
        self.overlay.root.after(180, self.guarded(self.stepped_aside))

    def stepped_aside(self):
        overlay = self.overlay
        require(overlay.through and overlay.locked, "through operation did not enter step-aside state")
        require(not overlay.xinput.locked and not overlay.xinput.grabbed, "step-aside did not release the X11 keyboard grab")
        require(all(not entry["window"].winfo_ismapped() for entry in overlay.windows), "through operation left an overlay window visible")
        overlay.root.after(650, self.guarded(self.restored))

    def restored(self):
        overlay = self.overlay
        require(overlay.locked and not overlay.through, "timer did not restore the locked state")
        require(overlay.through_timer is None, "restore left the step-aside timer active")
        require(overlay.xinput.locked and overlay.xinput.grabbed, "restore did not reacquire the X11 keyboard grab")
        require(all(entry["window"].winfo_ismapped() for entry in overlay.windows), "restore did not remap the overlay")
        overlay.events.put(("op", {"op": "state", "locked": False, "error": ""}))
        overlay.root.after(120, self.guarded(self.unlocked))

    def unlocked(self):
        overlay = self.overlay
        require(not overlay.locked and not overlay.through, "unlocked state operation did not clear the lock")
        require(not overlay.xinput.locked and not overlay.xinput.grabbed, "unlocked state did not release the X11 keyboard grab")
        require(all(not entry["window"].winfo_ismapped() for entry in overlay.windows), "unlocked state left an overlay visible")
        require(overlay.primary["canvas"].itemcget(overlay.error_text, "text") == "", "unlocked state left the error label visible")
        overlay.events.put(("op", {"op": "quit"}))

    def run(self):
        self.overlay.root.after(100, self.guarded(self.begin))
        self.overlay.run()
        self.overlay.xinput.join(timeout=2)
        self.original_emit(
            "smoke",
            resolution="%sx%s" % (self.args.width, self.args.height),
            dpi=self.args.dpi,
            controls=self.control_bounds,
        )
        blocker.emit = self.original_emit
        require(self.failure is None, self.failure or "native blocker smoke failed")
        require(self.overlay.stopping, "quit operation did not close the overlay")
        require(not self.overlay.xinput.is_alive(), "quit operation left the X11 input thread running")
        require(any(event == "ready" for event, _ in self.events), "overlay did not report ready")
        errors = [values.get("message", "") for event, values in self.events if event == "error"]
        require(not errors, "native blocker emitted an error: %s" % "; ".join(errors))


def create_wallpaper(path):
    image = Image.new("RGB", (1366, 768), "#16283d")
    draw = ImageDraw.Draw(image)
    for y in range(image.height):
        shade = int(20 + 32 * y / image.height)
        draw.line((0, y, image.width, y), fill=(14, shade, min(100, shade * 2)))
    draw.ellipse((940, 80, 1320, 460), fill="#3a5069")
    image.save(path)


def main():
    args = parse_args()
    require(bool(os.environ.get("DISPLAY")), "DISPLAY must point at the isolated Xvfb server")
    require(shutil.which("scrot") is not None, "scrot is required for native screenshots")
    with tempfile.TemporaryDirectory(prefix="pocket-blocker-smoke-") as directory:
        home = Path(directory)
        wallpaper = home / "fixture-wallpaper.png"
        create_wallpaper(wallpaper)
        smoke = NativeBlockerSmoke(args, home, wallpaper)
        smoke.run()
    print("PASS %sx%s @ %d DPI -> %s" % (args.width, args.height, args.dpi, args.screenshot))


if __name__ == "__main__":
    main()
