import base64
import json
import os
import select
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path

sys.dont_write_bytecode = True

from PIL import Image, ImageChops, ImageGrab
from Xlib import X, display
from Xlib.ext import shape
import tkinter as tk


ROOT = Path(__file__).resolve().parents[5]
LINUX = ROOT / "lx/apps/clipboard-agent/src/linux"
TEXT = "Automation remains active"
UNDERLAY = (12, 145, 160)
TOTAL_TIMEOUT = 11.0


def wait_line(stream, process, timeout, label):
    ready, _, _ = select.select([stream], [], [], timeout)
    if not ready:
        raise TimeoutError("timed out waiting for " + label)
    line = stream.readline()
    if not line:
        raise RuntimeError("process exited before " + label)
    return line.decode("utf8").strip()


class JsonLines:
    def __init__(self, process):
        self.process = process
        self.fd = process.stdout.fileno()
        os.set_blocking(self.fd, False)
        self.buffer = bytearray()

    def read(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self.buffer[:newline])
                del self.buffer[:newline + 1]
                return json.loads(line)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            ready, _, _ = select.select([self.fd], [], [], remaining)
            if not ready:
                return None
            chunk = os.read(self.fd, 4096)
            if not chunk:
                return None
            self.buffer.extend(chunk)


def time_left(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("native overlay fixture exceeded its 11-second budget")
    return remaining


def wait_event(channel, deadline, label):
    event = channel.read(min(3.0, time_left(deadline)))
    if event is None:
        raise TimeoutError("timed out waiting for " + label)
    return event


def send(process, value):
    process.stdin.write((json.dumps(value) + "\n").encode("utf8"))
    process.stdin.flush()


def pump(root, duration, deadline):
    end = min(time.monotonic() + duration, deadline)
    while time.monotonic() < end:
        root.update()
        time.sleep(min(0.01, end - time.monotonic()))


def pump_until(root, predicate, timeout, deadline, message):
    end = min(time.monotonic() + timeout, deadline)
    while time.monotonic() < end:
        root.update()
        if predicate():
            return
        time.sleep(min(0.01, end - time.monotonic()))
    raise AssertionError(message)


def overlay_snapshot(connection):
    pending = list(connection.screen().root.query_tree().children)
    while pending:
        window = pending.pop()
        try:
            if window.get_wm_name() == "PocketClipboard privacy overlay":
                attributes = window.get_attributes()
                rectangles = window.shape_get_rectangles(shape.SK.Input).rectangles
                return attributes.map_state == X.IsViewable, bool(rectangles)
            pending.extend(window.query_tree().children)
        except Exception:
            continue
    return False, False


def wait_overlay(root, connection, deadline, mapped, intercepts, message):
    found = None

    def matches():
        nonlocal found
        found = overlay_snapshot(connection)
        return found == (mapped, intercepts)

    pump_until(root, matches, 2.0, deadline, message)
    return found


def dispatch_screenshot(process, channel, request_id, deadline):
    send(process, {
        "id": request_id,
        "cmd": {"op": "screenshot", "display": 0, "maxWidth": 1280, "maxHeight": 720, "settleMs": 0},
    })
    response = wait_event(channel, deadline, "computer screenshot")
    if not response.get("ok"):
        raise RuntimeError("computer.py screenshot failed: " + response.get("error", "unknown error"))
    image = response["result"]["image"]
    return Image.open(BytesIO(base64.b64decode(image["dataBase64"]))).convert("RGB")


def run_command(args, env, deadline):
    result = subprocess.run(
        args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=min(2.0, time_left(deadline)), check=False,
    )
    if result.returncode:
        raise RuntimeError("%s failed: %s" % (args[0], result.stderr.decode("utf8", "replace")))


def stop_process(process, command=None):
    if process is None or process.poll() is not None:
        return
    if command is not None and process.stdin is not None:
        try:
            process.stdin.write((json.dumps(command) + "\n").encode("utf8"))
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
    try:
        process.wait(timeout=0.75)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=0.75)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=0.75)


