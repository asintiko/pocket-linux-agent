#!/usr/bin/env python3
"""PocketClipboard X11 computer-use host: one JSON request/response per line."""

import base64
import io
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

# The X tools decode text and print window titles by locale; a service may start with none set.
TOOL_ENV = dict(os.environ, LC_ALL="C.UTF-8")


def run(args, input_text=None, check=True, timeout=30):
    proc = subprocess.run(args, input=input_text, capture_output=True, timeout=timeout, env=TOOL_ENV, encoding="utf8", errors="replace")
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        # An X error is a report of several lines; the first one names it.
        named = [line for line in detail if "X Error" in line]
        raise RuntimeError((named or detail)[-1].strip() if detail else "%s exited with %s" % (args[0], proc.returncode))
    return proc


def wait_until(test, milliseconds, step=0.03):
    deadline = time.monotonic() + milliseconds / 1000
    while True:
        if test():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(step)


def parse_monitors(text):
    result = []
    pattern = re.compile(r"^\s*(\d+):\s+\+(\*)?\S+\s+(\d+)/\d+x(\d+)/\d+([+-]\d+)([+-]\d+)\s+")
    for line in text.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        result.append({
            "index": int(match.group(1)),
            "primary": bool(match.group(2)),
            "width": int(match.group(3)),
            "height": int(match.group(4)),
            "x": int(match.group(5)),
            "y": int(match.group(6)),
        })
    result.sort(key=lambda m: (not m["primary"], m["x"], m["y"]))
    for index, monitor in enumerate(result):
        monitor["index"] = index
        monitor["scale"] = 1.0
    return result


def displays():
    parsed = parse_monitors(run(["xrandr", "--listactivemonitors"]).stdout)
    if parsed:
        return parsed
    width, height = [int(v) for v in run(["xdotool", "getdisplaygeometry"]).stdout.split()]
    return [{"index": 0, "x": 0, "y": 0, "width": width, "height": height, "primary": True, "scale": 1.0}]


def virtual_bounds(monitors=None):
    monitors = monitors or displays()
    left = min(m["x"] for m in monitors)
    top = min(m["y"] for m in monitors)
    right = max(m["x"] + m["width"] for m in monitors)
    bottom = max(m["y"] + m["height"] for m in monitors)
    return left, top, right, bottom


def cursor():
    values = {}
    for line in run(["xdotool", "getmouselocation", "--shell"]).stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            # xdotool prints X= and Y= in capitals.
            values[key.strip().lower()] = value.strip()
    return {"x": int(values.get("x", 0)), "y": int(values.get("y", 0))}


def _x11_drawable_image(drawable, width, height, Image, X, byte_order):
    reply = drawable.get_image(0, 0, width, height, X.ZPixmap, 0xFFFFFFFF)
    data = reply.data
    if not data or len(data) % height:
        raise RuntimeError("X11 returned an incomplete Composite image")
    stride = len(data) // height
    if stride >= width * 4:
        raw_mode = "BGRX" if byte_order == X.LSBFirst else "XRGB"
    elif stride >= width * 3:
        raw_mode = "BGR" if byte_order == X.LSBFirst else "RGB"
    else:
        raise RuntimeError("Unsupported X11 pixel format for non-disruptive screenshot capture")
    return Image.frombytes("RGB", (width, height), data, "raw", raw_mode, stride, 1)


def _privacy_overlay(window):
    values = []
    try:
        values.append(window.get_wm_name() or "")
    except Exception:
        pass
    try:
        values.extend(window.get_wm_class() or ())
    except Exception:
        pass
    for value in values:
        if isinstance(value, bytes):
            value = value.decode("utf8", "replace")
        normalized = "".join(char.lower() for char in str(value) if char.isalnum())
        if "pocketclipboardprivacyoverlay" in normalized or "pocketclipboardprivacy" in normalized:
            return True
    return False


def _underlay_capture(x, y, width, height):
    from PIL import Image
    from Xlib import X, display
    from Xlib.ext import composite

    connection = display.Display(os.environ.get("DISPLAY"))
    try:
        screen = connection.screen()
        root = screen.root
        overlays = set()

        def find_overlays(window):
            try:
                attributes = window.get_attributes()
                if attributes.map_state != X.IsViewable:
                    return
                if _privacy_overlay(window):
                    overlays.add(window.id)
                    return
                for child in window.query_tree().children:
                    find_overlays(child)
            except Exception:
                return

        for child in root.query_tree().children:
            find_overlays(child)
        if not overlays:
            return None
        if not connection.has_extension("Composite"):
            raise RuntimeError("X11 Composite is required to capture the desktop under the privacy overlay")

        background = Image.new("RGB", (screen.width_in_pixels, screen.height_in_pixels), (0, 0, 0))
        for property_name in ("_XROOTPMAP_ID", "_XSETROOT_ID"):
            try:
                prop = root.get_full_property(connection.intern_atom(property_name), X.AnyPropertyType)
                if prop is None or not len(prop.value):
                    continue
                pixmap = connection.create_resource_object("pixmap", int(prop.value[0]))
                geometry = pixmap.get_geometry()
                wallpaper = _x11_drawable_image(
                    pixmap, geometry.width, geometry.height, Image, X, connection.display.info.image_byte_order,
                )
                for top in range(0, background.height, wallpaper.height):
                    for left in range(0, background.width, wallpaper.width):
                        background.paste(wallpaper, (left, top))
                break
            except Exception:
                continue

        owner = connection.get_selection_owner(connection.intern_atom("_NET_WM_CM_S%d" % connection.get_default_screen()))
        redirect_property = root.get_full_property(
            connection.intern_atom("_POCKET_CLIPBOARD_COMPOSITE_REDIRECT"), X.AnyPropertyType,
        )
        already_redirected = bool(getattr(owner, "id", owner)) or bool(redirect_property and len(redirect_property.value))
        screen_clip = (0, 0, background.width, background.height)

        def intersection(left, right):
            rect = (max(left[0], right[0]), max(left[1], right[1]), min(left[2], right[2]), min(left[3], right[3]))
            return rect if rect[0] < rect[2] and rect[1] < rect[3] else None

        def capture_window(window):
            pixmap = None
            redirected = False
            root_child = window.query_tree().parent.id == root.id
            if not already_redirected or not root_child:
                redirect_errors = []
                window.composite_redirect_window(
                    composite.RedirectAutomatic,
                    onerror=lambda error, request: redirect_errors.append(error),
                )
                connection.sync()
                redirected = not redirect_errors
            try:
                pixmap = window.composite_name_window_pixmap()
                connection.sync()
                geometry = pixmap.get_geometry()
                image = _x11_drawable_image(
                    pixmap, geometry.width, geometry.height, Image, X, connection.display.info.image_byte_order,
                )
                return image, geometry
            finally:
                if pixmap is not None:
                    pixmap.free()
                if redirected:
                    window.composite_unredirect_window(composite.RedirectAutomatic)
                    connection.sync()

        def compose(window, parent_clip):
            if window.id in overlays:
                return
            try:
                attributes = window.get_attributes()
                if attributes.map_state != X.IsViewable or attributes.win_class == X.InputOnly:
                    return
                geometry = window.get_geometry()
                origin = root.translate_coords(window, 0, 0)
                left = origin.x - geometry.border_width
                top = origin.y - geometry.border_width
                image, pixmap_geometry = capture_window(window)
                bounds = (left, top, left + pixmap_geometry.width, top + pixmap_geometry.height)
                visible = intersection(parent_clip, bounds)
                if visible:
                    crop = image.crop((visible[0] - left, visible[1] - top, visible[2] - left, visible[3] - top))
                    background.paste(crop, (visible[0], visible[1]))
                child_clip = intersection(parent_clip, (origin.x, origin.y, origin.x + geometry.width, origin.y + geometry.height))
                if child_clip:
                    for child in window.query_tree().children:
                        compose(child, child_clip)
            except Exception as error:
                raise RuntimeError("X11 Composite screenshot failed: %s" % error) from error

        for child in root.query_tree().children:
            compose(child, screen_clip)
        return background.crop((x, y, x + width, y + height))
    finally:
        connection.close()


