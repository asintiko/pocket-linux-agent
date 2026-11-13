#!/usr/bin/env python3
"""Looks into a Pocket chat desktop from the computer it runs on: pictures of it in an ordinary window, nothing more.

The window is on the screen this was started from (DISPLAY); the desktop is another X display (--source). It is read
only by construction: pictures are copied one way, and no key or pointer event is passed on. No port is opened.
"""

import argparse
import sys
import time


def grab(source):
    from PIL import ImageGrab

    return ImageGrab.grab(xdisplay=source).convert("RGB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="the desktop's X display, e.g. :101")
    parser.add_argument("--once", help="save one picture to this file and exit")
    parser.add_argument("--title", default="Pocket desktop (view only)")
    parser.add_argument("--interval", type=float, default=0.7)
    args = parser.parse_args()

    if args.once:
        grab(args.source).save(args.once)
        return 0

    import tkinter
    from PIL import Image, ImageTk

    first = grab(args.source)
    root = tkinter.Tk()
    root.title(args.title)
    scale = min(1.0, (root.winfo_screenwidth() * 0.8) / first.width, (root.winfo_screenheight() * 0.8) / first.height)
    root.geometry("%dx%d" % (int(first.width * scale), int(first.height * scale)))
    label = tkinter.Label(root, borderwidth=0, background="#101418")
    label.pack(fill="both", expand=True)
    state = {"photo": None, "failed": 0.0}

    def show():
        try:
            image = grab(args.source)
            state["failed"] = 0.0
            width, height = max(1, label.winfo_width()), max(1, label.winfo_height())
            fit = min(width / image.width, height / image.height)
            if fit < 0.999 or fit > 1.001:
                image = image.resize((max(1, int(image.width * fit)), max(1, int(image.height * fit))), Image.BILINEAR)
            state["photo"] = ImageTk.PhotoImage(image)
            label.configure(image=state["photo"], text="")
        except Exception as error:  # the desktop was closed or restarted
            state["failed"] = state["failed"] or time.monotonic()
            label.configure(image="", text="The desktop is not there any more.\n%s" % error, foreground="#d8dee9")
            if time.monotonic() - state["failed"] > 20:
                root.destroy()
                return
        root.after(int(args.interval * 1000), show)

    root.after(50, show)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
