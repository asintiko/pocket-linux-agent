/**
 * What an acceptance run of the per-chat desktops is made of. Everything here is the real thing except the two ends a
 * machine cannot supply: the phone is a paired client that sends the phone's messages, and the VS Code extension is
 * its own dispatcher and placement code without the editor around it. The relay and the brain run in this process,
 * PocketClipboard runs as its own process from `src/main.ts` (or an installed bundle), and the desktops, window
 * managers, session buses, helpers and browsers are the ones PocketClipboard starts.
 *
 * Nothing of a real installation is touched: the Linux login's home, its temporary folder and the brain's state are
 * all under one scratch folder, and the "person's own screen" is an X server started here for the purpose.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InnerMessage, InnerMessageBody, PairingCode, WorkspaceLive } from '@pocket/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LX_ROOT = path.resolve(here, '../../../..');
const AGENT_MAIN = path.resolve(here, '../../src/main.ts');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until<T>(what: string, read: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 20_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

export interface Scratch {
  root: string;
  /** The home of the Linux login PocketClipboard and the executor share. */
  home: string;
  tmp: string;
  project: string;
  brain: string;
  out: string;
}

/** Has to run before anything of the brain is imported: its store reads these when it loads. */
export function prepare(outDir: string | undefined, opts: { /** The real home of this login, for a run against what the installer put there. */ home?: string } = {}): Scratch {
  // Short on purpose: the desktops' sockets live under it and a socket path ends at 107 bytes.
  const root = mkdtempSync(path.join('/tmp', 'pocket-acc-'));
  const scratch: Scratch = { root, home: opts.home ?? path.join(root, 'home'), tmp: path.join(root, 't'), project: path.join(root, 'project'), brain: path.join(root, 'brain'), out: path.resolve(outDir ?? path.join(root, 'evidence')) };
  for (const dir of Object.values(scratch)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.POCKET_HOME = scratch.brain;
  process.env.POCKET_LOG_DIR = path.join(scratch.brain, 'logs');
  process.env.POCKET_NO_KEYCHAIN = '1';
  process.env.POCKET_WORKSPACE = path.join(scratch.brain, 'workspace');
  process.env.POCKET_PEOPLE = path.join(scratch.brain, 'people');
  // The executor looks for the desktops under the home directory, as the extension does.
  process.env.HOME = scratch.home;
  return scratch;
}

export interface XSession {
  DISPLAY: string;
  XAUTHORITY: string;
}

const SESSION_VARIABLES = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS'];

function withoutSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of SESSION_VARIABLES) delete copy[name];
  return copy;
}

/** Runs an X client against one display with one cookie, whatever this process itself is pointed at. */
export function x(session: XSession, command: string, args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync(command, args, { env: { ...withoutSession(process.env), ...session }, encoding: 'utf8', timeout: 20_000, ...(input !== undefined ? { input } : {}) });
  // A program ended by a signal has no exit code and often wrote nothing: the signal is all there is to report.
  return { ok: r.status === 0, out: r.status === 0 ? (r.stdout ?? '').trim() : ((r.stderr ?? '').trim() || r.error?.message || (r.signal ? `${command} ended by ${r.signal}` : `exit ${r.status}`)) };
}

const PY_GRAB = 'import sys\nfrom PIL import ImageGrab\nImageGrab.grab(xdisplay=sys.argv[1]).save(sys.argv[2])';

const PY_POINTER = 'import sys\nfrom Xlib import display\nd = display.Display(sys.argv[1])\np = d.screen().root.query_pointer()\nprint(p.mask, p.root_x, p.root_y)';

const PY_DIFF = 'import sys\nfrom PIL import Image, ImageChops\na = Image.open(sys.argv[1]).convert("RGB")\nb = Image.open(sys.argv[2]).convert("RGB")\nprint("size" if a.size != b.size else sum(1 for p in ImageChops.difference(a, b).convert("L").getdata() if p > 8))';

// Pure colours no browser or desktop draws by itself: three name a page, three mark what to click on it.
const PY_COLOURS = `import json, sys
from PIL import Image
image = Image.open(sys.argv[1]).convert("RGB")
width, height = image.size
pixels = image.load()
tests = {
    "red": lambda r, g, b: r > 200 and g < 70 and b < 70,
    "blue": lambda r, g, b: r < 70 and g < 70 and b > 200,
    "green": lambda r, g, b: r < 70 and g > 200 and b < 70,
    "magenta": lambda r, g, b: r > 200 and g < 80 and b > 200,
    "cyan": lambda r, g, b: r < 80 and g > 200 and b > 200,
    "yellow": lambda r, g, b: r > 200 and g > 200 and b < 80,
}
found = {name: {"count": 0, "box": None} for name in tests}
for y in range(0, height, 2):
    for x in range(0, width, 2):
        r, g, b = pixels[x, y]
        for name, test in tests.items():
            if test(r, g, b):
                entry = found[name]
                entry["count"] += 1
                box = entry["box"]
                if box is None:
                    entry["box"] = [x, y, x, y]
                else:
                    box[0] = min(box[0], x); box[1] = min(box[1], y); box[2] = max(box[2], x); box[3] = max(box[3], y)
print(json.dumps({"width": width, "height": height, "colours": found}))`;