def grab(x, y, width, height):
    from PIL import Image, ImageGrab

    display = os.environ.get("DISPLAY")
    # The privacy overlay covers a person's own screen; a chat's own desktop never has one to look under.
    underlay = None if os.environ.get("POCKET_WORKSPACE_ID") else _underlay_capture(x, y, width, height)
    if underlay is not None:
        return underlay.convert("RGB")
    try:
        return ImageGrab.grab(bbox=(x, y, x + width, y + height), xdisplay=display).convert("RGB")
    except Exception as first:
        if not shutil.which("maim"):
            raise RuntimeError("Screenshot failed: %s; install python3-pil with XCB or maim" % first)
        geometry = "%sx%s%+d%+d" % (width, height, x, y)
        proc = subprocess.run(["maim", "--format=png", "--geometry", geometry, "-"], capture_output=True, timeout=30)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf8", "replace").strip() or "maim failed")
        return Image.open(io.BytesIO(proc.stdout)).convert("RGB")


# X11 screenshots leave the pointer out; this arrow stands in for it, so a click that missed shows by how much.
POINTER = [(0, 0), (0, 16), (4, 12), (7, 19), (10, 18), (7, 11), (12, 11)]


def draw_pointer(image, x, y):
    from PIL import ImageDraw

    if not (0 <= x < image.width and 0 <= y < image.height):
        return
    ImageDraw.Draw(image).polygon([(x + dx, y + dy) for dx, dy in POINTER], fill=(0, 0, 0), outline=(255, 255, 255))


def encode(image, x, y, max_width, max_height, pointer=None):
    from PIL import Image

    width, height = image.size
    scale = min(1.0, float(max_width) / width, float(max_height) / height)
    out_width = max(1, round(width * scale))
    out_height = max(1, round(height * scale))
    if (out_width, out_height) != image.size:
        image = image.resize((out_width, out_height), Image.Resampling.LANCZOS)
    else:
        image = image.copy()
    if pointer:
        draw_pointer(image, int((pointer["x"] - x) * out_width / width), int((pointer["y"] - y) * out_height / height))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=80)
    return {
        "image": {
            "mime": "image/jpeg",
            "dataBase64": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "width": out_width,
            "height": out_height,
        },
        "region": {"x": x, "y": y, "width": width, "height": height},
    }


def capture(x, y, width, height, max_width, max_height):
    return encode(grab(x, y, width, height), x, y, max_width, max_height)


def difference(first, second):
    """How many pixels differ clearly between two pictures of one size, and the box around them."""
    from PIL import ImageChops

    red, green, blue = ImageChops.difference(first, second).split()
    mask = ImageChops.lighter(ImageChops.lighter(red, green), blue).point(lambda v: 255 if v > 24 else 0)
    return mask.histogram()[255], mask.getbbox()


def moved(first, second):
    """Whether the screen changed between two pictures by more than a blinking caret or a clock digit."""
    if first is None or second is None or first.size != second.size:
        return True
    return difference(first, second)[0] > first.width * first.height // 4000


def change_between(before, after, scale):
    """What the brain is told: the share of the screen that changed and where, in pixels of the picture sent."""
    count, box = difference(before, after)
    result = {"fraction": round(count / float(after.width * after.height), 5)}
    if box:
        left, top = int(box[0] * scale), int(box[1] * scale)
        result["box"] = {"x": left, "y": top, "width": max(1, int(box[2] * scale + 0.999) - left), "height": max(1, int(box[3] * scale + 0.999) - top)}
    return result


# The last picture sent of each display, to say what changed since; and whether the screen never stood still last time.
FRAMES = {}
STATE = {"restless": False}
PROBE_SECONDS = 0.1


def settle(region, before, image, limit_ms):
    """Waits for the screen to stand still, at most limit_ms: a step's effect may take a moment to show and to finish."""
    if STATE["restless"]:
        # A video or an animation never stops: do not spend the whole wait on it every time.
        limit_ms = min(limit_ms, 600)
    grace_ms = min(limit_ms, 500)
    reacted = before is None or moved(before, image)
    started = time.monotonic()
    settled = False
    while (time.monotonic() - started) * 1000 < limit_ms:
        time.sleep(PROBE_SECONDS)
        latest = grab(*region)
        still = not moved(image, latest)
        image = latest
        if not reacted and moved(before, image):
            reacted = True
        # Nothing has reacted yet: give it the grace period before taking the picture as it is.
        if still and (reacted or (time.monotonic() - started) * 1000 >= grace_ms):
            settled = True
            break
    STATE["restless"] = not settled
    return image, settled


def screenshot(command):
    monitors = displays()
    index = command.get("display", -1)
    index = 0 if index < 0 else index
    if index >= len(monitors):
        raise ValueError("There is no display %s: this computer has %s." % (index, len(monitors)))
    monitor = monitors[index]
    region = (monitor["x"], monitor["y"], monitor["width"], monitor["height"])
    # Someone looking in: the picture is not one the agent saw, so it must not become what the next one is compared with.
    peek = bool(command.get("peek"))
    before = None if peek else FRAMES.get(region)
    image = grab(*region)
    settled = None
    wait_ms = max(0, int(command.get("settleMs") or 0))
    if wait_ms:
        image, settled = settle(region, before, image, wait_ms)
    pointer = cursor()
    result = encode(image, region[0], region[1], command["maxWidth"], command["maxHeight"], pointer)
    if before is not None and before.size == image.size:
        result["change"] = change_between(before, image, result["image"]["width"] / float(image.width))
    if settled is not None:
        result["settled"] = settled
    if not peek:
        FRAMES[region] = image
    result["displays"] = monitors
    result["cursor"] = pointer
    return result


