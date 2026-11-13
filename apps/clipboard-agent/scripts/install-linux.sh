#!/usr/bin/env bash
# Builds and installs the PocketClipboard agent as a systemd user service.
#
# Every chat that works on this computer gets a desktop of its own: an Xvfb X server with its own access cookie, a
# window manager (openbox) and a D-Bus session, started by the agent when a chat first needs one. Those need no
# graphical session of yours. The lock screen and anything that shows or controls your own screen do: for those, run
# this from a terminal inside your X11 session.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HOME_DIR="$HOME/.pocket-clipboard"

[[ "$(uname -s)" == "Linux" ]] || { echo "This installer is for Linux." >&2; exit 1; }
if [[ "${XDG_SESSION_TYPE:-x11}" == "wayland" || -z "${DISPLAY:-}" ]]; then
  echo "No X11 session here: chats still get desktops of their own. For the lock screen and your own screen, log into an X11 session (Kali KDE/Xfce) and run this installer again." >&2
fi

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  # xvfb, openbox and dbus are the chats' own desktops; util-linux has setpriv, which ends them with the agent.
  sudo apt-get install -y nodejs npm python3 python3-tk python3-pil python3-pil.imagetk python3-xlib xdotool wmctrl xclip maim ffmpeg x11-utils x11-xserver-utils xdg-utils \
    xvfb openbox dbus util-linux
fi

for cmd in node python3 xdotool wmctrl xclip xrandr xprop xwininfo xmodmap xdg-open ffmpeg systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo "Node.js 22 or newer is required." >&2; exit 1; }
python3 -c 'import tkinter, PIL.ImageTk, Xlib; from Xlib.ext import shape' || { echo "Python Tk, Pillow ImageTk and Xlib are required." >&2; exit 1; }

# The chats' desktops. Without these the agent still installs, and tells every chat that asks for a desktop what is
# missing: a chat is never given your own screen instead.
missing=()
for cmd in Xvfb dbus-daemon; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
wm=""
for cmd in openbox xfwm4 fluxbox icewm metacity; do
  if command -v "$cmd" >/dev/null 2>&1; then wm="$cmd"; break; fi
done
[[ -n "$wm" ]] || missing+=("openbox")
if (( ${#missing[@]} )); then
  echo "Per-chat desktops will be off until these are installed: ${missing[*]} (Debian/Kali: sudo apt-get install xvfb openbox dbus)." >&2
else
  command -v setpriv >/dev/null 2>&1 || echo "Note: setpriv (util-linux) is missing; desktops are then only cleaned up when the agent next starts if it is killed outright." >&2
  browser=""
  for cmd in firefox firefox-esr chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$cmd" >/dev/null 2>&1; then browser="$cmd"; break; fi
  done
  [[ -n "$browser" ]] || echo "Note: no browser found (firefox, firefox-esr, chromium, google-chrome); chats can open one once it is installed." >&2
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(npx --yes pnpm@11.25.0)
fi
"${PNPM[@]}" --dir "$ROOT" install --frozen-lockfile

mkdir -p "$HOME_DIR"
"$HERE/node_modules/.bin/esbuild" "$HERE/src/main.ts" --bundle --platform=node --format=cjs --target=node22 \
  --external:bufferutil --external:utf-8-validate --outfile="$HOME_DIR/agent.cjs" --log-level=warning
cp "$HERE/src/linux/computer.py" "$HOME_DIR/computer.py"
cp "$HERE/src/linux/blocker.py" "$HOME_DIR/blocker.py"
cp "$HERE/src/linux/workspace-view.py" "$HOME_DIR/workspace-view.py"
chmod 700 "$HOME_DIR/agent.cjs"
chmod 600 "$HOME_DIR/computer.py" "$HOME_DIR/blocker.py" "$HOME_DIR/workspace-view.py"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/PocketClipboard" <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/.pocket-clipboard/agent.cjs" "$@"
EOF
chmod 700 "$HOME/.local/bin/PocketClipboard"

node "$HOME_DIR/agent.cjs" install