export type Colour = 'red' | 'blue' | 'green' | 'magenta' | 'cyan' | 'yellow';
export interface Colours {
  width: number;
  height: number;
  colours: Record<Colour, { count: number; box: [number, number, number, number] | null }>;
}

function python(code: string, args: string[], env: NodeJS.ProcessEnv = withoutSession(process.env)): string {
  const r = spawnSync('python3', ['-c', code, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error((r.stderr ?? '').trim().split('\n').pop() || r.error?.message || `python3 exited with ${r.status}`);
  return (r.stdout ?? '').trim();
}

/** A picture of a whole display, taken beside the product: what is on it, not what a tool says is on it. */
export function grab(session: XSession, file: string): void {
  python(PY_GRAB, [session.DISPLAY, file], { ...withoutSession(process.env), ...session });
}

export const coloursIn = (file: string): Colours => JSON.parse(python(PY_COLOURS, [file])) as Colours;

/** How many pixels differ between two pictures of the same size; -1 when the sizes differ. */
export function differingPixels(a: string, b: string): number {
  const out = python(PY_DIFF, [a, b]);
  return out === 'size' ? -1 : Number(out);
}

/** The pointer of a display and whether its left button is held down, asked of the X server itself. */
export function pointer(session: XSession): { x: number; y: number; leftDown: boolean } {
  const [mask, px, py] = python(PY_POINTER, [session.DISPLAY], { ...withoutSession(process.env), ...session }).split(' ').map(Number);
  return { x: px ?? -1, y: py ?? -1, leftDown: ((mask ?? 0) & 0x100) !== 0 };
}

export interface ProcessInfo {
  pid: number;
  cmdline: string[];
}

function procState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch {
    return undefined;
  }
}

export const running = (pid: number): boolean => {
  const state = procState(pid);
  return state !== undefined && state !== 'Z' && state !== 'X';
};

/** Processes whose environment carries `name=value`: a desktop's own are found by the name they were started with. */
export function processesWith(name: string, value: string): ProcessInfo[] {
  const found: ProcessInfo[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (!readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`${name}=${value}`)) continue;
      if (!running(Number(entry))) continue;
      found.push({ pid: Number(entry), cmdline: readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean) });
    } catch {}
  }
  return found;
}

export const workspaceDir = (scratch: Scratch, id: string): string => path.join(scratch.home, '.pocket-clipboard', 'workspaces', id);

/**
 * Everything that belongs to a desktop, found two ways because neither sees all of it: by the name each of its
 * processes was started with (a browser hides its environment from other processes), and by the desktop's own folder
 * on the command line (its X server's cookie, its browser's profile).
 */
export function processesOf(scratch: Scratch, workspaceId: string): ProcessInfo[] {
  const dir = `${workspaceDir(scratch, workspaceId)}/`;
  const found = new Map<number, ProcessInfo>();
  for (const p of processesWith('POCKET_WORKSPACE_ID', workspaceId)) found.set(p.pid, p);
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || found.has(Number(entry))) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (cmdline.some((arg) => arg.includes(dir)) && running(Number(entry))) found.set(Number(entry), { pid: Number(entry), cmdline });
    } catch {}
  }
  return [...found.values()];
}

/** The parent of a process, or 0 when it is gone. */
export function parentOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0;
  } catch {
    return 0;
  }
}

/** The record PocketClipboard keeps of a running desktop; absent while it is not running. */
export function liveRecord(scratch: Scratch, id: string): WorkspaceLive | undefined {
  try {
    return JSON.parse(readFileSync(path.join(workspaceDir(scratch, id), 'live.json'), 'utf8')) as WorkspaceLive;
  } catch {
    return undefined;
  }
}

export const sessionOf = (live: WorkspaceLive): XSession => ({ DISPLAY: live.display, XAUTHORITY: live.env.XAUTHORITY ?? '' });

/** One xprop string: quotes off, its backslash escapes undone (octal bytes are UTF-8 printed in a plain locale). */
function unquoted(value: string): string {
  const raw = Buffer.from(value.trim().replace(/^"([\s\S]*)"$/, '$1'), 'utf8');
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x5c && i + 1 < raw.length) {
      const octal = /^[0-7]{3}/.exec(raw.subarray(i + 1, i + 4).toString('latin1'));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8) & 0xff);
        i += 3;
        continue;
      }
      const next = raw[i + 1]!;
      bytes.push(next === 0x6e ? 0x0a : next === 0x74 ? 0x09 : next);
      i += 1;
      continue;
    }
    bytes.push(raw[i]!);
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * What stands in the way of reading a display's windows, when something does. `windowTitles` returns no titles then,
 * and a wait that ends for want of a window can say that the list was the trouble, not the window.
 */
export function windowListTrouble(session: XSession): string | undefined {
  const root = x(session, 'xprop', ['-root', '_NET_CLIENT_LIST']);
  if (!root.ok) return `xprop -root _NET_CLIENT_LIST: ${root.out}`;
  return /^_NET_CLIENT_LIST\(WINDOW\)/m.test(root.out) ? undefined : `no window manager keeps a list of windows there (${root.out.slice(0, 120)})`;
}