def zoom(command):
    left, top, right, bottom = virtual_bounds()
    x1 = max(left, int(command["x"]))
    y1 = max(top, int(command["y"]))
    x2 = min(right, int(command["x"]) + int(command["width"]))
    y2 = min(bottom, int(command["y"]) + int(command["height"]))
    if x2 - x1 < 4 or y2 - y1 < 4:
        raise ValueError("That region is outside the screen")
    result = capture(x1, y1, x2 - x1, y2 - y1, command["maxWidth"], command["maxHeight"])
    result["cursor"] = cursor()
    return result


BUTTONS = {"left": 1, "middle": 2, "right": 3}

# Every name the agent accepts (keys.ts), lower case, as the X keysym xdotool needs: it ignores names it does not know.
X_KEYS = {
    "ctrl": "Control_L", "control": "Control_L", "ctl": "Control_L", "control_l": "Control_L", "control_r": "Control_R",
    "shift": "Shift_L", "shift_l": "Shift_L", "shift_r": "Shift_R",
    "alt": "Alt_L", "alt_l": "Alt_L", "option": "Alt_L", "alt_r": "Alt_R", "altgr": "ISO_Level3_Shift",
    "super": "Super_L", "super_l": "Super_L", "super_r": "Super_R", "win": "Super_L", "windows": "Super_L",
    "meta": "Super_L", "cmd": "Super_L", "command": "Super_L",
    "return": "Return", "enter": "Return", "kp_enter": "KP_Enter", "tab": "Tab", "escape": "Escape", "esc": "Escape",
    "space": "space", "spacebar": "space", "backspace": "BackSpace",
    "delete": "Delete", "del": "Delete", "insert": "Insert", "ins": "Insert", "home": "Home", "end": "End",
    "page_up": "Prior", "pageup": "Prior", "prior": "Prior", "pgup": "Prior",
    "page_down": "Next", "pagedown": "Next", "next": "Next", "pgdn": "Next",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "arrowup": "Up", "arrowdown": "Down", "arrowleft": "Left", "arrowright": "Right",
    "capslock": "Caps_Lock", "caps_lock": "Caps_Lock", "numlock": "Num_Lock", "num_lock": "Num_Lock",
    "scrolllock": "Scroll_Lock", "scroll_lock": "Scroll_Lock",
    "print": "Print", "printscreen": "Print", "prtsc": "Print", "pause": "Pause",
    "menu": "Menu", "apps": "Menu", "contextmenu": "Menu",
    "volume_up": "XF86AudioRaiseVolume", "xf86audioraisevolume": "XF86AudioRaiseVolume",
    "volume_down": "XF86AudioLowerVolume", "xf86audiolowervolume": "XF86AudioLowerVolume",
    "volume_mute": "XF86AudioMute", "mute": "XF86AudioMute", "xf86audiomute": "XF86AudioMute",
    "media_play_pause": "XF86AudioPlay", "xf86audioplay": "XF86AudioPlay",
    "media_next": "XF86AudioNext", "xf86audionext": "XF86AudioNext",
    "media_prev": "XF86AudioPrev", "xf86audioprev": "XF86AudioPrev",
    "browser_back": "XF86Back", "browser_forward": "XF86Forward", "browser_refresh": "XF86Reload",
    "kp_add": "KP_Add", "kp_subtract": "KP_Subtract", "kp_multiply": "KP_Multiply", "kp_divide": "KP_Divide",
    "kp_decimal": "KP_Decimal",
    "minus": "minus", "plus": "plus", "equal": "equal", "comma": "comma", "period": "period", "slash": "slash",
    "backslash": "backslash", "semicolon": "semicolon", "colon": "colon", "apostrophe": "apostrophe",
    "quote": "apostrophe", "quotedbl": "quotedbl", "grave": "grave", "backtick": "grave",
    "bracketleft": "bracketleft", "bracketright": "bracketright", "braceleft": "braceleft", "braceright": "braceright",
    "less": "less", "greater": "greater", "question": "question", "exclam": "exclam", "at": "at",
    "numbersign": "numbersign", "dollar": "dollar", "percent": "percent", "asciicircum": "asciicircum",
    "ampersand": "ampersand", "asterisk": "asterisk", "parenleft": "parenleft", "parenright": "parenright",
    "underscore": "underscore", "bar": "bar", "asciitilde": "asciitilde",
}
VK_NAMES = {
    0x08: "BackSpace", 0x09: "Tab", 0x0D: "Return", 0x10: "Shift_L", 0x11: "Control_L",
    0x12: "Alt_L", 0x13: "Pause", 0x14: "Caps_Lock", 0x1B: "Escape", 0x20: "space",
    0x21: "Prior", 0x22: "Next", 0x23: "End", 0x24: "Home", 0x25: "Left",
    0x26: "Up", 0x27: "Right", 0x28: "Down", 0x2C: "Print", 0x2D: "Insert", 0x2E: "Delete",
    0x5B: "Super_L", 0x5C: "Super_R", 0x5D: "Menu", 0x90: "Num_Lock", 0x91: "Scroll_Lock",
    0xA0: "Shift_L", 0xA1: "Shift_R", 0xA2: "Control_L", 0xA3: "Control_R", 0xA4: "Alt_L",
    0xA5: "ISO_Level3_Shift", 0x6B: "KP_Add", 0x6D: "KP_Subtract", 0x6A: "KP_Multiply",
    0x6F: "KP_Divide", 0x6E: "KP_Decimal",
    0xAD: "XF86AudioMute", 0xAE: "XF86AudioLowerVolume", 0xAF: "XF86AudioRaiseVolume",
    0xB0: "XF86AudioNext", 0xB1: "XF86AudioPrev", 0xB3: "XF86AudioPlay",
    0xA6: "XF86Back", 0xA7: "XF86Forward", 0xA8: "XF86Reload",
}
PUNCTUATION = {
    "-": "minus", "+": "plus", "=": "equal", ",": "comma", ".": "period", "/": "slash",
    "\\": "backslash", ";": "semicolon", ":": "colon", "'": "apostrophe", '"': "quotedbl",
    "`": "grave", "[": "bracketleft", "]": "bracketright", "{": "braceleft", "}": "braceright",
    "<": "less", ">": "greater", "?": "question", "!": "exclam", "@": "at", "#": "numbersign",
    "$": "dollar", "%": "percent", "^": "asciicircum", "&": "ampersand", "*": "asterisk",
    "(": "parenleft", ")": "parenright", "_": "underscore", "|": "bar", "~": "asciitilde", " ": "space",
}


def char_key(char):
    """A single character as a key: "A" is the A key, as on Windows, so "ctrl+A" does not turn into ctrl+shift+a."""
    if char in PUNCTUATION:
        return PUNCTUATION[char]
    if char.isascii() and char.isalnum():
        return char.lower()
    return "U%04X" % ord(char)


def key_name(name):
    """The X keysym for a key name however it is written ("Backspace", "ESC", "page-down", "f5"), or None."""
    value = str(name)
    if len(value) == 1:
        return char_key(value)
    lower = value.lower().replace("-", "_")
    known = X_KEYS.get(lower) or X_KEYS.get(lower.replace("_", ""))
    if known:
        return known
    function = re.match(r"^f([1-9]|1\d|2[0-4])$", lower)
    if function:
        return "F" + function.group(1)
    keypad = re.match(r"^kp_(\d)$", lower)
    if keypad:
        return "KP_" + keypad.group(1)
    return None