def main():
    deadline = time.monotonic() + TOTAL_TIMEOUT
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "XDG_SESSION_TYPE": "x11"}
    xvfb = computer = blocker = root = connection = None
    try:
        xvfb = subprocess.Popen(
            ["Xvfb", "-displayfd", "1", "-screen", "0", "1280x720x24", "-nolisten", "tcp"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        display_number = wait_line(xvfb.stdout, xvfb, min(3.0, time_left(deadline)), "Xvfb display").strip()
        env["DISPLAY"] = ":" + display_number
        os.environ.update(env)
        connection = display.Display(env["DISPLAY"])
        input_only_window = connection.screen().root.create_window(
            1260, 700, 16, 16, 0, 0, X.InputOnly, X.CopyFromParent,
        )
        input_only_window.map()
        connection.sync()
        input_only_mapped_before = input_only_window.get_attributes().map_state == X.IsViewable
        if not input_only_mapped_before:
            raise AssertionError("test InputOnly root child did not map")

        root = tk.Tk()
        root.overrideredirect(True)
        root.geometry("1280x720+0+0")
        root.configure(bg="#0c91a0")
        tk.Label(root, text="Automation test desktop", bg="#0c91a0", fg="white", font=("DejaVu Sans", 24)).place(x=100, y=40)
        entry = tk.Entry(root, font=("DejaVu Sans", 30))
        entry.place(x=100, y=110, width=850, height=60)
        root.update()
        entry.focus_force()
        root.update()

        computer = subprocess.Popen(
            [sys.executable, "-B", str(LINUX / "computer.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        computer_lines = JsonLines(computer)
        if wait_event(computer_lines, deadline, "computer.py ready event").get("ready") is not True:
            raise RuntimeError("computer.py did not become ready")
        before = dispatch_screenshot(computer, computer_lines, 1, deadline)

        blocker = subprocess.Popen(
            [sys.executable, "-B", str(LINUX / "blocker.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        blocker_lines = JsonLines(blocker)
        if wait_event(blocker_lines, deadline, "blocker ready event").get("ev") != "ready":
            raise RuntimeError("blocker did not become ready")
        send(blocker, {"op": "state", "locked": True})

        locked_before = wait_overlay(root, connection, deadline, True, True, "locked overlay did not intercept input")
        pump(root, 0.12, deadline)
        overlay_pixel_before = ImageGrab.grab(bbox=(20, 20, 21, 21), xdisplay=env["DISPLAY"]).convert("RGB").getpixel((0, 0))

        through_started = time.monotonic()
        send(blocker, {"op": "through", "ms": 6000})
        passing = wait_overlay(root, connection, deadline, True, False, "through mode hid the overlay or kept its input region")
        run_command(["xdotool", "mousemove", "130", "135", "click", "1"], env, deadline)
        run_command(["xdotool", "type", "--clearmodifiers", "--delay", "1", TEXT], env, deadline)
        run_command(["xdotool", "mousemove", "1200", "700"], env, deadline)
        pump_until(root, lambda: entry.get() == TEXT, 2.0, deadline, "synthetic click/type did not reach the underlay entry")
        through_elapsed_ms = round((time.monotonic() - through_started) * 1000)
        if through_elapsed_ms >= 6000:
            raise AssertionError("synthetic click/type did not finish during the through interval")

        send(blocker, {"op": "through", "ms": 0})
        restored = wait_overlay(root, connection, deadline, True, True, "input interception was not restored after through zero")
        pump(root, 0.12, deadline)
        overlay_pixel_after = ImageGrab.grab(bbox=(20, 20, 21, 21), xdisplay=env["DISPLAY"]).convert("RGB").getpixel((0, 0))
        after = dispatch_screenshot(computer, computer_lines, 2, deadline)
        input_only_mapped_after = input_only_window.get_attributes().map_state == X.IsViewable

        underlay_pixel_before = before.getpixel((20, 20))
        underlay_pixel_after = after.getpixel((20, 20))
        overlay_distance = sum(abs(a - b) for a, b in zip(overlay_pixel_after, underlay_pixel_after))
        pixel_difference = ImageChops.difference(before.crop((100, 110, 950, 170)), after.crop((100, 110, 950, 170))).convert("RGB")
        entry_changed_pixels = sum(1 for pixel in pixel_difference.getdata() if max(pixel) > 32)
        events = []
        drain_deadline = min(time.monotonic() + 0.12, deadline)
        while time.monotonic() < drain_deadline:
            event = blocker_lines.read(min(0.02, drain_deadline - time.monotonic()))
            if event is not None:
                events.append(event)
        errors = [event for event in events if event.get("ev") == "error"]

        result = {
            "typedText": entry.get(),
            "overlayMappedBeforeThrough": locked_before[0],
            "overlayMappedDuringThrough": passing[0],
            "overlayMappedAfterThrough": restored[0],
            "passesInputDuringThrough": not passing[1],
            "interceptsInputAfterThrough": restored[1],
            "throughElapsedMs": through_elapsed_ms,
            "dispatcherScreenshotUnderlay": max(abs(a - b) for a, b in zip(underlay_pixel_before, UNDERLAY)) < 20
                and max(abs(a - b) for a, b in zip(underlay_pixel_after, UNDERLAY)) < 20
                and overlay_distance > 80,
            "underlayPixelBefore": list(underlay_pixel_before),
            "underlayPixelAfter": list(underlay_pixel_after),
            "overlayPixelBefore": list(overlay_pixel_before),
            "overlayPixelAfter": list(overlay_pixel_after),
            "inputOnlyRootChildMapped": input_only_mapped_before and input_only_mapped_after,
            "entryChangedPixels": entry_changed_pixels,
            "errorEvents": errors,
        }
        assert result["typedText"] == TEXT, "underlay input did not complete"
        assert all(result[key] for key in (
            "overlayMappedBeforeThrough", "overlayMappedDuringThrough", "overlayMappedAfterThrough",
            "passesInputDuringThrough", "interceptsInputAfterThrough", "dispatcherScreenshotUnderlay",
        )), "native overlay regression assertion failed: " + json.dumps(result)
        assert result["overlayPixelBefore"] != result["underlayPixelBefore"], "overlay was not visibly rendered before through mode"
        assert result["overlayPixelAfter"] == result["overlayPixelBefore"], "overlay changed or disappeared after through mode"
        assert result["underlayPixelAfter"] == result["underlayPixelBefore"], "dispatcher screenshot background changed"
        assert result["entryChangedPixels"] > 100, "dispatcher screenshot did not include the typed underlay content"
        assert not errors, "blocker emitted error events: " + json.dumps(errors)
        if os.environ.get("POCKET_OVERLAY_TEST_ARTIFACTS"):
            artifacts = Path(os.environ["POCKET_OVERLAY_TEST_ARTIFACTS"])
            artifacts.mkdir(parents=True, exist_ok=True)
            ImageGrab.grab(xdisplay=env["DISPLAY"]).save(artifacts / "linux-overlay-final.png")
            after.save(artifacts / "linux-underlay-final.png")
        print(json.dumps(result))
    finally:
        if connection is not None:
            connection.close()
        stop_process(blocker, {"op": "quit"})
        stop_process(computer)
        if root is not None:
            try:
                root.destroy()
            except tk.TclError:
                pass
        stop_process(xvfb)


if __name__ == "__main__":
    main()