/**
 * Window titles on a display, from the list its window manager keeps on the root window. It is read with xprop, as
 * PocketClipboard reads it: on a hosted runner `wmctrl -l` ended by a signal for two minutes on a display that held
 * one Tk window, and the run waited for a window that was there.
 */
export function windowTitles(session: XSession): string[] {
  const root = x(session, 'xprop', ['-root', '_NET_CLIENT_LIST']);
  const listed = root.ok ? /^_NET_CLIENT_LIST\(WINDOW\): window id #(.*)$/m.exec(root.out) : null;
  const ids = (listed?.[1]?.match(/0x[0-9a-f]+/gi) ?? []).filter((id) => Number.parseInt(id, 16) !== 0);
  return ids.flatMap((id) => {
    // A window that closed since the list was read is no title, not an error.
    const named = x(session, 'xprop', ['-id', id, '_NET_WM_NAME', 'WM_NAME']);
    const title = named.ok ? (/^_NET_WM_NAME\([A-Z0-9_]+\) = (.*)$/m.exec(named.out) ?? /^WM_NAME\([A-Z0-9_]+\) = (.*)$/m.exec(named.out)) : null;
    return title ? [unquoted(title[1]!)] : [];
  });
}

function onPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(path.join(dir, command))) return path.join(dir, command);
  }
  return undefined;
}

export interface Browser {
  name: string;
  path: string;
  family: 'firefox' | 'chromium';
}

const FIREFOX = ['firefox', 'firefox-esr', 'librewolf'];
const CHROMIUM = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

/** The browser the desktops will use: the one asked for, else the first PocketClipboard itself would pick. */
export function findBrowser(preferred?: string): Browser | undefined {
  for (const name of [...(preferred ? [preferred] : []), ...FIREFOX, ...CHROMIUM]) {
    const found = onPath(name);
    if (found) return { name, path: found, family: FIREFOX.includes(name) ? 'firefox' : 'chromium' };
  }
  return undefined;
}

export interface PageEvent {
  page: string;
  kind: string;
  value: string;
  instance: string;
  visits: number;
  /** The page's own count of what it reported: its reports are separate requests and can overtake each other. */
  seq: number;
  at: number;
}

const IDENTITY: Record<string, string> = { A: '#ff0000', B: '#0000ff', H: '#00ff00' };

/** A page that says on screen which one it is and reports everything that reaches it to the server it came from. */
function pageHtml(name: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pocket page ${name}</title><style>
html,body{margin:0;height:100%;background:#20242c;color:#fff;font:26px/1.3 sans-serif;overflow:hidden}
#banner{position:absolute;left:0;top:0;width:100%;height:110px;background:${IDENTITY[name] ?? '#808080'};font-size:64px;font-weight:bold;text-align:center;line-height:110px}
#field{position:absolute;left:60px;top:170px;width:820px;height:56px;border:14px solid #ff00ff;background:#fff;color:#000;font:30px monospace;padding:0 8px;outline:none}
#button{position:absolute;left:60px;top:300px;width:300px;height:90px;border:0;background:#00ffff;color:#000;font-size:30px}
#copy{position:absolute;left:60px;top:440px;border:12px solid #ffff00;background:#000;color:#fff;font:30px monospace;padding:6px 14px}
#seen{position:absolute;left:420px;top:300px;font:22px monospace;white-space:pre}
</style></head><body>
<div id="banner">WORKSPACE ${name}</div>
<input id="field" autocomplete="off" spellcheck="false">
<button id="button">press</button>
<div id="copy">COPY-ME-${name}</div>
<div id="seen"></div>
<script>
const page = ${JSON.stringify(name)};
const instance = Math.random().toString(36).slice(2);
const visits = Number(localStorage.getItem('visits') || '0') + 1;
localStorage.setItem('visits', String(visits));
const field = document.getElementById('field');
const seen = document.getElementById('seen');
let clicks = 0;
let sent = 0;
function report(kind, value) {
  seen.textContent = 'visits ' + visits + '\\nclicks ' + clicks + '\\nlast ' + kind;
  fetch('/report', { method: 'POST', body: JSON.stringify({ page, kind, value: String(value), instance, visits, seq: ++sent }), keepalive: true }).catch(() => {});
}
field.addEventListener('input', () => { document.title = 'Pocket page ' + page + ': ' + field.value; report('input', field.value); });
field.addEventListener('paste', (e) => report('paste', e.clipboardData.getData('text')));
document.getElementById('button').addEventListener('click', () => report('click', ++clicks));
document.addEventListener('copy', () => report('copy', String(getSelection())));
document.addEventListener('keydown', (e) => report('key', e.key));
document.addEventListener('mousedown', (e) => report('mousedown', e.clientX + ',' + e.clientY));
document.addEventListener('mouseup', (e) => report('mouseup', e.clientX + ',' + e.clientY));
window.addEventListener('focus', () => report('window-focus', ''));
window.addEventListener('blur', () => report('window-blur', ''));
report('load', visits);
</script></body></html>`;
}

export interface Pages {
  port: number;
  url(page: string): string;
  events: PageEvent[];
  of(page: string, kind?: string): PageEvent[];
  /** Other requests to the same server: the run's own controls in `--serve`. */
  extra?: (req: HttpRequest, res: ServerResponse) => boolean | Promise<boolean>;
  close(): Promise<void>;
}

export async function startPages(): Promise<Pages> {
  const events: PageEvent[] = [];
  const pages: Pages = {
    port: 0,
    url: (page) => `http://127.0.0.1:${pages.port}/page/${page}`,
    events,
    of: (page, kind) => events.filter((e) => e.page === page && (kind === undefined || e.kind === kind)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://pages');
    const page = /^\/page\/([A-Za-z0-9-]{1,20})$/.exec(url.pathname);
    if (req.method === 'GET' && page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(pageHtml(page[1]!));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/report') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const e = JSON.parse(body) as Partial<PageEvent>;
          const event: PageEvent = { page: String(e.page), kind: String(e.kind), value: String(e.value ?? ''), instance: String(e.instance), visits: Number(e.visits), seq: Number(e.seq) || 0, at: Date.now() };
          // Two reports sent a few milliseconds apart can arrive the other way round. Within one page they are
          // kept in the order the page sent them, so that its last report is its last word: a text typed whole
          // once looked one letter short because the report before the last arrived after it.
          let place = events.length;
          for (let i = events.length - 1; i >= 0; i--) {
            const earlier = events[i]!;
            if (earlier.instance !== event.instance) continue;
            if (earlier.seq < event.seq) break;
            place = i;
          }
          events.splice(place, 0, event);
        } catch {}
        res.writeHead(204).end();
      });
      return;
    }
    void Promise.resolve(pages.extra?.(req, res) ?? false).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  pages.port = (server.address() as AddressInfo).port;
  return pages;
}