def vk_name(code):
    if code & 0x10000:
        return char_key(chr(code & 0xFFFF))
    base = code & 0xFF
    if 0x41 <= base <= 0x5A:
        return chr(base + 32)
    if 0x30 <= base <= 0x39:
        return chr(base)
    if 0x60 <= base <= 0x69:
        return "KP_%d" % (base - 0x60)
    if 0x70 <= base <= 0x87:
        return "F%d" % (base - 0x6F)
    name = VK_NAMES.get(base)
    if not name:
        raise ValueError("This computer has no key for code %s" % base)
    return name


def named_keys(names, codes):
    """Key names as X keysyms; a name this table lacks falls back to the code the agent worked out for it."""
    result = []
    for index, name in enumerate(names or []):
        known = key_name(name)
        if known is None and codes is not None and index < len(codes):
            known = vk_name(codes[index])
        if known is None:
            raise ValueError('Unknown key "%s". Use names like ctrl, shift, alt, super, Return, Tab, Escape, BackSpace, Delete, Home, End, Page_Up, Up, F5, or single characters.' % name)
        result.append(known)
    return result


def combos_for(command):
    codes = command.get("combos") or []
    names = command.get("names")
    if names is not None:
        return [named_keys(combo, codes[index] if index < len(codes) else None) for index, combo in enumerate(names)]
    return [[vk_name(code) for code in combo] for combo in codes]


def modifiers_for(command):
    names = command.get("modNames")
    if names is not None:
        return named_keys(names, command.get("mods"))
    return [vk_name(code) for code in command.get("mods", [])]


def xdo(args, timeout=30):
    """xdotool exits with 0 after skipping a key it does not know; that must not pass for a key pressed."""
    proc = run(["xdotool"] + args, timeout=timeout)
    skipped = re.search(r"No such key name '([^']*)'", proc.stderr or "")
    if skipped:
        raise RuntimeError('This keyboard has no key "%s"' % skipped.group(1))
    return proc


def move(x, y):
    run(["xdotool", "mousemove", str(x), str(y)])
    return {"cursor": {"x": x, "y": y}}


def click(command):
    if command.get("at"):
        move(command["x"], command["y"])
        time.sleep(0.06)
    modifiers = modifiers_for(command)
    held = []
    try:
        for name in modifiers:
            xdo(["keydown", name])
            held.append(name)
        # No --clearmodifiers here: xdotool then "restores" the button it has just let go of and leaves it held down.
        count = max(1, min(3, command.get("count", 1)))
        run(["xdotool", "click", "--repeat", str(count), "--delay", "80", str(BUTTONS[command.get("button", "left")])])
    finally:
        for name in reversed(held):
            run(["xdotool", "keyup", name], check=False)
    return {"cursor": cursor()}


def button(command):
    action = "mousedown" if command["down"] else "mouseup"
    run(["xdotool", action, str(BUTTONS[command.get("button", "left")])])
    return {"cursor": cursor()}


def drag(command):
    points = command["path"]
    if len(points) < 4:
        raise ValueError("A drag needs a start and an end point")
    move(points[0], points[1])
    time.sleep(0.06)
    run(["xdotool", "mousedown", str(BUTTONS[command.get("button", "left")])])
    try:
        # Programs tell a drag from a click by a held button that then moves, and a drop by a pause over the target.
        time.sleep(0.08)
        cx, cy = points[0], points[1]
        for index in range(2, len(points) - 1, 2):
            tx, ty = points[index], points[index + 1]
            steps = max(4, min(40, int(((tx - cx) ** 2 + (ty - cy) ** 2) ** 0.5 / 20)))
            for step in range(1, steps + 1):
                run(["xdotool", "mousemove", str(round(cx + (tx - cx) * step / steps)), str(round(cy + (ty - cy) * step / steps))])
                time.sleep(0.012)
            cx, cy = tx, ty
        time.sleep(0.12)
    finally:
        run(["xdotool", "mouseup", str(BUTTONS[command.get("button", "left")])], check=False)
    return {"cursor": cursor()}


def scroll(command):
    if command.get("at"):
        move(command["x"], command["y"])
        time.sleep(0.04)
    modifiers = modifiers_for(command)
    held = []
    try:
        for name in modifiers:
            xdo(["keydown", name])
            held.append(name)
        for amount, forward, back in ((command.get("dy", 0), "5", "4"), (command.get("dx", 0), "7", "6")):
            if amount:
                run(["xdotool", "click", "--repeat", str(abs(amount)), "--delay", "25", forward if amount > 0 else back])
    finally:
        for name in reversed(held):
            run(["xdotool", "keyup", name], check=False)
    return {"cursor": cursor()}


def keyboard_layout(dump):
    """`xmodmap -pke` as keycode → the symbols on that key, as printed; an empty string for a key with none."""
    layout = {}
    for line in dump.splitlines():
        match = re.match(r"^keycode\s+(\d+)\s*=\s*(.*)$", line)
        if match:
            layout[int(match.group(1))] = match.group(2).strip()
    return layout


SYMBOL_CHARS = {}


def layout_characters(layout):
    """
    The characters the keys already type, read the way xdotool reads them: a layout with Russian in it needs no
    borrowed keys for Russian. The two libraries are the ones xdotool itself is built on.
    """
    try:
        import ctypes
        import ctypes.util

        if "x11" not in SYMBOL_CHARS:
            x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
            xkb = ctypes.CDLL(ctypes.util.find_library("xkbcommon") or "libxkbcommon.so.0")
            x11.XStringToKeysym.restype = ctypes.c_ulong
            x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
            xkb.xkb_keysym_to_utf32.restype = ctypes.c_uint32
            xkb.xkb_keysym_to_utf32.argtypes = [ctypes.c_uint32]
            SYMBOL_CHARS["x11"] = (x11, xkb)
        x11, xkb = SYMBOL_CHARS["x11"]
        chars = set()
        for symbols in layout.values():
            for name in symbols.split():
                if name not in SYMBOL_CHARS:
                    keysym = x11.XStringToKeysym(name.encode("utf8"))
                    code = xkb.xkb_keysym_to_utf32(keysym & 0xFFFFFFFF) if keysym else 0
                    SYMBOL_CHARS[name] = chr(code) if 0x20 <= code <= 0x10FFFF else ""
                if SYMBOL_CHARS[name]:
                    chars.add(SYMBOL_CHARS[name])
        return chars
    except (OSError, AttributeError, ValueError, TypeError):
        return set()


def needs_key(char, native=()):
    """Characters xdotool would have to borrow a key for: not plain ASCII, not Enter or Tab, not on the layout."""
    return not (" " <= char <= "~" or char in "\n\t" or char in native)


