#!/usr/bin/env python3
"""
Uses a real X11 desktop through the Linux computer-use helper and checks what reached it: only an X server with a
window manager can tell whether a click lands, a text arrives whole or a window comes to the front.

It opens two Tk windows and a GTK one that write down every click, key and text they get, then drives the helper
(src/linux/computer.py) with the same JSON lines the agent sends. CI runs it under Xvfb with openbox
(.github/workflows/computer-linux.yml).

Usage: DISPLAY=:99 python3 computer-smoke.py           needs a window manager, xdotool, wmctrl, xterm, python3-tk, python3-gi
       python3 computer-smoke.py --tk <title> <log> <geometry>     one of the windows it opens
       python3 computer-smoke.py --gtk <title> <log>
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "src", "linux", "computer.py")


def note_to(log):
    def note(**event):
        with open(log, "a", encoding="utf8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    return note


def tk_window(title, log, geometry):
    """A text box, a button and a long list; every press, key and the state of the three go to the log."""
    import tkinter as tk

    note = note_to(log)
    root = tk.Tk(className="tkapp")
    root.title(title)
    root.geometry(geometry)
    entry = tk.Entry(root, width=50)
    entry.pack(padx=10, pady=10)
    presses = {"n": 0}

    def pressed():
        presses["n"] += 1
        note(ev="button", n=presses["n"])

    tk.Button(root, text="Press me", command=pressed).pack(pady=5)
    rows = tk.Listbox(root, height=8)
    for index in range(200):
        rows.insert("end", "row %d" % index)
    rows.pack(fill="both", expand=True, padx=10, pady=10)
    root.bind_all("<ButtonPress>", lambda e: note(ev="down", num=e.num, x=e.x_root, y=e.y_root, state=e.state))
    root.bind_all("<ButtonRelease>", lambda e: note(ev="up", num=e.num, x=e.x_root, y=e.y_root, state=e.state))
    root.bind_all("<Double-Button-1>", lambda e: note(ev="double", x=e.x_root, y=e.y_root))
    root.bind_all("<KeyPress>", lambda e: note(ev="key", keysym=e.keysym, state=e.state))

    def poll():
        note(ev="state", text=entry.get(), top=rows.nearest(0), focus=str(root.focus_displayof()))
        root.after(200, poll)

    root.after(200, poll)
    entry.focus_set()
    root.mainloop()


def gtk_window(title, log):
    """A GTK 3 window: toolkits of its kind read the keyboard layout lazily, which is where typed letters used to get lost."""
    import gi

    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk

    note = note_to(log)
    window = Gtk.Window(title=title)
    window.set_default_size(520, 300)
    window.move(300, 500)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    entry = Gtk.Entry()
    tick = Gtk.CheckButton(label="Tick me")
    tick.connect("toggled", lambda c: note(ev="check", on=c.get_active()))
    entry.connect("changed", lambda e: note(ev="text", text=e.get_text()))
    for widget in (entry, tick, Gtk.Button(label="GTK button")):
        box.pack_start(widget, False, False, 0)
    box.pack_start(Gtk.TextView(), True, True, 0)
    window.add(box)
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    entry.grab_focus()
    Gtk.main()


class Helper:
    def __init__(self):
        self.process = subprocess.Popen([sys.executable, "-u", HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        ready = self.process.stdout.readline()
        if '"ready"' not in ready:
            raise RuntimeError("The helper did not start: %r" % ready)
        self.sent = 0

    def ask(self, **command):
        self.sent += 1
        self.process.stdin.write(json.dumps({"id": self.sent, "cmd": command}) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def do(self, **command):
        answer = self.ask(**command)
        if not answer.get("ok"):
            raise RuntimeError("%s failed: %s" % (command.get("op"), answer.get("error")))
        return answer["result"]


def main():
    folder = tempfile.mkdtemp(prefix="pocket-computer-smoke-")
    logs = {name: os.path.join(folder, name + ".jsonl") for name in ("alpha", "beta", "gtk")}
    failures = []

    def check(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  <- %s" % (detail,)), flush=True)
        if not ok:
            failures.append(name)

    def keep(name, picture):
        """Saves a screenshot the helper returned where CI collects them (POCKET_SMOKE_OUT), for a check that failed."""
        out = os.environ.get("POCKET_SMOKE_OUT")
        if out:
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, name + ".jpg"), "wb") as file:
                file.write(base64.b64decode(picture["image"]["dataBase64"]))

    def events(log, kind=None):
        found = []
        try:
            with open(logs[log], encoding="utf8") as handle:
                for line in handle:
                    event = json.loads(line)
                    if kind is None or event.get("ev") == kind:
                        found.append(event)
        except FileNotFoundError:
            pass
        return found

    def last(log, kind):
        found = events(log, kind)
        return found[-1] if found else {}

    def forget(log):
        open(logs[log], "w").close()

    def start(*args):
        return subprocess.Popen([sys.executable, os.path.abspath(__file__)] + list(args), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for log in logs:
        forget(log)
    helper = Helper()
    windows = []
    try:
        def listed():
            return helper.do(op="windows")["windows"]

        def win(title):
            return next((w for w in listed() if w["title"] == title), None)

        # One after another, each once the one before is up: that fixes their order, and a toolkit's first start is slow.
        for title, args in (("Alpha window", ["--tk", "Alpha window", logs["alpha"], "500x400+100+100"]),
                            ("Бета окно", ["--tk", "Бета окно", logs["beta"], "500x400+700+200"]),
                            ("GTK проба", ["--gtk", "GTK проба", logs["gtk"]])):
            windows.append(start(*args))
            deadline = time.time() + 60
            while not win(title):
                if time.time() > deadline:
                    raise RuntimeError("The window %r did not open" % title)
                time.sleep(0.2)
            time.sleep(0.5)

        def inner(w):
            """Where the window's content starts on the desktop, asked of the X server directly."""
            out = subprocess.run(["xwininfo", "-id", w["handle"]], capture_output=True, text=True).stdout
            return int(re.search(r"Absolute upper-left X:\s+(-?\d+)", out).group(1)), int(re.search(r"Absolute upper-left Y:\s+(-?\d+)", out).group(1))

        def click(x, y, button="left", count=1, mods=(), names=()):
            return helper.do(op="click", x=x, y=y, at=True, button=button, count=count, mods=list(mods), modNames=list(names))

        # windows
        found = listed()
        titles = [w["title"] for w in found]
        check("lists windows front to back with their real titles", titles[:3] == ["GTK проба", "Бета окно", "Alpha window"], titles)
        active = subprocess.run(["xdotool", "getactivewindow"], capture_output=True, text=True).stdout.strip()
        check("marks the active window focused, and only it", [w["handle"] for w in found if w["focused"]] == [active], (active, [(w["title"], w["focused"]) for w in found]))
        check("names a window's program by its class when the process is only an interpreter", found[0]["process"] not in ("", "python3"), found[0]["process"])
        alpha, beta, gtk = win("Alpha window"), win("Бета окно"), win("GTK проба")
        answer = helper.do(op="window", handle=alpha["handle"], what="focus")
        check("focus says the window is in front", answer["text"] == "The window is now in front.", answer)
        check("and it is first in the list then", listed()[0]["title"] == "Alpha window", [w["title"] for w in listed()])
        refused = helper.ask(op="window", handle="123456789", what="focus")
        check("a window that is gone is an error", not refused["ok"] and "no longer exists" in refused["error"], refused)

        # keys reach the focused window however the name is written
        def keys_seen(names, codes=None):
            forget("alpha")
            answer = helper.ask(op="keys", combos=codes or [], holdMs=0, names=names)
            time.sleep(0.4)
            return answer, [(e["keysym"], e["state"] & 0xD) for e in events("alpha", "key")]

        for name, want in [("backspace", "BackSpace"), ("Backspace", "BackSpace"), ("ESC", "Escape"), ("escape", "Escape"), ("f5", "F5"),
                           ("up", "Up"), ("ArrowDown", "Down"), ("Space", "space"), ("delete", "Delete"), ("page-down", "Next"), ("PageUp", "Prior"),
                           ("kp_enter", "KP_Enter"), ("enter", "Return"), ("pause", "Pause"), ("contextmenu", "Menu"), ("home", "Home"), ("End", "End")]:
            answer, seen = keys_seen([[name]])
            check('key "%s" presses %s' % (name, want), answer["ok"] and [k for k, _ in seen] == [want], (answer, seen))
        answer, seen = keys_seen([["Ctrl", "A"]])
        check("Ctrl+A is ctrl+a, not ctrl+shift+a", answer["ok"] and seen == [("Control_L", 0), ("a", 4)], seen)
        answer, seen = keys_seen([["ctrl", "shift", "home"]])
        check("ctrl+shift+home presses all three", [k for k, _ in seen] == ["Control_L", "Shift_L", "Home"], seen)
        answer, seen = keys_seen([["ctrl", "+"]])
        check("ctrl++ presses plus with ctrl", answer["ok"] and bool(seen) and seen[-1][0] == "plus" and bool(seen[-1][1] & 4), seen)
        # Tk keeps Tab for itself (it moves the focus), so the proof is where the focus went.
        focus_before = last("alpha", "state").get("focus")
        keys_seen([["tab"]])
        focus_after = last("alpha", "state").get("focus")
        keys_seen([["Shift", "TAB"]])
        check("tab moves the focus on and shift+tab back", focus_before != focus_after and last("alpha", "state").get("focus") == focus_before, (focus_before, focus_after))
        answer, seen = keys_seen([["nosuchkey"]], [[0x41]])
        check("a name the helper does not know falls back to the code sent with it", answer["ok"] and [k for k, _ in seen] == ["a"], (answer, seen))
        answer, seen = keys_seen([["nosuchkey"]])
        check("an unknown key is an error, not a silent success", not answer["ok"] and "Unknown key" in answer["error"], answer)
        answer, seen = keys_seen(None, [[0x11, 0x41], [0x0D]])
        check("codes alone still work", answer["ok"] and [k for k, _ in seen] == ["Control_L", "a", "Return"], seen)

        # typing arrives whole, in a toolkit that reads the layout lazily too, and under load
        text = "Hello, мир! Привет — «тест» ёж 😀 end"

        def typed_into(handle, log, kind, clear, value, load=0):
            helper.do(op="window", handle=handle, what="focus")
            time.sleep(0.2)
            helper.do(op="keys", combos=[], holdMs=0, names=clear)
            time.sleep(0.2)
            hogs = [subprocess.Popen([sys.executable, "-c", "while True: pass"]) for _ in range(load)]
            try:
                time.sleep(0.3 if load else 0)
                helper.do(op="type", text=value)
            finally:
                for hog in hogs:
                    hog.kill()
                    hog.wait()
            time.sleep(0.8)
            return last(log, kind).get("text")

        select_all_gtk, select_all_tk = [["ctrl", "a"], ["BackSpace"]], [["ctrl", "slash"], ["BackSpace"]]
        got = typed_into(gtk["handle"], "gtk", "text", select_all_gtk, text)
        check("types Cyrillic, symbols and an emoji into GTK", got == text, got)
        got = typed_into(alpha["handle"], "alpha", "state", select_all_tk, text)
        check("types the same into Tk", got == text, got)
        garbled = 0
        for _ in range(4):
            got = typed_into(gtk["handle"], "gtk", "text", select_all_gtk, text, load=8)
            garbled += got != text
        check("types it intact with the processor busy (4 runs)", garbled == 0, "%d of 4 garbled, the last %r" % (garbled, got))
        long_text = "Съешь же ещё этих мягких французских булок, да выпей чаю. " * 8 + "ΑΒΓΔΕΖΗΘ αβγδεζηθικλμνξοπρστυφχψω äöüß éèêë ñ ç 你好世界 ✓✗→←"
        got = typed_into(gtk["handle"], "gtk", "text", select_all_gtk, long_text)
        check("types a long text with more kinds of characters than there are spare keys", got == long_text, (len(got or ""), len(long_text), (got or "")[-70:]))
        ascii_text = "plain ASCII: a-b_c=d (e) [f] {g} 100% #1 @home ~tilde `tick` \"q\" 'q' \\ | < > ? ! $ ^ & * ;"
        got = typed_into(gtk["handle"], "gtk", "text", select_all_gtk, ascii_text)
        check("types ASCII punctuation", got == ascii_text, got)

        # clicks
        gtk = win("GTK проба")
        helper.do(op="window", handle=gtk["handle"], what="focus")
        time.sleep(0.3)
        shot = helper.do(op="screenshot", display=-1, maxWidth=1280, maxHeight=800)
        check("a screenshot is a JPEG of the display, shrunk to fit", shot["image"]["width"] == 1280 and shot["image"]["height"] == 720 and shot["region"]["width"] == 1920 and base64.b64decode(shot["image"]["dataBase64"])[:2] == b"\xff\xd8", shot["image"]["width"])
        gx, gy = inner(gtk)
        check("a window's place is its outer frame, title bar included", gtk["x"] <= gx and gtk["y"] < gy and gy - gtk["y"] < 60 and gtk["width"] >= 520, (gtk, gx, gy))
        tick_x, tick_y = gx + 12, gy + 50
        ticks = len(events("gtk", "check"))
        click(tick_x, tick_y)
        clicked = time.monotonic()
        time.sleep(0.4)
        check("a click ticks the GTK check box", len(events("gtk", "check")) == ticks + 1 and last("gtk", "check").get("on") is True, events("gtk", "check")[-2:])
        after = helper.do(op="screenshot", display=-1, maxWidth=1280, maxHeight=800, settleMs=1500)
        change = after.get("change") or {}
        # The helper gives a step half a second to show its first effect and then takes the picture as it is. On a
        # hosted runner GTK drew the tick later than that more than once: the picture then showed no change, which
        # was true, and the next one showed it. What is checked here is that the change is reported, small and in
        # the right place; how fast the tick is drawn is the machine's affair, so a late one is looked for again.
        looks = [after]
        while not change.get("fraction") and time.monotonic() - clicked < 10:
            after = helper.do(op="screenshot", display=-1, maxWidth=1280, maxHeight=800, settleMs=1500)
            change = after.get("change") or {}
            looks.append(after)
        if len(looks) > 1:
            print("      the tick %s on look %d, %.1f s after the click" % ("showed" if change.get("fraction") else "had not shown", len(looks), time.monotonic() - clicked), flush=True)
        small = 0 < change.get("fraction", 0) < 0.01 and "box" in change
        check("the screenshot after it reports a small change", small, change)
        if not small:
            # Whether the tick was drawn late or not at all only the pictures can tell.
            for name, picture in (("click-before", shot), ("click-after", looks[0]), ("click-later", looks[-1])):
                keep(name, picture)
        if "box" in change:
            scale, box = 1280 / 1920.0, change["box"]
            check("around the check box", box["x"] - 20 <= tick_x * scale <= box["x"] + box["width"] + 20 and box["y"] - 20 <= tick_y * scale <= box["y"] + box["height"] + 20, (box, tick_x * scale, tick_y * scale))
        check("and says the pointer is where the click went", after["cursor"] == {"x": tick_x, "y": tick_y}, after["cursor"])
        still = helper.do(op="screenshot", display=-1, maxWidth=1280, maxHeight=800, settleMs=1500)
        check("a second look reports next to nothing changed (a caret may blink) and a still screen", still.get("change", {}).get("fraction", 1) < 0.0001 and still.get("settled") is True, (still.get("change"), still.get("settled")))

        alpha = win("Alpha window")
        ax, ay = inner(alpha)
        helper.do(op="window", handle=alpha["handle"], what="focus")
        time.sleep(0.3)
        forget("alpha")
        click(ax + 250, ay + 63)
        time.sleep(0.4)
        check("a click presses the Tk button", len(events("alpha", "button")) == 1, events("alpha", "button"))
        forget("alpha")
        click(ax + 250, ay + 200, count=2)
        time.sleep(0.4)
        check("a double click arrives as one", len(events("alpha", "double")) == 1 and len(events("alpha", "up")) == 2, [e["ev"] for e in events("alpha")][:8])
        forget("alpha")
        click(ax + 250, ay + 220, button="right", mods=[0x11], names=["Ctrl"])
        time.sleep(0.4)
        downs = events("alpha", "down")
        check("ctrl + right click carries the button and the modifier", len(downs) == 1 and downs[0]["num"] == 3 and bool(downs[0]["state"] & 4), downs)
        forget("alpha")
        helper.do(op="click", x=0, y=0, at=False, button="left", count=1, mods=[], modNames=[])
        time.sleep(0.3)
        downs = events("alpha", "down")
        check("a click without a point lands where the pointer is, with no modifier or button left held", len(downs) == 1 and abs(downs[0]["x"] - (ax + 250)) <= 1 and not downs[0]["state"] & 4 and len(events("alpha", "up")) == 1, downs)

        # scrolling and dragging
        top = last("alpha", "state").get("top")
        helper.do(op="scroll", x=ax + 250, y=ay + 250, at=True, dx=0, dy=5, mods=[], modNames=[])
        time.sleep(0.5)
        lower = last("alpha", "state").get("top")
        check("scrolling down moves the list", top is not None and lower is not None and lower > top, (top, lower))
        helper.do(op="scroll", x=ax + 250, y=ay + 250, at=True, dx=0, dy=-3, mods=[], modNames=[])
        time.sleep(0.5)
        check("scrolling up moves it back", last("alpha", "state").get("top") < lower, last("alpha", "state").get("top"))
        before = win("Alpha window")
        helper.do(op="drag", path=[before["x"] + 200, before["y"] + 10, before["x"] + 400, before["y"] + 160], button="left")
        time.sleep(0.5)
        moved = win("Alpha window")
        check("dragging the title bar moves the window", abs(moved["x"] - before["x"] - 200) <= 12 and abs(moved["y"] - before["y"] - 150) <= 12, (before["x"], before["y"], moved["x"], moved["y"]))

        # window operations say what really happened
        answer = helper.do(op="window", handle=beta["handle"], what="minimize")
        check("minimize", answer["text"] == "Minimized." and win("Бета окно")["minimized"], answer)
        answer = helper.do(op="window", handle=beta["handle"], what="focus")
        back = win("Бета окно")
        check("focus brings a minimized window back", answer["text"] == "The window is now in front." and not back["minimized"] and back["focused"], (answer, back))
        answer = helper.do(op="window", handle=beta["handle"], what="maximize")
        check("maximize", answer["text"] == "Maximized." and win("Бета окно")["maximized"], answer)
        answer = helper.do(op="window", handle=beta["handle"], what="restore")
        check("restore", answer["text"] == "Restored." and not win("Бета окно")["maximized"], answer)
        answer = helper.do(op="window", handle=beta["handle"], what="close")
        check("close", answer["text"] == "Closed." and win("Бета окно") is None, answer)

        # open
        answer = helper.do(op="open", target="xterm", args="-T 'Opened term' -e sleep 60")
        check("open starts a program and sees its window to the front", answer["text"] == 'Started xterm: its window "Opened term" is in front.' and listed()[0]["title"] == "Opened term", answer)
        refused = helper.ask(op="open", target="no-such-program-here", args="")
        check("opening a name nothing answers to is an error", not refused["ok"] and "Could not open" in refused["error"], refused)
        refused = helper.ask(op="open", target="/tmp/definitely/missing/file.txt", args="")
        check("opening a path that is not there is an error", not refused["ok"] and "Could not open" in refused["error"], refused)
        answer = helper.do(op="open", target="terminal", args="")
        check('open understands "terminal"', answer["text"].startswith("Started terminal"), answer)
        for other in listed():
            if other["process"] == "xterm":
                helper.do(op="window", handle=other["handle"], what="close")

        # a held button, and the pointer
        helper.do(op="move", x=moved["x"] + 250, y=moved["y"] + 220)
        check("the pointer is reported where it was put", helper.do(op="cursor")["cursor"] == {"x": moved["x"] + 250, "y": moved["y"] + 220}, helper.do(op="cursor"))
        forget("alpha")
        helper.do(op="button", button="left", down=True)
        time.sleep(0.2)
        helper.do(op="release")
        time.sleep(0.3)
        check("release lets go of a held button", len(events("alpha", "down")) == 1 and len(events("alpha", "up")) == 1, [e["ev"] for e in events("alpha") if e["ev"] in ("down", "up")])
        zoomed = helper.do(op="zoom", x=moved["x"], y=moved["y"], width=300, height=200, maxWidth=1600, maxHeight=1200)
        check("zoom returns the region asked for", zoomed["region"] == {"x": moved["x"], "y": moved["y"], "width": 300, "height": 200}, zoomed["region"])
    except Exception as error:  # a check that could not even run is a failure with its reason
        check("the run itself: %r" % (error,), False)
    finally:
        helper.process.stdin.close()
        for window in windows:
            window.kill()
    print("\n%d failed:\n- %s" % (len(failures), "\n- ".join(failures)) if failures else "\nall passed")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--tk":
        tk_window(*sys.argv[2:5])
    elif len(sys.argv) > 1 and sys.argv[1] == "--gtk":
        gtk_window(*sys.argv[2:4])
    else:
        sys.exit(main())