export interface HumanState {
  activeWindow: string;
  pointer: string;
  clipboard: string;
  windows: string[];
}

export interface Human extends XSession {
  state(): HumanState;
  stop(): void;
}

function endGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/**
 * A stand-in for the person's own screen: an X server with its own cookie, a window manager, a window that has the
 * focus, a browser showing a page of its own, a clipboard with something on it and a pointer somewhere. It is what
 * PocketClipboard and the executor are started "inside", as on a real machine, and what must not change.
 */
export async function startHuman(scratch: Scratch, browser: Browser | undefined, pageUrl: string, clipboard: string): Promise<Human> {
  const cookie = path.join(scratch.root, 'human.Xauthority');
  const children: ChildProcess[] = [];
  let xserver: ChildProcess | undefined;
  let session: XSession | undefined;
  for (let n = 60; n < 90 && !session; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    writeFileSync(cookie, '', { mode: 0o600 });
    const added = spawnSync('xauth', ['-f', cookie, 'add', `:${n}`, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' });
    if (added.status !== 0) throw new Error(`xauth failed: ${added.stderr || added.error?.message}`);
    const server = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', cookie, '-noreset'], { stdio: 'ignore', detached: true });
    const candidate = { DISPLAY: `:${n}`, XAUTHORITY: cookie };
    const up = await until(`the stand-in screen :${n}`, () => x(candidate, 'xdpyinfo', []).ok || server.exitCode !== null, 15_000).then(() => server.exitCode === null);
    if (up) {
      xserver = server;
      session = candidate;
    }
  }
  if (!session) throw new Error('No free display for the stand-in of the person\'s screen.');
  const env = { ...withoutSession(process.env), ...session };
  const written = path.join(scratch.root, 'human.log');
  const start = (command: string, args: string[]) => {
    const log = openSync(written, 'a');
    const child = spawn(command, args, { env, stdio: ['ignore', log, log], detached: true });
    closeSync(log);
    children.push(child);
    return child;
  };
  // The first program of its kind on a machine that never ran one takes its time; one that never shows says why.
  const shows = (what: string, test: (titles: string[]) => boolean) =>
    until(what, () => test(windowTitles(session)), 120_000, 250).catch((e: Error) => {
      let said = '';
      try {
        said = readFileSync(written, 'utf8').trim().split('\n').slice(-15).join(' | ');
      } catch {}
      const left = children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => path.basename(c.spawnfile));
      const trouble = windowListTrouble(session);
      throw new Error(`${e.message}. Windows there: ${trouble ? `unknown, ${trouble}` : JSON.stringify(windowTitles(session))}. Still running: ${left.join(', ') || 'nothing'}. What the programs wrote: ${said || 'nothing'}`);
    });
  start('openbox', ['--sm-disable']);
  await until("the person's window manager", () => x(session, 'wmctrl', ['-m']).ok, 15_000);
  if (browser) {
    const profile = path.join(scratch.root, 'human-profile');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    start(browser.path, browser.family === 'firefox' ? ['--profile', profile, '--no-remote', pageUrl] : [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic', pageUrl]);
    await shows("the person's browser window", (titles) => titles.some((t) => t.includes('Pocket page H')));
  }
  start('python3', ['-c', 'import tkinter as t\nr = t.Tk()\nr.title("Human notes")\nr.geometry("360x200+820+520")\nt.Label(r, text="the person is writing here").pack(expand=True)\nr.mainloop()']);
  await shows("the person's own window", (titles) => titles.includes('Human notes'));
  // xclip stays behind as the owner of the selection, as any program does that something was copied in.
  x(session, 'xclip', ['-selection', 'clipboard', '-in'], clipboard);
  x(session, 'xdotool', ['mousemove', '611', '377']);
  x(session, 'xdotool', ['search', '--name', '^Human notes$', 'windowactivate']);
  await until("the person's window to have the focus", () => x(session, 'xdotool', ['getactivewindow', 'getwindowname']).out === 'Human notes', 10_000);
  return {
    ...session,
    state: () => ({
      activeWindow: x(session, 'xdotool', ['getactivewindow', 'getwindowname']).out,
      pointer: x(session, 'xdotool', ['getmouselocation']).out.replace(/\s*window:\d+$/, ''),
      clipboard: x(session, 'xclip', ['-o', '-selection', 'clipboard']).out,
      windows: windowTitles(session).sort(),
    }),
    stop: () => {
      for (const child of children.reverse()) endGroup(child, 'SIGKILL');
      // The X server is asked, not killed: killed, it leaves its socket behind and its display number stays taken.
      if (xserver) endGroup(xserver, 'SIGTERM');
    },
  };
}

/**
 * PocketClipboard as its own process: the entry point the service runs, with a home and a temporary folder of its own.
 * With `service` it is the systemd user service the installer set up, started and stopped by systemd as on a
 * person's machine, and nothing here is its parent.
 */
export class AgentProcess {
  private child: ChildProcess | undefined;
  output = '';

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    /** An installed bundle (`~/.pocket-clipboard/agent.cjs`) instead of the sources. */
    private readonly bundle?: string,
    /** The name of the installed systemd user service; needs `bundle`. */
    readonly service?: string,
  ) {}

  private command(args: string[]): [string, string[]] {
    return [process.execPath, this.bundle ? [this.bundle, ...args] : ['--import', 'tsx', AGENT_MAIN, ...args]];
  }

  /** `systemctl --user …` for the service, as the person's own shell would run it. */
  systemctl(args: string[]): { ok: boolean; out: string } {
    const r = spawnSync('systemctl', ['--user', ...args], { env: this.env, encoding: 'utf8', timeout: 120_000 });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || r.error?.message || '' };
  }

  get pid(): number | undefined {
    if (this.service) {
      const pid = Number(this.systemctl(['show', '-p', 'MainPID', '--value', this.service]).out);
      return pid > 0 ? pid : undefined;
    }
    return this.child?.pid;
  }

  get alive(): boolean {
    if (this.service) return this.systemctl(['is-active', '--quiet', this.service]).ok;
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** `PocketClipboard pair`, answered the way a person does: the link from the phone, then Enter at the safety number. */
  async pair(uri: string): Promise<void> {
    const [command, args] = this.command(['pair']);
    const child = spawn(command, args, { cwd: LX_ROOT, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    let confirmed = false;
    child.stdout.on('data', (d) => {
      text += String(d);
      if (!confirmed && /Safety number/.test(text)) {
        confirmed = true;
        child.stdin.write('\n');
      }
    });
    child.stderr.on('data', (d) => (text += String(d)));
    child.stdin.write(`${uri}\n`);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    if (code !== 0 || !/Paired\./.test(text)) throw new Error(`PocketClipboard pair failed: ${text.trim().split('\n').slice(-3).join(' | ')}`);
  }

  /** `PocketClipboard run`; as a service, `systemctl --user start`. */
  start(): void {
    if (this.service) {
      const started = this.systemctl(['start', this.service]);
      this.output = started.out;
      if (!started.ok) throw new Error(`systemctl --user start ${this.service}: ${started.out}`);
      return;
    }
    const [command, args] = this.command(['run']);
    const child = spawn(command, args, { cwd: LX_ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (this.output += String(d)));
    child.stderr.on('data', (d) => (this.output += String(d)));
    this.child = child;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 20_000): Promise<void> {
    if (this.service) {
      // systemd's own stop: it returns when the service's processes are gone, or when it killed what was left.
      if (signal === 'SIGTERM') this.systemctl(['stop', this.service]);
      else this.systemctl(['kill', '-s', signal, this.service]);
      return;
    }
    const child = this.child;
    if (!child || !this.alive) return;
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill(signal);
    await Promise.race([gone, sleep(timeoutMs)]);
    if (this.alive) child.kill('SIGKILL');
  }

  /** A local command, as typed on the computer: `status`, `workspaces`, `workspaces shot <desktop> <file>`. */
  cli(args: string[], env: NodeJS.ProcessEnv = this.env): string {
    const [command, full] = this.command(args);
    const r = spawnSync(command, full, { cwd: LX_ROOT, env, encoding: 'utf8', timeout: 90_000 });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  }

  /** The same for a command that stays up until its window is closed (`workspaces view`). */
  spawnCli(args: string[], env: NodeJS.ProcessEnv = this.env): ChildProcess {
    const [command, full] = this.command(args);
    return spawn(command, full, { cwd: LX_ROOT, env, stdio: 'ignore', detached: true });
  }
}

export interface ToolOutcome {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

interface ToolDefinition {
  name: string;
  handler(args: Record<string, unknown>, extra: unknown): Promise<{ content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }>;
}

export interface Chat {
  id: string;
  title: string;
  /** The desktop the brain derives for this chat on the paired computer; used here only to look at it from outside. */
  desktop: string;
  /** Owner of the chat's background jobs on the executor. */
  scope: string;
  tools: Map<string, ToolDefinition>;
}

interface SessionInternals {
  remoteTools(): ToolDefinition[];
  /** Every message of the Claude Code process passes through here. */
  handle(message: unknown): void;
}

interface BrainInternals {
  accountId: string;
  start(): void;
  stop(): void;
  status(): { relayConnected: boolean };
  startPairing(): { uri: string; code: string };
  sessionMode(sessionId: string): { mode: string; executorId?: string; pcId?: string } | undefined;
  sessions: Map<string, SessionInternals>;
  executor: { info(id: string | undefined): { capabilities?: string[]; os?: string; workspaceHost?: string } | null };
  sessionHost(): { canUseTool(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ behavior: string; message?: string }> };
}

type Typed<T extends InnerMessage['type']> = Extract<InnerMessage, { type: T }>;

export interface Device {
  deviceId: string;
  brainId: string;
  send(body: InnerMessageBody): void;
  inbox: InnerMessage[];
  onMessage(handler: (m: InnerMessage, from: string) => void): void;
  next<T extends InnerMessage['type']>(type: T, after?: number, test?: (m: Typed<T>) => boolean, timeoutMs?: number): Promise<Typed<T>>;
  ask<T extends InnerMessage['type']>(body: InnerMessageBody, type: T, test?: (m: Typed<T>) => boolean, timeoutMs?: number): Promise<Typed<T>>;
  close(): void;
}

export interface Consent {
  sessionId: string;
  tool: string;
  input: unknown;
}

export interface Stack {
  scratch: Scratch;
  relayUrl: string;
  brain: BrainInternals;
  /** The phone: a paired client of the owner that understands desktops and subagent cards. */
  phone: Device;
  /** Every question the brain put to the phone before running a tool; the phone said yes to each. */
  consents: Consent[];
  agent: AgentProcess;
  /** PocketClipboard's device id, as it wrote it down when it paired. */
  pcId: string;
  /** The stand-in for the VS Code extension. */
  executor: { deviceId: string; sendStatus(): void; jobs(scope?: string): { id: string; command: string; scope: string | undefined; workspace: string | undefined; running: boolean }[] };
  human: Human;
  pages: Pages;
  browser: Browser | undefined;
  newChat(title: string): Promise<Chat>;
  /** A tool call as Claude Code makes it: the question to the phone first where the tool needs one, then the handler. */
  tool(chat: Chat, name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  /** A fresh link for pairing one more phone, as the brain prints it. */
  pairingUri(): string;
  /** One more phone of the owner, paired now: what a phone that was closed and opened again starts from. */
  newPhone(name: string): Promise<Device>;
  /** The desktop the brain derives for a chat, or for one subagent of it (its task id). */
  desktopOf(chat: Chat, child?: string): string;
  session(chat: Chat): SessionInternals;
  waitForDesktops(): Promise<void>;
  stop(): Promise<void>;
}

export interface StackOptions {
  browser?: string;
  /** false: the stand-in for the person's screen gets no browser (a run that needs none, or runs as root). */
  personBrowser?: boolean;
  agentBundle?: string;
  /** The installed systemd user service to run PocketClipboard as (with `agentBundle`); the scratch home is then the real one. */
  service?: string;
  /** Extra variables for PocketClipboard, e.g. POCKET_WORKSPACE_MAX. */
  agentEnv?: Record<string, string>;
  claudeOptions?: Record<string, unknown>;
  log?: (line: string) => void;
}

export async function startStack(scratch: Scratch, opts: StackOptions = {}): Promise<Stack> {
  const say = opts.log ?? (() => undefined);
  const { generateIdentity, parsePairingCode, parsePairingUri, PEER_FEATURES } = await import('@pocket/protocol');
  const { DeviceLink, joinAccount } = await import('@pocket/transport');
  const { startNodeRelay } = await import('../../../relay/src/node-server.js');
  const { Brain } = await import('../../../brain/src/daemon.js');
  const { AUTO_ALLOWED_TOOLS } = await import('../../../brain/src/claude-tools.js');
  const { PC_ALLOWED_TOOLS } = await import('../../../brain/src/pc-tools.js');
  const { ensureDirs, OWNER_ID } = await import('../../../brain/src/store.js');
  const { jobScope, workspaceId } = await import('../../../brain/src/workspaces.js');
  const { ToolDispatcher } = await import('../../../executor-extension/src/dispatch.js');
  const { createPathGuard } = await import('../../../executor-extension/src/path-guard.js');
  const { backgroundJobs, killAllBackground } = await import('../../../executor-extension/src/tools/index.js');
  const { callPlacement, readWorkspaceHost } = await import('../../../executor-extension/src/workspace-env.js');

  const pages = await startPages();
  const browser = findBrowser(opts.browser);
  say(`browser: ${browser ? `${browser.name} (${browser.path})` : 'none found'}`);
  const human = await startHuman(scratch, opts.personBrowser === false ? undefined : browser, pages.url('H'), `the person's own clipboard ${randomBytes(4).toString('hex')}`);
  say(`stand-in for the person's screen: ${human.DISPLAY}`);
  // From here on this process is "inside the person's session", as VS Code and the PocketClipboard service are.
  process.env.DISPLAY = human.DISPLAY;
  process.env.XAUTHORITY = human.XAUTHORITY;

  ensureDirs();
  const relay = await startNodeRelay({ port: 0 });
  const brain = new Brain(generateIdentity(), { relayUrl: relay.url, devices: [], users: [], allowlist: [], sessions: [], replay: {} }, { persist: false, ...(opts.claudeOptions ? { claudeOptions: opts.claudeOptions } : {}) }) as unknown as BrainInternals;
  brain.start();
  await until('the brain to reach the relay', () => brain.status().relayConnected);

  const links: { close(): void }[] = [];
  const join = async (code: PairingCode, role: 'executor' | 'client', name: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await joinAccount({ relayUrl: relay.url, code, role, name });
      } catch (e) {
        // The brain publishes a code over its socket; the lookup over HTTP can get to the relay first.
        if (attempt >= 40 || !/not found/.test(String(e))) throw e;
        await sleep(50);
      }
    }
  };
  const connect = async (code: PairingCode, role: 'executor' | 'client', name: string): Promise<Device> => {
    const joined = await join(code, role, name);
    const brainId = joined.bundle.brainDeviceId;
    const link = new DeviceLink({ relayUrl: relay.url, accountId: joined.bundle.accountId, deviceId: joined.deviceId, role, identity: joined.identity, peers: { [brainId]: joined.bundle.brainEncPub } });
    links.push(link);
    const inbox: InnerMessage[] = [];
    const handlers: ((m: InnerMessage, from: string) => void)[] = [];
    link.on('message', ({ from, message }) => {
      inbox.push(message);
      for (const handler of handlers) handler(message, from);
    });
    const ready = new Promise<void>((resolve) => link.on('ready', () => resolve()));
    link.connect();
    await ready;
    const next: Device['next'] = (type, after = 0, test = () => true, timeoutMs = 60_000) =>
      until(`${name} ← ${type}`, () => inbox.slice(after).find((m): m is Typed<typeof type> => m.type === type && test(m as Typed<typeof type>)), timeoutMs, 20);
    return {
      deviceId: joined.deviceId,
      brainId,
      send: (body) => link.send(brainId, body),
      inbox,
      onMessage: (handler) => void handlers.push(handler),
      next,
      ask: (body, type, test, timeoutMs) => {
        const mark = inbox.length;
        link.send(brainId, body);
        return next(type, mark, test, timeoutMs);
      },
      close: () => link.close(),
    };
  };

  const phone = await connect(parsePairingUri(brain.startPairing().uri).code, 'client', 'acceptance-phone');
  await phone.ask({ type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } }, 'host.status');
  const consents: Consent[] = [];
  phone.onMessage((m) => {
    if (m.type !== 'permission.request') return;
    consents.push({ sessionId: m.payload.sessionId, tool: m.payload.tool, input: m.payload.input });
    phone.send({ type: 'permission.respond', payload: { requestId: m.payload.requestId, decision: 'allow_session' } });
  });

  // PocketClipboard: paired with the link the phone shows under "Add a computer", then run as the service runs it.
  // As the installed service it keeps the temporary folder and the environment its unit gives it.
  const agentEnv: NodeJS.ProcessEnv = { ...process.env, HOME: scratch.home, ...(opts.service ? {} : { TMPDIR: scratch.tmp }), ...(opts.browser ? { POCKET_WORKSPACE_BROWSER: opts.browser } : {}), ...opts.agentEnv };
  const agent = new AgentProcess(agentEnv, opts.agentBundle, opts.service);
  const pcPairing = await phone.ask({ type: 'computer.pair', payload: {} }, 'computer.pairing');
  if (!pcPairing.payload.uri) throw new Error('The brain sent no pairing link.');
  await agent.pair(pcPairing.payload.uri);
  const pcId = (JSON.parse(readFileSync(path.join(scratch.home, '.pocket-clipboard', 'state.json'), 'utf8')) as { deviceId: string }).deviceId;
  agent.start();
  const waitForDesktops = () =>
    until('PocketClipboard to offer per-chat desktops', () => (brain.executor.info(pcId)?.capabilities ?? []).includes('workspaces') || (!agent.alive && Promise.reject(new Error(`PocketClipboard stopped: ${agent.output.trim().split('\n').pop() ?? ''}`))), 90_000);
  await waitForDesktops();
  say(`PocketClipboard is up (device ${pcId.slice(0, 8)}…, pid ${agent.pid})`);

  // The executor: the extension's dispatcher and placement, with the project folder as its one open folder.
  const codeJoined = await join(parsePairingCode((await phone.ask({ type: 'computer.pair', payload: {} }, 'computer.pairing')).payload.code), 'executor', 'acceptance-code');
  const codeLink = new DeviceLink({ relayUrl: relay.url, accountId: codeJoined.bundle.accountId, deviceId: codeJoined.deviceId, role: 'executor', identity: codeJoined.identity, peers: { [codeJoined.bundle.brainDeviceId]: codeJoined.bundle.brainEncPub } });
  links.push(codeLink);
  const roots = [scratch.project];
  const dispatcher = new ToolDispatcher({
    brainDeviceId: codeJoined.bundle.brainDeviceId,
    send: (body) => void codeLink.send(codeJoined.bundle.brainDeviceId, body),
    createContext: (signal, onOutput, _root, context) => ({ guard: createPathGuard(roots), roots, signal, onOutput, platform: process.platform, ...callPlacement(context) }),
  });
  codeLink.on('message', (m) => dispatcher.handle(m));
  codeLink.on('disconnected', () => dispatcher.killAll());
  const sendStatus = () => {
    const workspaceHost = readWorkspaceHost();
    codeLink.send(codeJoined.bundle.brainDeviceId, {
      type: 'executor.status',
      payload: { workspaces: roots, os: `${os.platform()} ${os.release()}`, shell: 'bash', capabilities: ['tools', 'workspace-env'], ...(workspaceHost ? { workspaceHost } : {}) },
    });
  };
  const codeReady = new Promise<void>((resolve) => codeLink.on('ready', () => resolve()));
  codeLink.connect();
  await codeReady;
  sendStatus();
  await until('the executor to be known as the same login as PocketClipboard', () => {
    const info = brain.executor.info(codeJoined.deviceId);
    return !!info?.workspaceHost && info.workspaceHost === brain.executor.info(pcId)?.workspaceHost;
  });

  const autoAllowed = new Set<string>([...AUTO_ALLOWED_TOOLS, ...PC_ALLOWED_TOOLS]);
  const host = brain.sessionHost();

  return {
    scratch,
    relayUrl: relay.url,
    brain,
    phone,
    consents,
    agent,
    pcId,
    executor: { deviceId: codeJoined.deviceId, sendStatus, jobs: (scope) => backgroundJobs(scope) },
    human,
    pages,
    browser,
    pairingUri: () => brain.startPairing().uri,
    async newPhone(name) {
      const device = await connect(parsePairingUri(brain.startPairing().uri).code, 'client', name);
      await device.ask({ type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } }, 'host.status');
      return device;
    },
    desktopOf: (chat, child) => workspaceId({ accountId: brain.accountId, userId: OWNER_ID, deviceId: pcId, sessionId: chat.id, ...(child ? { child } : {}) }),
    session: (chat) => {
      const session = brain.sessions.get(chat.id);
      if (!session) throw new Error(`The brain has no session for "${chat.title}".`);
      return session;
    },
    waitForDesktops: async () => void (await waitForDesktops()),
    async newChat(title) {
      const id = (await phone.ask({ type: 'session.create', payload: { title } }, 'session.created')).payload.session.sessionId;
      await phone.ask({ type: 'computer.select', payload: { deviceId: codeJoined.deviceId, sessionId: id } }, 'computers.result');
      const mode = brain.sessionMode(id);
      if (mode?.mode !== 'remote' || mode.executorId !== codeJoined.deviceId || mode.pcId !== pcId) throw new Error(`"${title}" is not set up on the Linux computer: ${JSON.stringify(mode)}`);
      const session = brain.sessions.get(id);
      if (!session) throw new Error(`The brain has no session for "${title}".`);
      return {
        id,
        title,
        desktop: workspaceId({ accountId: brain.accountId, userId: OWNER_ID, deviceId: pcId, sessionId: id }),
        scope: jobScope({ accountId: brain.accountId, userId: OWNER_ID, sessionId: id }),
        tools: new Map(session.remoteTools().map((t) => [t.name, t])),
      };
    },
    async tool(chat, name, args = {}) {
      const definition = chat.tools.get(name);
      if (!definition) throw new Error(`"${chat.title}" has no tool ${name}`);
      const full = `mcp__pocket__${name}`;
      try {
        if (!autoAllowed.has(full)) {
          const decision = await host.canUseTool(chat.id, full, args, new AbortController().signal);
          if (decision.behavior !== 'allow') return { text: `Not allowed: ${decision.message ?? ''}`, images: [], isError: true };
        }
        const result = await definition.handler(args, {});
        const content = result.content ?? [];
        return {
          text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
          images: content.filter((c) => c.type === 'image').map((c) => ({ data: c.data ?? '', mimeType: c.mimeType ?? '' })),
          isError: result.isError === true,
        };
      } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), images: [], isError: true };
      }
    },
    async stop() {
      // As the extension does when VS Code closes: a command still running for a chat ends with it.
      dispatcher.killAll();
      killAllBackground();
      await agent.stop();
      for (const link of links) link.close();
      brain.stop();
      await relay.close();
      human.stop();
      await pages.close();
    },
  };
}