def typing_chunks(text, capacity, native=()):
    """Splits text so that each piece needs at most `capacity` characters put on spare keys."""
    chunks, start, needed = [], 0, set()
    for index, char in enumerate(text):
        if needs_key(char, native) and char not in needed:
            if len(needed) >= capacity:
                chunks.append((text[start:index], needed))
                start, needed = index, set()
            needed.add(char)
    if start < len(text):
        chunks.append((text[start:], needed))
    return chunks


def free_keys(layout):
    """Keys with nothing on them, highest first; the lowest is left alone, xdotool needs one to work with itself."""
    return sorted((code for code, symbols in layout.items() if not symbols), reverse=True)[:-1]


def assign_keys(chars, layout, borrowed):
    """
    Which keys to rewrite with which characters, two to a key (the second typed with Shift). Borrowed keys whose
    characters are all wanted stay; the rest go on the free keys first, then on the keys borrowed longest ago.
    """
    kept = [code for code, (held, _) in borrowed.items() if all(char in chars for char in held)]
    have = {char for code in kept for char in borrowed[code][0]}
    missing = [char for char in sorted(chars) if char not in have]
    pool = free_keys(layout) + [code for code in borrowed if code not in kept]
    pairs = ["".join(missing[index:index + 2]) for index in range(0, len(missing), 2)]
    return list(zip(pool, pairs))


# Keys this helper put characters on: keycode → (the characters, how xmodmap prints the key since). Oldest first.
BORROWED = {}
SAVED = {"loaded": False}


def keys_file():
    """Where the borrowed keys are noted, so a helper started later knows them as its own and can reuse them."""
    folder = os.environ.get("XDG_RUNTIME_DIR") or os.path.join(str(Path.home()), ".cache")
    return os.path.join(folder, "pocket-computer-keys%s.json" % re.sub(r"[^A-Za-z0-9]", "_", os.environ.get("DISPLAY", "")))


def load_borrowed():
    if SAVED["loaded"]:
        return
    SAVED["loaded"] = True
    try:
        with open(keys_file(), encoding="utf8") as handle:
            for code, held, printed in json.load(handle):
                BORROWED[int(code)] = (str(held), str(printed))
    except (OSError, ValueError, TypeError):
        pass


def save_borrowed():
    try:
        os.makedirs(os.path.dirname(keys_file()), exist_ok=True)
        with open(keys_file(), "w", encoding="utf8") as handle:
            json.dump([[code, held, printed] for code, (held, printed) in BORROWED.items()], handle)
    except OSError:
        pass


def read_layout():
    """The keys as they are now; borrowed ones a layout switch has wiped are forgotten."""
    layout = keyboard_layout(run(["xmodmap", "-pke"], check=False).stdout)
    load_borrowed()
    for code in [code for code, (_, printed) in BORROWED.items() if layout.get(code) != printed]:
        del BORROWED[code]
    return layout


def place_characters(chars):
    """
    Puts characters the keyboard layout lacks on spare keys before they are typed. xdotool does this itself one
    character at a time and takes the key back at once; a busy program then reads the key after it is gone, and
    letters go missing or come out as their neighbours. Placed ahead of time and left there, every program has them.
    Returns whether every character now has a key.
    """
    if not chars:
        return True
    if not shutil.which("xmodmap"):
        return False
    plan = assign_keys(chars, read_layout(), BORROWED)
    if plan:
        expressions = []
        for code, held in plan:
            expressions += ["-e", "keycode %d = %s" % (code, " ".join("U%04X" % ord(char) for char in held))]
            BORROWED.pop(code, None)
        run(["xmodmap"] + expressions, check=False)
        # Every program, the window manager first, re-reads the keys when one changes; typing waits for that.
        time.sleep(0.15 + 0.01 * len(plan))
        after = keyboard_layout(run(["xmodmap", "-pke"], check=False).stdout)
        for code, held in plan:
            if after.get(code):
                BORROWED[code] = (held, after[code])
        save_borrowed()
    return set(chars) <= {char for held, _ in BORROWED.values() for char in held}


def type_text(command):
    text = command["text"].replace("\r\n", "\n").replace("\r", "\n")
    layout = read_layout() if shutil.which("xmodmap") else {}
    native = layout_characters(layout) - {char for held, _ in BORROWED.values() for char in held}
    capacity = 2 * (len(free_keys(layout)) + len(BORROWED))
    for chunk, needed in typing_chunks(text, max(1, capacity), native):
        placed = place_characters(needed)
        # A character still without a key of its own takes xdotool's slower way: leave each one time to arrive.
        xdo(["type", "--clearmodifiers", "--delay", "8" if placed else "40", "--", chunk], timeout=max(30, len(chunk) // 15 + 30))
    return {"cursor": cursor()}


FUNCTION_KEY = re.compile(r"^F\d{1,2}$")


def by_code(names):
    """
    Function keys as key codes. On keyboards where a function key also switches consoles (Ctrl+Alt+F5), xdotool takes
    the name "F5" for a key that needs Alt and holds Alt down with it; named by its code, the key is pressed alone.
    """
    if not any(FUNCTION_KEY.match(name) for name in names) or not shutil.which("xmodmap"):
        return names
    layout = keyboard_layout(run(["xmodmap", "-pke"], check=False).stdout)
    codes = {}
    for code in sorted(layout, reverse=True):
        symbols = layout[code].split()
        if symbols:
            codes[symbols[0]] = str(code)
    return [codes.get(name, name) if FUNCTION_KEY.match(name) else name for name in names]


def keys(command):
    result = {"cursor": cursor()}
    for combo in combos_for(command):
        combo = by_code(combo)
        hold = max(0, int(command.get("holdMs", 0)))
        if hold:
            held = []
            try:
                for name in combo:
                    xdo(["keydown", name])
                    held.append(name)
                time.sleep(hold / 1000)
            finally:
                for name in reversed(held):
                    run(["xdotool", "keyup", name], check=False)
        else:
            xdo(["key", "--clearmodifiers", "--delay", "12", "+".join(combo)])
        time.sleep(0.04)
        result = {"cursor": cursor()}
    return result


def unquote(value):
    """One xprop string: quotes off, its backslash escapes undone (octal bytes are UTF-8 printed in a plain locale)."""
    text = value.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1]
    data = bytearray()
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            octal = re.match(r"[0-7]{3}", text[index + 1:index + 4])
            if octal:
                data.append(int(octal.group(0), 8) & 0xFF)
                index += 4
                continue
            data += {"n": "\n", "t": "\t"}.get(text[index + 1], text[index + 1]).encode("utf8")
            index += 2
            continue
        data += char.encode("utf8")
        index += 1
    return data.decode("utf8", "replace")


def parse_xprop(text):
    """`xprop` output as name → raw value; properties that are not set are left out."""
    values = {}
    for line in text.splitlines():
        # Most values follow " = "; window ids follow ": window id # ".
        match = re.match(r"^([A-Za-z0-9_]+)\([A-Za-z0-9_]+\)(?: =|:) ?(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def window_ids(value):
    return [int(v, 16) for v in re.findall(r"0x[0-9a-fA-F]+", value or "") if int(v, 16)]


def xprop(target, names):
    return parse_xprop(run(["xprop"] + target + names, check=False).stdout)


def parse_tree(text):
    """
    `xwininfo -root -tree` as window id → where its content is on the desktop. wmctrl and xdotool count a window
    manager's frame twice, which puts every window a title bar's height off.
    """
    places = {}
    pattern = re.compile(r"^\s*(0x[0-9a-fA-F]+) .*\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+(-?\d+)\+(-?\d+)\s*$")
    for line in text.splitlines():
        match = pattern.match(line)
        if match:
            places[int(match.group(1), 16)] = {"x": int(match.group(4)), "y": int(match.group(5)), "width": int(match.group(2)), "height": int(match.group(3))}
    return places


def numbers(value):
    return [int(v) for v in re.findall(r"-?\d+", value or "")]


def outline(place, frame, shadow):
    """The window as a person sees it: its content plus the window manager's frame, less a toolkit's own shadow."""
    left, right, top, bottom = (frame + [0, 0, 0, 0])[:4] if len(frame) >= 4 else (0, 0, 0, 0)
    if len(shadow) >= 4:
        left, right, top, bottom = -shadow[0], -shadow[1], -shadow[2], -shadow[3]
    return {"x": place["x"] - left, "y": place["y"] - top, "width": max(0, place["width"] + left + right), "height": max(0, place["height"] + top + bottom)}


# Windows a person does not switch to: the desktop itself, panels, menus and the like.
NOT_WINDOWS = ("_DESKTOP", "_DOCK", "_TOOLBAR", "_MENU", "_SPLASH", "_DROPDOWN_MENU", "_POPUP_MENU", "_TOOLTIP", "_NOTIFICATION", "_COMBO", "_DND")
# Names that say nothing about the program: the window class is the better label.
WRAPPERS = ("python", "python3", "electron", "java", "bwrap", "sh", "bash", "node", "wine", "wine64-preloader", "wine-preloader")


def stacking():
    """Window ids from the front one back, and the active one. Window managers list them bottom first."""
    root = xprop(["-root"], ["_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST", "_NET_ACTIVE_WINDOW"])
    front_first = list(reversed(window_ids(root.get("_NET_CLIENT_LIST_STACKING"))))
    for other in window_ids(root.get("_NET_CLIENT_LIST")):
        if other not in front_first:
            front_first.append(other)
    active = window_ids(root.get("_NET_ACTIVE_WINDOW"))
    return front_first, (active[0] if active else 0)


def window_facts(window):
    props = xprop(["-id", hex(window)], ["_NET_WM_NAME", "WM_NAME", "WM_CLASS", "_NET_WM_PID", "_NET_WM_STATE", "_NET_WM_WINDOW_TYPE", "WM_TRANSIENT_FOR", "_NET_FRAME_EXTENTS", "_GTK_FRAME_EXTENTS"])
    classes = [unquote(c) for c in re.findall(r'"(?:[^"\\]|\\.)*"', props.get("WM_CLASS", ""))]
    process = ""
    pid = re.match(r"\d+", props.get("_NET_WM_PID", ""))
    if pid:
        try:
            process = Path("/proc/%s/comm" % pid.group(0)).read_text().strip()
        except OSError:
            process = ""
    if (not process or process.lower() in WRAPPERS) and classes:
        process = classes[0]
    return {
        "title": unquote(props["_NET_WM_NAME"]) if props.get("_NET_WM_NAME") else unquote(props.get("WM_NAME", "")),
        "classes": classes,
        "process": process,
        "state": props.get("_NET_WM_STATE", ""),
        "type": props.get("_NET_WM_WINDOW_TYPE", ""),
        "transient": (window_ids(props.get("WM_TRANSIENT_FOR")) or [0])[0],
        "frame": numbers(props.get("_NET_FRAME_EXTENTS")),
        "shadow": numbers(props.get("_GTK_FRAME_EXTENTS")),
    }


def listed(facts):
    if not facts["title"] or facts["title"] == "Pocket Blocker":
        return False
    if any(c.lower().startswith("pocket-blocker") for c in facts["classes"]):
        return False
    return not any(facts["type"].endswith(kind) or (kind + ",") in facts["type"] for kind in NOT_WINDOWS)


def windows():
    monitors = displays()
    order, active = stacking()
    places = parse_tree(run(["xwininfo", "-root", "-tree"], check=False).stdout)
    result = []
    for window in order:
        facts = window_facts(window)
        if not listed(facts):
            continue
        place = outline(places.get(window) or {"x": 0, "y": 0, "width": 0, "height": 0}, facts["frame"], facts["shadow"])
        minimized = "_NET_WM_STATE_HIDDEN" in facts["state"]
        entry = {
            "handle": str(window), "title": facts["title"], "process": facts["process"],
            "x": place["x"], "y": place["y"], "width": place["width"], "height": place["height"],
            "minimized": minimized,
            "maximized": "_NET_WM_STATE_MAXIMIZED_HORZ" in facts["state"] and "_NET_WM_STATE_MAXIMIZED_VERT" in facts["state"],
            "focused": window == active,
        }
        center_x = place["x"] + place["width"] // 2
        center_y = place["y"] + place["height"] // 2
        display_index = next((m["index"] for m in monitors if m["x"] <= center_x < m["x"] + m["width"] and m["y"] <= center_y < m["y"] + m["height"]), None)
        if display_index is not None and not minimized:
            entry["display"] = display_index
        result.append(entry)
    return {"windows": result, "displays": monitors}


def in_front(window):
    """The window is active, or a dialog of its own is (a Save box in front of its editor)."""
    active = stacking()[1]
    if active == window:
        return True
    return bool(active) and window_facts(active)["transient"] == window


def state_of(window):
    return xprop(["-id", hex(window)], ["_NET_WM_STATE"]).get("_NET_WM_STATE", "")


def activate(window):
    """Brings a window to the front and checks that it got there; window managers may refuse a plain request."""
    handle = str(window)
    if in_front(window):
        return True
    for request in (["xdotool", "windowactivate", handle], ["wmctrl", "-i", "-a", hex(window)]):
        run(request, check=False, timeout=10)
        if wait_until(lambda: in_front(window), 700):
            return True
    # Past the window manager: raise the window and hand it the keyboard directly.
    run(["xdotool", "windowmap", handle], check=False, timeout=10)
    run(["xdotool", "windowraise", handle], check=False, timeout=10)
    run(["xdotool", "windowfocus", handle], check=False, timeout=10)
    focused = run(["xdotool", "getwindowfocus"], check=False, timeout=10).stdout.strip()
    return in_front(window) or focused == handle


FRONT = "The window is now in front."
NOT_FRONT = "The window manager did not bring the window to the front; click on it instead."


def window(command):
    handle = int(command["handle"])
    xid = hex(handle)
    what = command["what"]
    if handle not in stacking()[0]:
        raise ValueError("That window no longer exists; list the windows again")
    if what == "focus":
        text = FRONT if activate(handle) else NOT_FRONT
    elif what == "minimize":
        run(["xdotool", "windowminimize", str(handle)])
        text = "Minimized." if wait_until(lambda: "_NET_WM_STATE_HIDDEN" in state_of(handle), 800) else "The window did not minimize."
    elif what == "maximize":
        run(["wmctrl", "-i", "-r", xid, "-b", "add,maximized_vert,maximized_horz"])
        front = activate(handle)
        full = wait_until(lambda: "MAXIMIZED_VERT" in state_of(handle) and "MAXIMIZED_HORZ" in state_of(handle), 800)
        text = ("Maximized." if full else "The window did not maximize; it may have a fixed size.") + ("" if front else " " + NOT_FRONT)
    elif what == "restore":
        run(["wmctrl", "-i", "-r", xid, "-b", "remove,maximized_vert,maximized_horz"])
        front = activate(handle)
        # The window manager was asked, not made to: wait until the window has left its maximized state.
        wait_until(lambda: "MAXIMIZED" not in state_of(handle), 800)
        text = "Restored." if front else "Restored. " + NOT_FRONT
    elif what == "close":
        run(["wmctrl", "-i", "-c", xid])
        gone = wait_until(lambda: handle not in stacking()[0], 1500)
        text = "Closed." if gone else "Asked the window to close; it is still open, maybe asking to save."
    else:
        raise ValueError("Unknown window operation: " + what)
    return {"text": text}


# Names people (and Claude, used to Windows) call programs by, as commands to try here in order.
PROGRAMS = {
    "terminal": ["x-terminal-emulator", "xfce4-terminal", "qterminal", "konsole", "gnome-terminal", "xterm"],
    "browser": ["x-www-browser", "sensible-browser", "firefox", "firefox-esr", "chromium", "google-chrome"],
    "chrome": ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
    "firefox": ["firefox", "firefox-esr"],
    "editor": ["mousepad", "gedit", "kate", "kwrite", "xed", "pluma", "featherpad", "leafpad", "gnome-text-editor"],
    "files": ["thunar", "dolphin", "nautilus", "pcmanfm", "nemo", "caja"],
    "calculator": ["gnome-calculator", "galculator", "kcalc", "mate-calc", "xcalc"],
}
PROGRAMS.update({"powershell": PROGRAMS["terminal"], "cmd": PROGRAMS["terminal"], "console": PROGRAMS["terminal"],
                 "notepad": PROGRAMS["editor"], "explorer": PROGRAMS["files"], "calc": PROGRAMS["calculator"]})


def desktop_dirs():
    home = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    shared = (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":")
    extra = ["/var/lib/flatpak/exports/share", str(Path.home() / ".local/share/flatpak/exports/share"), "/var/lib/snapd/desktop"]
    seen = []
    for base in [home] + shared + extra:
        folder = os.path.join(base, "applications")
        if base and folder not in seen:
            seen.append(folder)
    return seen


def read_desktop_entry(path):
    """The few lines of a .desktop file that say what it starts: Name, GenericName, Exec, Terminal."""
    entry = {"names": [], "exec": "", "terminal": False, "hidden": False}
    section = ""
    try:
        with open(path, encoding="utf8", errors="replace") as handle:
            for raw in handle:
                line = raw.strip()
                if line.startswith("["):
                    section = line
                    continue
                if section != "[Desktop Entry]" or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key.split("[", 1)[0] in ("Name", "GenericName"):
                    entry["names"].append(value.strip())
                elif key == "Exec":
                    entry["exec"] = value.strip()
                elif key == "Terminal":
                    entry["terminal"] = value.strip().lower() == "true"
                elif key in ("Hidden", "NoDisplay") and value.strip().lower() == "true":
                    entry["hidden"] = True
    except OSError:
        return None
    return entry if entry["exec"] else None


def match_rank(want, names):
    """How well a program's names fit what was asked for: 0 exact, then starts with, then contains; None for no fit."""
    best = None
    for name in names:
        lower = name.lower()
        rank = 0 if lower == want else 1 if lower.startswith(want) else 2 if want in lower else None
        if rank is not None:
            rank = rank * 1000 + len(lower)
            best = rank if best is None else min(best, rank)
    return best


def find_desktop_entry(target, folders=None):
    """The installed program whose menu entry fits the name best, as (command line, runs in a terminal)."""
    want = target.strip().lower()
    if not want or "/" in want:
        return None
    best = None
    for folder in folders if folders is not None else desktop_dirs():
        try:
            files = sorted(os.listdir(folder))
        except OSError:
            continue
        for name in files:
            if not name.endswith(".desktop"):
                continue
            entry = read_desktop_entry(os.path.join(folder, name))
            if not entry:
                continue
            rank = match_rank(want, [name[:-8], name[:-8].split(".")[-1]] + entry["names"])
            if rank is None:
                continue
            rank += 100000 if entry["hidden"] else 0
            if best is None or rank < best[0]:
                best = (rank, entry)
    if not best:
        return None
    # Field codes stand for files and addresses the menu would pass; there are none here.
    words = [w for w in shlex.split(best[1]["exec"]) if not re.match(r"^%[a-zA-Z]$", w)]
    return [w.replace("%%", "%") for w in words], best[1]["terminal"]


def resolve_target(target, args):
    """What to run for `open`: a program by path, name, nickname or menu entry; else the file, folder or address."""
    expanded = os.path.expandvars(os.path.expanduser(target))
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) and not os.path.exists(expanded):
        return ["xdg-open", target] + args, True
    if os.path.exists(expanded):
        runnable = os.path.isfile(expanded) and os.access(expanded, os.X_OK) and ("/" in target)
        return ([expanded] + args, False) if runnable else (["xdg-open", expanded] + args, True)
    found = shutil.which(target)
    if found:
        return [found] + args, False
    for name in PROGRAMS.get(target.strip().lower(), []):
        found = shutil.which(name)
        if found:
            return [found] + args, False
    entry = find_desktop_entry(target)
    if entry:
        words, in_terminal = entry
        # A menu entry may name its program by full path. In a chat's own desktop the program of that name that comes
        # first on PATH is the one to start: for a browser that is the wrapper with this desktop's profile.
        if os.environ.get("POCKET_WORKSPACE_ID") and words and "/" in words[0]:
            words = [shutil.which(os.path.basename(words[0])) or words[0]] + words[1:]
        terminal = next((shutil.which(t) for t in PROGRAMS["terminal"] if shutil.which(t)), None)
        if in_terminal and terminal:
            return [terminal, "-e"] + words + args, False
        return words + args, False
    raise RuntimeError("Could not open %s: there is no program, file or folder by that name on this Linux computer. Use the program's command (firefox, xfce4-terminal), a full path, or a URL." % target)


def drain(stream, kept):
    """Reads a started program's error output to the end, so it never blocks on a full pipe; keeps the start."""
    try:
        for chunk in iter(lambda: stream.read(4096), b""):
            if len(kept) < 4000:
                kept.extend(chunk[:4000 - len(kept)])
    except (OSError, ValueError):
        pass


PROGRAM_LOG_LIMIT = 1024 * 1024


def program_log():
    """
    Where a program opened on a chat's own desktop writes its errors: a file of that desktop, as (handle, path, size
    so far). A pipe read by this helper ends with the helper, and a program that then writes to it is ended by the
    write; the desktop outlives its helpers. None on a person's desktop, where the pipe is kept.
    """
    folder = os.environ.get("POCKET_WORKSPACE_DIR")
    if not folder or not os.environ.get("POCKET_WORKSPACE_ID"):
        return None
    path = os.path.join(folder, "log", "programs.log")
    try:
        handle = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    except OSError:
        return None
    size = os.fstat(handle).st_size
    if size > PROGRAM_LOG_LIMIT:
        # Every program appends, so each goes on writing at the new end.
        os.ftruncate(handle, 0)
        size = 0
    return handle, path, size


def note_started(proc):
    """
    Writes down a program opened on a chat's own desktop, as "pid start-time", in the file the desktop's manager
    names. The manager ends what is listed there when the desktop closes; this helper may by then have been
    replaced by another, which knows nothing of what this one started.
    """
    record = STARTED_RECORD
    if not record or not os.environ.get("POCKET_WORKSPACE_ID"):
        return
    try:
        stat = Path("/proc/%s/stat" % proc.pid).read_text()
        # The name in brackets may hold spaces and brackets; the fields are counted after the last one.
        started = stat[stat.rindex(")") + 2:].split(" ")[19]
        handle = os.open(record, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(handle, ("%s %s\n" % (proc.pid, started)).encode("ascii"))
        finally:
            os.close(handle)
    except (OSError, ValueError, IndexError):
        pass


def open_target(command):
    target = command["target"].strip()
    args = shlex.split(command.get("args") or "")
    words, hands_over = resolve_target(target, args)
    before, _ = stacking()
    errors = bytearray()
    log = program_log()
    try:
        proc = subprocess.Popen(words, cwd=str(Path.home()), start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log[0] if log else subprocess.PIPE)
    except OSError as error:
        raise RuntimeError("Could not open %s: %s" % (target, error))
    finally:
        if log:
            os.close(log[0])
    STARTED.append(proc)
    STARTED[:] = [p for p in STARTED if p.poll() is None]
    note_started(proc)
    if not log:
        threading.Thread(target=drain, args=(proc.stderr, errors), daemon=True).start()
    fresh = []

    def appeared():
        fresh[:] = [w for w in stacking()[0] if w not in before and listed(window_facts(w))]
        return bool(fresh) or (proc.poll() is not None and proc.returncode != 0)

    wait_until(appeared, 4000, step=0.1)
    if not fresh and proc.poll() is not None and proc.returncode != 0:
        time.sleep(0.05)
        if log:
            try:
                with open(log[1], "rb") as written:
                    written.seek(log[2])
                    errors += written.read(4000)
            except OSError:
                pass
        detail = errors.decode("utf8", "replace").strip().splitlines()
        raise RuntimeError("Could not open %s: %s" % (target, detail[-1] if detail else "%s exited with %s" % (words[0], proc.returncode)))
    if fresh:
        title = window_facts(fresh[0])["title"]
        front = activate(fresh[0])
        return {"text": 'Started %s: its window "%s" %s.' % (target, title, "is in front" if front else "is open but not in front; focus_window it")}
    if hands_over:
        return {"text": "Opened %s; no new window appeared, so a program that was already running took it. Look for it with list_windows." % target}
    return {"text": "Started %s (process %s); it has not shown a window yet. Wait and look again rather than starting it twice." % (target, proc.pid)}


def release():
    for name in ["Shift_L", "Shift_R", "Control_L", "Control_R", "Alt_L", "Alt_R", "ISO_Level3_Shift", "Super_L", "Super_R"]:
        run(["xdotool", "keyup", name], check=False)
    for number in [1, 2, 3]:
        run(["xdotool", "mouseup", str(number)], check=False)
    return {"text": "Let go of all keys and mouse buttons."}


def invoke(command):
    operation = command.get("op")
    if operation == "screenshot":
        return screenshot(command)
    if operation == "zoom":
        return zoom(command)
    if operation == "move":
        return move(command["x"], command["y"])
    if operation == "click":
        return click(command)
    if operation == "button":
        return button(command)
    if operation == "drag":
        return drag(command)
    if operation == "scroll":
        return scroll(command)
    if operation == "type":
        return type_text(command)
    if operation == "keys":
        return keys(command)
    if operation == "cursor":
        return {"cursor": cursor()}
    if operation == "windows":
        return windows()
    if operation == "window":
        return window(command)
    if operation == "open":
        return open_target(command)
    if operation == "release":
        return release()
    raise ValueError("Unknown operation: %s" % operation)


# Programs this helper started, as its own children: nothing here is found by name or by a remembered pid.
STARTED = []
# Where the manager of a chat's desktop wants them written down. Taken out of the environment: it is this helper's
# business, and the programs it starts inherit everything that is left in there.
STARTED_RECORD = os.environ.pop("POCKET_WORKSPACE_STARTED", None)


def end_started(*_):
    """A chat's own desktop is closing: the programs opened on it go with it. On a person's desktop they stay."""
    if os.environ.get("POCKET_WORKSPACE_ID"):
        for proc in STARTED:
            if proc.poll() is None:
                try:
                    # Each was started as the leader of its own session, so the group is that program and its children.
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
    sys.exit(0)


def end_alone(*_):
    """This helper is being replaced, its desktop stays: a step under way ends here, what is open stays open."""
    sys.exit(0)


def check_environment():
    if not sys.platform.startswith("linux"):
        raise RuntimeError("The X11 computer host runs on Linux only")
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("DISPLAY is empty. Start the agent inside the Kali X11 graphical session.")
    # A chat's own desktop is always X11, whatever the person's session is.
    if not os.environ.get("POCKET_WORKSPACE_ID") and os.environ.get("XDG_SESSION_TYPE", "x11").lower() == "wayland":
        raise RuntimeError("Wayland is not supported by this backend. Choose the X11 session at the Kali login screen.")
    for name in ["xdotool", "wmctrl", "xrandr", "xprop", "xwininfo"]:
        if not shutil.which(name):
            raise RuntimeError("Missing required command: " + name)


def main():
    check_environment()
    signal.signal(signal.SIGTERM, end_started)
    signal.signal(signal.SIGUSR1, end_alone)
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()
    for raw in sys.stdin:
        if not raw.strip():
            continue
        request_id = 0
        try:
            request = json.loads(raw)
            request_id = int(request.get("id", 0))
            response = {"id": request_id, "ok": True, "result": invoke(request["cmd"])}
        except subprocess.TimeoutExpired as error:
            response = {"id": request_id, "ok": False, "error": "%s did not finish in time" % error.cmd[0]}
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": str(error)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
