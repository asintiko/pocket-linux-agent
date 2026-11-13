import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync, accessSync, constants as fsConstants } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import {
  chatCommandEnvironment,
  WORKSPACE_HOST_FILE,
  WORKSPACE_ID_PATTERN,
  WORKSPACE_LIVE_FILE,
  WORKSPACE_ROOT_SEGMENTS,
  workspaceLiveSchema,
  type ScreenImage,
  type WorkspaceBinding,
  type WorkspaceErrorCode,
  type WorkspaceInfo,
  type WorkspaceLive,
  type WorkspaceProcess,
} from '@pocket/protocol';
import type { ClipboardBackend } from '../clipboard.js';
import { ComputerHost } from '../computer.js';
import { createLinuxClipboard } from './clipboard.js';
import { LINUX_PYTHON } from './computer.js';

/**
 * Per-chat Linux desktops. Every chat that works on this computer gets an X server of its own (Xvfb) with its own
 * access cookie, session bus, window manager, input helper, clipboard, browser profile and application state. The
 * person's own desktop is not involved: nothing here reads their DISPLAY, and a desktop that cannot be started is an
 * error, never a reason to use theirs.
 *
 * The brain names a desktop (see WORKSPACE_ID_PATTERN); this class maps the name to resources it allocates itself.
 * Display numbers, cookie files and sockets never come from a message.
 */

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkspaceSettings {
  /** Desktops that may run at once. */
  max: number;
  /** A desktop nobody used for this long is closed; its files stay. */
  idleMs: number;
  /** When all slots are taken, a desktop idle for at least this long gives way to a new one. */
  evictAfterMs: number;
  /** Files of a desktop nobody used for this long (browser profile, application state) are removed. */
  retainMs: number;
  /** How long the programs of a desktop that is closed with its files kept get to end by themselves; 0 asks nothing of them. */
  quitMs: number;
  width: number;
  height: number;
  /** Display numbers are tried from here, so the low ones stay with real sessions. */
  displayBase: number;
  displaySpan: number;
}

const int = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** Limits and sizes, from POCKET_WORKSPACE_* when the service sets them. */
export function workspaceSettings(env: NodeJS.ProcessEnv = process.env): WorkspaceSettings {
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(env.POCKET_WORKSPACE_SIZE ?? '');
  return {
    max: int(env.POCKET_WORKSPACE_MAX, 6, 1, 32),
    idleMs: int(env.POCKET_WORKSPACE_IDLE_MINUTES, 30, 1, 7 * 24 * 60) * 60_000,
    evictAfterMs: int(env.POCKET_WORKSPACE_EVICT_MINUTES, 2, 0, 24 * 60) * 60_000,
    retainMs: int(env.POCKET_WORKSPACE_RETAIN_DAYS, 14, 1, 3650) * 24 * 60 * 60_000,
    // Well inside the ten seconds the service gets to stop, and the thirty the brain waits for a reset.
    quitMs: 5000,
    width: size ? Math.min(3840, Math.max(640, Number(size[1]))) : 1280,
    height: size ? Math.min(2160, Math.max(480, Number(size[2]))) : 800,
    displayBase: int(env.POCKET_WORKSPACE_DISPLAY_BASE, 100, 1, 60_000),
    displaySpan: 400,
  };
}

export const workspaceRoot = (home: string = os.homedir()): string => path.join(home, ...WORKSPACE_ROOT_SEGMENTS);

/** A folder only its owner can enter; refuses one that is somebody else's or a link to elsewhere. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}

function writePrivate(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The name of this login, shared with the VS Code extension through a file only this user can read. */
export function workspaceHostId(root: string, create: boolean): string | undefined {
  const file = path.join(root, WORKSPACE_HOST_FILE);
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (/^[a-z0-9]{16,64}$/.test(value)) return value;
  } catch {}
  if (!create) return undefined;
  ensurePrivateDir(root);
  const value = randomBytes(16).toString('hex');
  writePrivate(file, `${value}\n`);
  return value;
}

const FAMILY_LOCAL = 256;
const FAMILY_WILD = 0xffff;

/**
 * An Xauthority file for one display: the MIT-MAGIC-COOKIE-1 for display `number` and no other. It is written twice,
 * once for this host by name, which is the only form some client libraries look for (python-xlib), and once for any
 * host name (the "wild" family), so the desktop keeps working when the machine is renamed.
 */
export function xauthorityRecord(number: number, cookie: Buffer, hostname: string = os.hostname()): Buffer {
  const field = (data: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length);
    return Buffer.concat([length, data]);
  };
  const record = (family: number, address: string) => {
    const head = Buffer.alloc(2);
    head.writeUInt16BE(family);
    return Buffer.concat([head, field(Buffer.from(address)), field(Buffer.from(String(number))), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
  };
  return Buffer.concat([record(FAMILY_LOCAL, hostname), record(FAMILY_WILD, '')]);
}

/** When the process started, as the kernel counts it: a pid alone may by now be another program. */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The name in brackets may hold spaces and brackets; the fields are counted after the last one.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined;
  } catch {
    return undefined;
  }
}

export const sameProcess = (p: WorkspaceProcess): boolean => processStart(p.pid) === p.start;

/** Whether a process is still at work: one that has ended and only waits for its parent to notice is not. */
function atWork(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch {
    return false;
  }
}

/** Whether a process carries the mark every process of desktop `id` is started with. Only its own user can read this. */
function startedFor(pid: number, id: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`POCKET_WORKSPACE_ID=${id}`);
  } catch {
    return false;
  }
}

/** Where the input helpers of a running desktop write down the programs they start for the chat, one per line. */
const STARTED_FILE = 'started';

/**
 * The programs of that list that are still the ones written down: the same pid with the same start time, started
 * with this desktop's mark. A line that fits nothing, or a pid that is by now another program, is passed over; so
 * is a program whose environment cannot be read, as a browser's, which ends with the X server it is a client of.
 */
export function programsStarted(runDir: string, id: string): number[] {
  let lines: string[] = [];
  try {
    lines = readFileSync(path.join(runDir, STARTED_FILE), 'utf8').split('\n');
  } catch {}
  const found = new Set<number>();
  for (const line of lines) {
    const m = /^(\d{1,10}) (\d{1,20})$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid > 1 && processStart(pid) === m[2] && startedFor(pid, id)) found.add(pid);
  }
  return [...found];
}

/** Each was started as the leader of its own session, so the group is that program and what it started itself. */
function signalProgram(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function which(command: string, pathVariable: string | undefined): string | undefined {
  if (command.includes('/')) return existsSync(command) ? command : undefined;
  for (const dir of (pathVariable ?? '').split(':').filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Window managers that speak EWMH, which the input helper needs to list, focus and close windows. */
const WINDOW_MANAGERS: readonly { command: string; args: readonly string[] }[] = [
  { command: 'openbox', args: ['--sm-disable'] },
  { command: 'xfwm4', args: ['--sm-client-disable', '--compositor=off'] },
  { command: 'fluxbox', args: ['-no-slit', '-no-toolbar'] },
  { command: 'icewm', args: ['--notray'] },
  { command: 'metacity', args: ['--sm-disable'] },
];

const CHROMIUM_FAMILY = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'brave-browser', 'microsoft-edge', 'vivaldi'];
const FIREFOX_FAMILY = ['firefox', 'firefox-esr', 'librewolf'];
const BROWSER_ALIASES = ['x-www-browser', 'sensible-browser', 'gnome-www-browser'];

export interface WorkspaceEnvironment {
  /** What a command of the chat gets on top of its own environment: where its windows go, nothing else. */
  command: Record<string, string>;
  /** Folders put in front of PATH. */
  path: string[];
  /** The same plus application state of the desktop's own: what programs started inside it get. */
  app: Record<string, string>;
}

export function workspaceEnvironment(a: { id: string; generation: number; dir: string; runDir: string; display: string; dataHome: string; dataDirs: string | undefined }): WorkspaceEnvironment {
  const bin = path.join(a.dir, 'bin');
  const home = path.join(a.dir, 'home');
  const command: Record<string, string> = {
    DISPLAY: a.display,
    XAUTHORITY: path.join(a.dir, 'Xauthority'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(a.runDir, 'bus')}`,
    XDG_SESSION_TYPE: 'x11',
    XDG_CURRENT_DESKTOP: 'Pocket',
    BROWSER: path.join(bin, 'pocket-browser'),
    // A Chromium-family browser started some way the wrappers do not see (a menu entry with a full path) keeps its
    // profile here too: it must never find the person's own profile, whose running browser would take the page over.
    CHROME_CONFIG_HOME: path.join(home, 'config'),
    POCKET_WORKSPACE_ID: a.id,
    POCKET_WORKSPACE_GENERATION: String(a.generation),
    POCKET_WORKSPACE_DIR: a.dir,
  };
  const app: Record<string, string> = {
    ...command,
    XDG_RUNTIME_DIR: a.runDir,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    // Programs the person installed for themselves stay findable; what they store goes to the desktop's own folders.
    XDG_DATA_DIRS: [a.dataHome, ...(a.dataDirs || '/usr/local/share:/usr/share').split(':')].filter(Boolean).join(':'),
  };
  return { command, path: [bin], app };
}

/**
 * Small scripts in the desktop's own folder, first on PATH: browsers start with this desktop's profile whether the
 * helper opens them or a shell command does, and `pocket-app` gives any program the desktop's application state.
 */
export function writeWrappers(a: { dir: string; pathVariable: string | undefined; app: Record<string, string>; preferred?: string }): string[] {
  const bin = path.join(a.dir, 'bin');
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const searchPath = (a.pathVariable ?? '').split(':').filter((d) => d && path.resolve(d) !== bin).join(':');
  const script = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  const wrapped: string[] = [];
  for (const name of CHROMIUM_FAMILY) {
    const real = which(name, searchPath);
    if (!real) continue;
    const profile = path.join(a.dir, 'profiles', name);
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    script(
      name,
      [
        `# ${name} with this desktop's own profile; a profile the caller names is left alone.`,
        `for arg in "$@"; do case "$arg" in --user-data-dir|--user-data-dir=*) exec ${shellQuote(real)} "$@";; esac; done`,
        `exec ${shellQuote(real)} --user-data-dir=${shellQuote(profile)} --no-first-run --no-default-browser-check --password-store=basic "$@"`,
      ].join('\n'),
    );
    wrapped.push(name);
  }
  for (const name of FIREFOX_FAMILY) {
    const real = which(name, searchPath);
    if (!real) continue;
    const profile = path.join(a.dir, 'profiles', name);
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    // Firefox asks on a later start whether it should be the default browser, over the page it was opened for.
    // Chromium is told not to ask by a flag above; Firefox takes that from its profile only. The profile is this
    // desktop's, made here, and what the machine's default browser is stays the person's to say.
    const prefs = path.join(profile, 'user.js');
    if (!existsSync(prefs)) writeFileSync(prefs, 'user_pref("browser.shell.checkDefaultBrowser", false);\n', { mode: 0o600 });
    script(
      name,
      [
        `# ${name} with this desktop's own profile; a profile the caller names is left alone.`,
        `for arg in "$@"; do case "$arg" in -P|-p|-profile|--profile|-ProfileManager|--ProfileManager) exec ${shellQuote(real)} "$@";; esac; done`,
        `exec ${shellQuote(real)} --profile ${shellQuote(profile)} "$@"`,
      ].join('\n'),
    );
    wrapped.push(name);
  }
  // The browser the machine calls its default, when it is one that has a profile here; else the first there is.
  let chosen = a.preferred && wrapped.includes(a.preferred) ? a.preferred : undefined;
  if (!chosen) {
    const system = which('x-www-browser', searchPath);
    try {
      const target = system ? path.basename(realpathSync(system)) : undefined;
      if (target && wrapped.includes(target)) chosen = target;
    } catch {}
  }
  chosen ??= [...FIREFOX_FAMILY, ...CHROMIUM_FAMILY].find((name) => wrapped.includes(name));
  script(
    'pocket-browser',
    chosen
      ? `# The browser of this desktop.\nexec ${shellQuote(path.join(bin, chosen))} "$@"`
      : `echo "No supported browser is installed on this computer (firefox, firefox-esr, chromium, google-chrome)." >&2\nexit 127`,
  );
  for (const alias of BROWSER_ALIASES) script(alias, `exec ${shellQuote(path.join(bin, 'pocket-browser'))} "$@"`);
  // The system's xdg-open starts the default browser the way its menu entry names it, often by full path: past the
  // wrappers above, so with the person's own profile, or held up by a first-run dialog nobody is there to answer.
  const systemOpen = which('xdg-open', searchPath);
  script(
    'xdg-open',
    [
      `# Web addresses and pages open in this desktop's browser; everything else is the system's xdg-open's business.`,
      `case "$1" in`,
      `  http://*|https://*|HTTP://*|HTTPS://*|*.html|*.htm|*.xhtml) exec ${shellQuote(path.join(bin, 'pocket-browser'))} "$@";;`,
      `esac`,
      systemOpen ? `exec ${shellQuote(systemOpen)} "$@"` : `echo "xdg-open is not installed on this computer (xdg-utils)." >&2\nexit 127`,
    ].join('\n'),
  );
  const exported = ['XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_DATA_DIRS']
    .filter((name) => a.app[name] !== undefined)
    .map((name) => `${name}=${shellQuote(a.app[name]!)}`)
    .join(' ');
  script(
    'pocket-app',
    [
      `# Runs a program with this desktop's own application state: its settings, cache, data and runtime folder.`,
      `[ "$#" -gt 0 ] || { echo "usage: pocket-app <program> [arguments]" >&2; exit 2; }`,
      `export ${exported}`,
      `exec "$@"`,
    ].join('\n'),
  );
  return wrapped;
}

interface Meta {
  id: string;
  generation: number;
  label?: string;
  parent?: string;
  createdAt: number;
  lastUsedAt: number;
}

interface Running {
  generation: number;
  display: string;
  runDir: string;
  xvfb: ChildProcess;
  dbus: ChildProcess;
  wm: ChildProcess;
  helper: ComputerHost;
  clipboard: ClipboardBackend;
  env: Record<string, string>;
  startedAt: number;
  wmRestarts: number[];
}

interface Entry extends Meta {
  dir: string;
  state: WorkspaceInfo['state'];
  error?: string;
  starting?: Promise<Running>;
  running?: Running;
  stopping?: Promise<void>;
  metaSavedAt: number;
}

/** A desktop in use: what a request works with. */
export interface WorkspaceSession {
  info: WorkspaceInfo;
  computer: ComputerHost;
  clipboard: ClipboardBackend;
}

export interface WorkspaceManagerOptions {
  /** Where desktops keep their files; see workspaceRoot. */
  root: string;
  /** The input helper (computer.py). */
  helperScript: string;
  log: (m: string) => void;
  settings?: Partial<WorkspaceSettings>;
  /** The environment desktops are derived from; the person's session variables in it are dropped. */
  baseEnv?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  now?: () => number;
  /** Names or paths of the programs, for tests and unusual installations. */
  commands?: Partial<{ xvfb: string; dbus: string; xprop: string; xsetroot: string; setpriv: string }>;
}

const alive = (child: ChildProcess | undefined): child is ChildProcess => !!child && child.exitCode === null && child.signalCode === null && child.pid !== undefined;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!alive(child)) return;
  try {
    // Each of these was started as the leader of its own group, so nothing outside it is reached.
    process.kill(-child.pid!, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

async function terminate(children: (ChildProcess | undefined)[], graceMs = 2500): Promise<void> {
  const live = children.filter(alive);
  if (!live.length) return;
  const gone = Promise.all(live.map((c) => new Promise<void>((resolve) => (alive(c) ? c.once('exit', () => resolve()) : resolve()))));
  for (const c of live) signalGroup(c, 'SIGTERM');
  const timer = setTimeout(() => {
    for (const c of live) signalGroup(c, 'SIGKILL');
  }, graceMs);
  await gone;
  clearTimeout(timer);
}

/** The first line a freshly started program writes to `stream`, or why there will be none. */
function firstLine(stream: Readable, child: ChildProcess, what: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const done = (fn: () => void) => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      fn();
    };
    const onData = (d: Buffer) => {
      text += d.toString('utf8');
      const nl = text.indexOf('\n');
      if (nl >= 0) done(() => resolve(text.slice(0, nl).trim()));
    };
    const onExit = (code: number | null, signal: string | null) => done(() => reject(new Error(`${what} stopped at once (${signal ?? `code ${code}`})`)));
    const onError = (e: Error) => done(() => reject(new Error(`${what} could not be started: ${e.message}`)));
    const timer = setTimeout(() => done(() => reject(new Error(`${what} did not get ready in ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
    stream.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

interface Quiet {
  code: number | null;
  out: string;
  /** Why there is no exit code: the signal that ended the program, or what kept it from running to its end. */
  ended?: string;
}

function runQuiet(spawn: typeof nodeSpawn, command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<Quiet> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (code: number | null, ended?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, ...(ended ? { ended } : {}) });
    };
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `did not finish in ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (e) => finish(null, `could not be started: ${e.message}`));
    child.on('close', (code, signal) => finish(code, signal ? `ended by ${signal}` : undefined));
  });
}

/** Why a program run by runQuiet did not do its work, in a few words for the log; undefined when it did. */
function failure(command: string, r: Quiet): string | undefined {
  if (r.code === 0) return undefined;
  const said = r.out.trim().split('\n')[0]?.slice(0, 160);
  return `${path.basename(command)} ${r.ended ?? `exit ${r.code}`}${said ? `: ${said}` : ''}`;
}

/**
 * The windows a window manager lists on the root window, as `xprop -root _NET_CLIENT_LIST` prints them. Undefined
 * when there is no such list: no window manager is there to keep one, which is not the same as no window being open.
 */
export function clientList(text: string): string[] | undefined {
  const line = /^_NET_CLIENT_LIST\(WINDOW\): window id #(.*)$/m.exec(text);
  if (!line) return undefined;
  return (line[1]!.match(/0x[0-9a-f]+/gi) ?? []).filter((id) => Number.parseInt(id, 16) !== 0);
}

/** The process a window names as its own in `xprop -id <window> _NET_WM_PID`; 0 when it names none, as Tk's do not. */
export function windowPid(text: string): number {
  const named = /^_NET_WM_PID\(CARDINAL\) = (\d+)/m.exec(text);
  return named ? Number(named[1]) : 0;
}

/**
 * Whether an X server holds display number `n`: its lock names a process that is there, or something answers on its
 * socket. An X server that was killed outright leaves its socket behind, sometimes its lock, and neither is a
 * display: taken for one, every such number would be lost until someone cleared /tmp by hand. The next X server
 * replaces what was left, and it still takes the number atomically, so being wrong here costs one failed start.
 */
export async function displayInUse(n: number): Promise<boolean> {
  try {
    const pid = Number.parseInt(readFileSync(`/tmp/.X${n}-lock`, 'utf8').trim(), 10);
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // Someone else's process is still a process.
        if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
      }
    }
  } catch {}
  const answers = (address: string) =>
    new Promise<boolean>((resolve) => {
      const probe = net.connect(address);
      const done = (answer: boolean) => {
        clearTimeout(timer);
        probe.destroy();
        resolve(answer);
      };
      // No answer in time is not a refusal: leave such a number alone.
      const timer = setTimeout(() => done(true), 500);
      probe.once('connect', () => done(true));
      probe.once('error', (e: NodeJS.ErrnoException) => done(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'));
    });
  // An X server on Linux listens under the same name outside the file system as well, and one that could not
  // replace a socket someone else left behind listens only there.
  if (await answers(`\0/tmp/.X11-unix/X${n}`)) return true;
  const socket = `/tmp/.X11-unix/X${n}`;
  return existsSync(socket) ? answers(socket) : false;
}

export class WorkspaceManager {
  readonly settings: WorkspaceSettings;
  readonly hostId: string;
  private readonly entries = new Map<string, Entry>();
  private readonly reserved = new Set<number>();
  /**
   * The last generation of desktops whose files were removed. A desktop that comes back under the same name counts
   * on from there, so a step planned on the removed one can never fit the new one.
   */
  private readonly retired = new Map<string, { generation: number; at: number }>();
  private readonly spawn: typeof nodeSpawn;
  private readonly now: () => number;
  private readonly base: NodeJS.ProcessEnv;
  private readonly sweep: ReturnType<typeof setInterval>;
  private closed = false;
  private pdeathsig: boolean | undefined;

  constructor(private readonly opts: WorkspaceManagerOptions) {
    this.settings = { ...workspaceSettings(opts.baseEnv ?? process.env), ...opts.settings };
    this.spawn = opts.spawn ?? nodeSpawn;
    this.now = opts.now ?? Date.now;
    this.base = opts.baseEnv ?? process.env;
    ensurePrivateDir(opts.root);
    this.hostId = workspaceHostId(opts.root, true)!;
    this.loadRetired();
    this.recover();
    this.sweep = setInterval(() => void this.closeIdle().catch(() => undefined), 60_000);
    this.sweep.unref();
  }

  /** Why desktops cannot be started here, or null when everything needed is installed. */
  static unavailable(env: NodeJS.ProcessEnv = process.env, commands: WorkspaceManagerOptions['commands'] = {}): string | null {
    if (process.platform !== 'linux') return 'Per-chat desktops exist on Linux only.';
    const need = [commands.xvfb ?? 'Xvfb', commands.dbus ?? 'dbus-daemon', commands.xprop ?? 'xprop', LINUX_PYTHON.command, 'xdotool', 'wmctrl', 'xrandr', 'xwininfo'];
    const missing = need.filter((c) => !which(c, env.PATH));
    if (!WINDOW_MANAGERS.some((w) => which(w.command, env.PATH))) missing.push('openbox');
    return missing.length ? `Missing on this computer: ${missing.join(', ')}. Run apps/clipboard-agent/scripts/install-linux.sh again.` : null;
  }

  /**
   * The desktop a request names. Without a generation it is started when it is not running; with one, a desktop
   * that is gone or was started again since is stale and the request must not be carried out.
   */
  async use(binding: WorkspaceBinding): Promise<WorkspaceSession> {
    const entry = this.entry(binding);
    if (binding.generation !== undefined) {
      if (entry.state !== 'running' || !entry.running || entry.generation !== binding.generation) {
        throw new WorkspaceError(
          'workspace_stale',
          entry.state === 'running' || entry.state === 'starting'
            ? 'This desktop was started again since the last screenshot: what was on it is gone. Take a new screenshot first.'
            : `This desktop is not running any more${entry.error ? ` (${entry.error})` : ''}. Take a new screenshot to start a fresh one.`,
        );
      }
      this.touch(entry);
      return this.session(entry, entry.running);
    }
    return this.session(entry, await this.start(entry));
  }

  /** What is known about a desktop without starting it. */
  status(binding: WorkspaceBinding): WorkspaceInfo {
    return this.info(this.entry(binding, false));
  }

  list(): WorkspaceInfo[] {
    return [...this.entries.values()].map((e) => this.info(e));
  }

  /** For the local command line: where each desktop keeps its files. */
  describe(): (WorkspaceInfo & { dir: string })[] {
    return [...this.entries.values()].map((e) => ({ ...this.info(e), dir: e.dir }));
  }

  /** A picture of a running desktop for someone looking in; it is not started for that. */
  async capture(id: string): Promise<{ image: ScreenImage; info: WorkspaceInfo }> {
    const entry = this.known(id);
    if (!entry?.running || entry.state !== 'running') throw new WorkspaceError('workspace_unavailable', 'This desktop is not running right now.');
    const result = await entry.running.helper.peek();
    if (!result.image) throw new WorkspaceError('workspace_unavailable', 'The desktop returned no picture.');
    return { image: result.image, info: this.info(entry) };
  }

  /** Closes a desktop and everything in it; `wipe` also removes what it stored. Its children go the same way when asked. */
  async reset(id: string, opts: { wipe?: boolean; children?: boolean } = {}): Promise<WorkspaceInfo | undefined> {
    this.validId(id);
    const targets = [...this.entries.values()].filter((e) => e.id === id || (opts.children && e.parent === id));
    // What is deleted with its files has nothing to save first.
    await Promise.all(targets.map((e) => this.stop(e, opts.wipe ? 'deleted' : 'reset', 'stopped', !opts.wipe)));
    if (opts.wipe) {
      for (const e of targets) this.forget(e);
      // A desktop this run never saw may still have files from an earlier one.
      const dir = path.join(this.opts.root, id);
      if (!targets.some((e) => e.id === id)) {
        try {
          const generation = Number((JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Partial<Meta>).generation);
          if (Number.isInteger(generation) && generation > 0) this.retire(id, generation);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
    const entry = this.entries.get(id);
    return entry ? this.info(entry) : undefined;
  }

  /** The kill switch for one desktop: queued steps are dropped and every key and button is let go. */
  release(id: string): void {
    this.known(id)?.running?.helper.release();
  }

  releaseAll(): void {
    for (const e of this.entries.values()) e.running?.helper.release();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweep);
    await Promise.all([...this.entries.values()].map((e) => this.stop(e, 'PocketClipboard is closing')));
  }

  /** Closes desktops nobody used for a while; their files stay until the retention time is over as well. */
  async closeIdle(): Promise<void> {
    const now = this.now();
    const idle = [...this.entries.values()].filter((e) => e.state === 'running' && e.running && !e.running.helper.busy && now - e.lastUsedAt > this.settings.idleMs);
    await Promise.all(idle.map((e) => this.stop(e, 'idle')));
    for (const e of [...this.entries.values()]) {
      if (e.state !== 'running' && e.state !== 'starting' && !e.stopping && now - e.lastUsedAt > this.settings.retainMs) this.forget(e);
    }
  }

  private validId(id: string): void {
    if (!WORKSPACE_ID_PATTERN.test(id)) throw new WorkspaceError('workspace_unavailable', 'That is not the name of a desktop.');
  }

  private known(id: string): Entry | undefined {
    this.validId(id);
    return this.entries.get(id);
  }

  private entry(binding: WorkspaceBinding, create = true): Entry {
    this.validId(binding.id);
    if (binding.parent !== undefined) this.validId(binding.parent);
    let entry = this.entries.get(binding.id);
    if (!entry) {
      const now = this.now();
      entry = { id: binding.id, generation: this.retired.get(binding.id)?.generation ?? 0, createdAt: now, lastUsedAt: now, dir: path.join(this.opts.root, binding.id), state: 'stopped', metaSavedAt: 0 };
      if (!create) return { ...entry, ...(binding.label ? { label: binding.label } : {}), ...(binding.parent ? { parent: binding.parent } : {}) };
      this.entries.set(binding.id, entry);
    }
    if (binding.label !== undefined && binding.label !== entry.label) {
      entry.label = binding.label;
      entry.metaSavedAt = 0;
    }
    if (binding.parent !== undefined && binding.parent !== entry.parent) {
      entry.parent = binding.parent;
      entry.metaSavedAt = 0;
    }
    return entry;
  }

  private info(e: Entry): WorkspaceInfo {
    return {
      id: e.id,
      generation: e.generation,
      state: e.state,
      ...(e.running ? { display: e.running.display, width: this.settings.width, height: this.settings.height, startedAt: e.running.startedAt } : {}),
      ...(e.label ? { label: e.label } : {}),
      ...(e.parent ? { parent: e.parent } : {}),
      lastUsedAt: e.lastUsedAt,
      ...(e.error ? { error: e.error.slice(0, 500) } : {}),
    };
  }

  private session(entry: Entry, running: Running): WorkspaceSession {
    return { info: this.info(entry), computer: running.helper, clipboard: running.clipboard };
  }

  private touch(entry: Entry): void {
    entry.lastUsedAt = this.now();
    if (entry.lastUsedAt - entry.metaSavedAt > 60_000) this.saveMeta(entry);
  }

  private saveMeta(entry: Entry): void {
    try {
      ensurePrivateDir(entry.dir);
      const meta: Meta = { id: entry.id, generation: entry.generation, ...(entry.label ? { label: entry.label } : {}), ...(entry.parent ? { parent: entry.parent } : {}), createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt };
      writePrivate(path.join(entry.dir, 'meta.json'), JSON.stringify(meta));
      entry.metaSavedAt = entry.lastUsedAt;
    } catch (e) {
      this.opts.log(`workspace ${entry.id}: could not save its record: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private forget(entry: Entry): void {
    this.entries.delete(entry.id);
    if (entry.generation > 0) this.retire(entry.id, entry.generation);
    rmSync(entry.dir, { recursive: true, force: true });
  }

  private retiredFile(): string {
    return path.join(this.opts.root, 'retired.json');
  }

  private loadRetired(): void {
    try {
      const saved = JSON.parse(readFileSync(this.retiredFile(), 'utf8')) as Record<string, { generation?: unknown; at?: unknown }>;
      const now = this.now();
      for (const [id, value] of Object.entries(saved)) {
        const generation = Number(value?.generation);
        const at = Number(value?.at);
        if (WORKSPACE_ID_PATTERN.test(id) && Number.isInteger(generation) && generation > 0 && now - at < this.settings.retainMs) this.retired.set(id, { generation, at });
      }
    } catch {}
  }

  /** Remembers how far a removed desktop had counted, for as long as files of an unused desktop would have been kept. */
  private retire(id: string, generation: number): void {
    const now = this.now();
    this.retired.delete(id);
    this.retired.set(id, { generation, at: now });
    for (const [known, value] of this.retired) {
      if (now - value.at >= this.settings.retainMs || this.retired.size > 500) this.retired.delete(known);
    }
    try {
      writePrivate(this.retiredFile(), JSON.stringify(Object.fromEntries(this.retired)));
    } catch (e) {
      this.opts.log(`could not note the removed desktop ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async start(entry: Entry): Promise<Running> {
    if (this.closed) throw new WorkspaceError('workspace_unavailable', 'PocketClipboard is closing.');
    if (entry.stopping) await entry.stopping;
    if (entry.state === 'running' && entry.running) {
      this.touch(entry);
      return entry.running;
    }
    if (entry.starting) return entry.starting;
    await this.makeRoom(entry);
    entry.state = 'starting';
    delete entry.error;
    const starting = this.launch(entry).then(
      (running) => {
        entry.running = running;
        entry.state = 'running';
        entry.starting = undefined;
        this.touch(entry);
        this.opts.log(`workspace ${entry.id}: desktop ${running.display} is up, generation ${running.generation}`);
        return running;
      },
      (e: unknown) => {
        entry.starting = undefined;
        entry.state = 'failed';
        entry.error = e instanceof Error ? e.message : String(e);
        this.opts.log(`workspace ${entry.id}: could not start: ${entry.error}`);
        throw e instanceof WorkspaceError ? e : new WorkspaceError('workspace_unavailable', `The desktop for this chat could not be started: ${entry.error}`);
      },
    );
    entry.starting = starting;
    return starting;
  }

  /** Keeps the number of desktops within the limit: one that sat idle gives way, otherwise the new one is refused. */
  private async makeRoom(entry: Entry): Promise<void> {
    const active = [...this.entries.values()].filter((e) => e !== entry && (e.state === 'running' || e.state === 'starting'));
    if (active.length < this.settings.max) return;
    const now = this.now();
    const idle = active
      .filter((e) => e.state === 'running' && e.running && !e.running.helper.busy && now - e.lastUsedAt >= this.settings.evictAfterMs)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) {
      throw new WorkspaceError(
        'workspace_limit',
        `This computer already runs ${active.length} chat desktops, which is its limit. Close one from its chat, or raise POCKET_WORKSPACE_MAX for PocketClipboard.`,
      );
    }
    await this.stop(idle, 'made room for another chat');
  }

  /** Where the desktops' sockets live: short paths in the user's runtime folder, apart for every root. */
  private runtimeBase(): string {
    const own = this.base.XDG_RUNTIME_DIR;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const tag = this.hostId.slice(0, 8);
    if (own) {
      try {
        const st = statSync(own);
        if (st.isDirectory() && st.uid === uid) return path.join(own, 'pocket-ws', tag);
      } catch {}
    }
    return path.join(os.tmpdir(), `pocket-ws-${uid}`, tag);
  }

  private wrap(command: string, args: string[]): [string, string[]] {
    // If PocketClipboard is killed outright the kernel ends the desktop's processes with it.
    const setpriv = this.pdeathsig ? which(this.opts.commands?.setpriv ?? 'setpriv', this.base.PATH) : undefined;
    return setpriv ? [setpriv, ['--pdeathsig', 'TERM', '--', command, ...args]] : [command, args];
  }

  private async probeParentDeathSignal(): Promise<void> {
    if (this.pdeathsig !== undefined) return;
    const setpriv = which(this.opts.commands?.setpriv ?? 'setpriv', this.base.PATH);
    this.pdeathsig = setpriv ? (await runQuiet(this.spawn, setpriv, ['--pdeathsig', 'TERM', '--', 'true'], this.base)).code === 0 : false;
  }

  private async launch(entry: Entry): Promise<Running> {
    const s = this.settings;
    const commands = this.opts.commands ?? {};
    const reason = WorkspaceManager.unavailable(this.base, commands);
    if (reason) throw new WorkspaceError('workspace_unavailable', reason);
    await this.probeParentDeathSignal();

    const generation = entry.generation + 1;
    entry.generation = generation;
    entry.lastUsedAt = this.now();
    ensurePrivateDir(entry.dir);
    for (const sub of ['log', 'profiles', 'home/config', 'home/cache', 'home/data', 'home/state']) mkdirSync(path.join(entry.dir, sub), { recursive: true, mode: 0o700 });
    // Saved before anything starts: a crash half way can never hand the same generation out twice.
    this.saveMeta(entry);
    rmSync(path.join(entry.dir, WORKSPACE_LIVE_FILE), { force: true });

    const runBase = this.runtimeBase();
    ensurePrivateDir(path.dirname(runBase));
    ensurePrivateDir(runBase);
    const runDir = path.join(runBase, entry.id);
    rmSync(runDir, { recursive: true, force: true });
    ensurePrivateDir(runDir);
    if (path.join(runDir, 'bus').length > 100) throw new WorkspaceError('workspace_unavailable', `The path ${runDir} is too long for a socket.`);

    const started: ChildProcess[] = [];
    let display: number | undefined;
    try {
      const xauthority = path.join(entry.dir, 'Xauthority');
      const cookie = randomBytes(16);
      let xvfb: ChildProcess | undefined;
      let lastError = 'no display number is free';
      for (let n = s.displayBase; n < s.displayBase + s.displaySpan && !xvfb; n++) {
        // The X server takes its number atomically; this only skips the ones that are plainly taken.
        if (this.reserved.has(n) || (await displayInUse(n))) continue;
        // Another desktop of this manager may have taken the number while it was looked at.
        if (this.reserved.has(n)) continue;
        this.reserved.add(n);
        writePrivate(xauthority, xauthorityRecord(n, cookie));
        const log = openSync(path.join(entry.dir, 'log', 'xvfb.log'), 'w', 0o600);
        const [file, args] = this.wrap(commands.xvfb ?? 'Xvfb', [
          `:${n}`,
          '-screen', '0', `${s.width}x${s.height}x24`,
          '-dpi', '96',
          // No network listener, and only holders of the cookie may connect: no host-based access is ever granted.
          '-nolisten', 'tcp',
          '-auth', xauthority,
          '-noreset',
          '-displayfd', '3',
        ]);
        const child = this.spawn(file, args, { env: { ...chatCommandEnvironment(this.base), POCKET_WORKSPACE_ID: entry.id }, stdio: ['ignore', log, log, 'pipe'], detached: true });
        closeSync(log);
        try {
          const reported = await firstLine(child.stdio[3] as Readable, child, 'The X server', 20_000);
          if (reported !== String(n)) throw new Error(`the X server reported display ${reported} instead of ${n}`);
          xvfb = child;
          display = n;
          started.push(child);
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          this.reserved.delete(n);
          await terminate([child], 500);
        }
      }
      if (!xvfb || display === undefined) throw new Error(`No X server could be started: ${lastError}. See ${path.join(entry.dir, 'log', 'xvfb.log')}.`);

      const environment = workspaceEnvironment({
        id: entry.id,
        generation,
        dir: entry.dir,
        runDir,
        display: `:${display}`,
        dataHome: this.base.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
        dataDirs: this.base.XDG_DATA_DIRS,
      });
      const env = chatCommandEnvironment(this.base, { env: environment.app, path: environment.path });
      const xprop = commands.xprop ?? 'xprop';

      const withCookie = await runQuiet(this.spawn, xprop, ['-root', '_NET_SUPPORTING_WM_CHECK'], env);
      if (withCookie.code !== 0) throw new Error(`The new display does not answer: ${withCookie.out.trim().split('\n').pop() ?? 'no reply'}`);
      // Fail closed: a display that lets a client in without the cookie is not one to put a chat's windows on.
      const without = await runQuiet(this.spawn, xprop, ['-root', '_NET_SUPPORTING_WM_CHECK'], { ...env, XAUTHORITY: '/dev/null' });
      if (without.code === 0) throw new Error('The X server accepts clients without the access cookie; it was stopped.');

      const busLog = openSync(path.join(entry.dir, 'log', 'dbus.log'), 'w', 0o600);
      const [busFile, busArgs] = this.wrap(commands.dbus ?? 'dbus-daemon', ['--session', '--nofork', '--nopidfile', `--address=unix:path=${path.join(runDir, 'bus')}`, '--print-address=3']);
      const dbus = this.spawn(busFile, busArgs, { env, stdio: ['ignore', busLog, busLog, 'pipe'], detached: true });
      closeSync(busLog);
      started.push(dbus);
      await firstLine(dbus.stdio[3] as Readable, dbus, 'The session bus', 15_000);

      writeWrappers({ dir: entry.dir, pathVariable: this.base.PATH, app: environment.app, ...(this.base.POCKET_WORKSPACE_BROWSER ? { preferred: this.base.POCKET_WORKSPACE_BROWSER } : {}) });

      const wm = await this.startWindowManager(entry, env);
      started.push(wm);
      const xsetroot = which(commands.xsetroot ?? 'xsetroot', this.base.PATH);
      if (xsetroot) await runQuiet(this.spawn, xsetroot, ['-solid', '#2b3440'], env);

      const helper = new ComputerHost({
        script: this.opts.helperScript,
        log: (m) => this.opts.log(`workspace ${entry.id}: ${m}`),
        shell: LINUX_PYTHON,
        // POCKET_WORKSPACE_STARTED: where it writes down what it starts for the chat, so that the desktop can end
        // those programs when it closes even after this helper was replaced by another.
        env: { ...env, PYTHONUNBUFFERED: '1', POCKET_WORKSPACE_STARTED: path.join(runDir, STARTED_FILE) },
        spawn: this.spawn,
        // SIGTERM tells this helper that its desktop is closing, and it ends what it started there. A helper that is
        // only replaced, because a step was stopped or took too long, must leave those programs running.
        restartSignal: 'SIGUSR1',
      });
      const running: Running = {
        generation,
        display: `:${display}`,
        runDir,
        xvfb,
        dbus,
        wm,
        helper,
        clipboard: createLinuxClipboard(env),
        env,
        startedAt: this.now(),
        wmRestarts: [],
      };

      const record = (child: ChildProcess, role: string) => {
        const start = child.pid !== undefined ? processStart(child.pid) : undefined;
        return child.pid !== undefined && start ? [{ pid: child.pid, start, role }] : [];
      };
      const xserver = record(xvfb, 'xserver')[0];
      if (!xserver) throw new Error('The X server stopped while the desktop was starting.');
      const live: WorkspaceLive = {
        v: 1,
        id: entry.id,
        generation,
        display: `:${display}`,
        xserver: { pid: xserver.pid, start: xserver.start },
        processes: [...record(dbus, 'bus'), ...record(wm, 'wm')],
        env: environment.command,
        path: environment.path,
        startedAt: running.startedAt,
      };
      writePrivate(path.join(entry.dir, WORKSPACE_LIVE_FILE), JSON.stringify(workspaceLiveSchema.parse(live)));

      const displayNumber = display;
      xvfb.once('exit', (code, signal) => {
        this.reserved.delete(displayNumber);
        this.crashed(entry, running, `its X server stopped (${signal ?? `code ${code}`})`);
      });
      dbus.once('exit', (code, signal) => this.crashed(entry, running, `its session bus stopped (${signal ?? `code ${code}`})`));
      this.watchWindowManager(entry, running);
      return running;
    } catch (e) {
      if (display !== undefined) this.reserved.delete(display);
      await terminate(started.reverse(), 1500);
      rmSync(runDir, { recursive: true, force: true });
      rmSync(path.join(entry.dir, WORKSPACE_LIVE_FILE), { force: true });
      throw e;
    }
  }

  private async startWindowManager(entry: Entry, env: Record<string, string>): Promise<ChildProcess> {
    const choice = WINDOW_MANAGERS.find((w) => which(w.command, this.base.PATH));
    if (!choice) throw new Error('No window manager is installed (openbox).');
    const log = openSync(path.join(entry.dir, 'log', 'wm.log'), 'a', 0o600);
    const [file, args] = this.wrap(choice.command, [...choice.args]);
    const wm = this.spawn(file, args, { env, stdio: ['ignore', log, log], detached: true });
    closeSync(log);
    const xprop = this.opts.commands?.xprop ?? 'xprop';
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (!alive(wm)) throw new Error(`The window manager ${choice.command} stopped at once; see ${path.join(entry.dir, 'log', 'wm.log')}.`);
      const probe = await runQuiet(this.spawn, xprop, ['-root', '_NET_SUPPORTING_WM_CHECK'], env);
      if (probe.code === 0 && /window id # 0x[0-9a-f]+/i.test(probe.out)) return wm;
      if (Date.now() > deadline) {
        await terminate([wm], 500);
        throw new Error(`The window manager ${choice.command} did not get ready.`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** A window manager that dies is started again in place; one that keeps dying takes the desktop down. */
  private watchWindowManager(entry: Entry, running: Running): void {
    running.wm.once('exit', (code, signal) => {
      if (entry.running !== running || entry.state !== 'running' || this.closed) return;
      const now = Date.now();
      running.wmRestarts = running.wmRestarts.filter((t) => now - t < 60_000);
      if (running.wmRestarts.length >= 3) return this.crashed(entry, running, `its window manager keeps stopping (${signal ?? `code ${code}`})`);
      running.wmRestarts.push(now);
      this.opts.log(`workspace ${entry.id}: the window manager stopped (${signal ?? `code ${code}`}); starting it again`);
      void this.startWindowManager(entry, running.env).then(
        (wm) => {
          if (entry.running !== running) return void terminate([wm], 500);
          running.wm = wm;
          this.watchWindowManager(entry, running);
        },
        (e: unknown) => this.crashed(entry, running, e instanceof Error ? e.message : String(e)),
      );
    });
  }

  private crashed(entry: Entry, running: Running, why: string): void {
    if (entry.running !== running || entry.stopping) return;
    this.opts.log(`workspace ${entry.id}: ${why}; the desktop is closed`);
    void this.stop(entry, why, 'failed');
  }

  /**
   * Asks the programs on a desktop to end the way a person ends them, by closing their windows, and gives them a
   * moment for it. A browser that just loses its X server is gone before it wrote down what it holds in memory:
   * what a page stored in its last seconds is missing from the profile that is kept, and the next start begins
   * with the offer to restore a session that crashed.
   */
  private async quitPrograms(entry: Entry, running: Running): Promise<void> {
    const limit = this.settings.quitMs;
    if (limit <= 0) return;
    const started = Date.now();
    const xprop = this.opts.commands?.xprop ?? 'xprop';
    // The window manager's own list, read from the root window as the input helper reads it. `wmctrl -l` printed the
    // same list, but where it ended by a signal the desktop looked empty and nothing on it was asked to close.
    const windows = async (): Promise<string[] | { why: string }> => {
      const listed = await runQuiet(this.spawn, xprop, ['-root', '_NET_CLIENT_LIST'], running.env, 2000);
      const why = failure(xprop, listed);
      return why ? { why } : (clientList(listed.out) ?? { why: 'the window manager keeps no list of windows' });
    };
    const open = await windows();
    if (!Array.isArray(open)) {
      this.opts.log(`workspace ${entry.id}: its windows could not be listed (${open.why}); its programs are not asked to close and end with the desktop`);
      return;
    }
    if (!open.length) return;
    const wmctrl = which('wmctrl', running.env.PATH);
    if (!wmctrl) {
      this.opts.log(`workspace ${entry.id}: wmctrl is missing; its programs are not asked to close and end with the desktop`);
      return;
    }
    // Which process each window names has to be read while the window is there.
    const named = await Promise.all(open.map(async (id) => windowPid((await runQuiet(this.spawn, xprop, ['-id', id, '_NET_WM_PID'], running.env, 2000)).out)));
    const refused = (await Promise.all(open.map(async (id) => failure(wmctrl, await runQuiet(this.spawn, wmctrl, ['-i', '-c', id], running.env, 2000))))).filter((why) => why !== undefined);
    if (refused.length) this.opts.log(`workspace ${entry.id}: ${refused.length} of ${open.length} windows could not be asked to close (${refused[0]})`);
    // A program has ended when its process has, which is later than its window. The process a window names is
    // only believed when it is younger than this desktop's X server, as every program on it is: a sandboxed
    // program counts its processes its own way, and the number it gives may be anyone's here.
    const since = Number(processStart(running.xvfb.pid ?? 0));
    const pids = [...new Set(named)].filter((pid) => pid > 1 && Number(processStart(pid)) >= since);
    for (;;) {
      if (!pids.some(atWork)) {
        const left = await windows();
        // A list that cannot be read any more says nothing about windows; the processes have ended, and that counts.
        if (!Array.isArray(left) || !left.length) {
          this.opts.log(`workspace ${entry.id}: its programs closed when asked (${open.length} ${open.length === 1 ? 'window' : 'windows'}, ${Date.now() - started} ms)`);
          return;
        }
      }
      if (Date.now() - started >= limit) {
        this.opts.log(`workspace ${entry.id}: programs were still open after ${Math.round(limit / 1000)} s; they end with the desktop`);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Gives the programs that were told to end a moment for it, and ends the ones that are still there after it. */
  private async endOpened(entry: Entry, runDir: string, graceMs = 1500): Promise<void> {
    const deadline = Date.now() + graceMs;
    let left = programsStarted(runDir, entry.id);
    while (left.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      left = programsStarted(runDir, entry.id);
    }
    if (!left.length) return;
    for (const pid of left) signalProgram(pid, 'SIGKILL');
    this.opts.log(`workspace ${entry.id}: ${left.length === 1 ? 'a program the chat had opened' : `${left.length} programs the chat had opened`} did not end when told to and ${left.length === 1 ? 'was' : 'were'} ended`);
  }

  private stop(entry: Entry, why: string, state: 'stopped' | 'failed' = 'stopped', quit = true): Promise<void> {
    if (entry.stopping) return entry.stopping;
    const stopping = (async () => {
      if (entry.starting) await entry.starting.catch(() => undefined);
      const running = entry.running;
      if (!running) {
        if (entry.state !== 'failed') entry.state = 'stopped';
        return;
      }
      // Gone first, so the VS Code extension stops handing this desktop to commands before its processes end.
      rmSync(path.join(entry.dir, WORKSPACE_LIVE_FILE), { force: true });
      entry.running = undefined;
      entry.state = state;
      if (state === 'failed') entry.error = why;
      else delete entry.error;
      // A desktop whose X server or window manager failed has nobody left to pass the request on.
      if (quit && state === 'stopped') {
        // The chat's hands come off first: a step under way stops and held keys are let go. That ends nothing.
        running.helper.release();
        await this.quitPrograms(entry, running).catch(() => undefined);
      }
      // Closing the helper ends the programs it started here. It comes after they were asked to close like the
      // rest: ended first, a browser the chat opened had not written down what it held.
      running.helper.close();
      // The helper that is closed ends its own. One that was replaced before it (a step was stopped, or took too
      // long) could not, and what that one started is told to end here, while it can still be told from anything
      // else: nothing a helper of this desktop started for the chat outlives the desktop.
      const opened = programsStarted(running.runDir, entry.id);
      for (const pid of opened) signalProgram(pid, 'SIGTERM');
      // The window manager and every program on the desktop are X clients: they end with their X server.
      await terminate([running.wm]);
      await terminate([running.xvfb]);
      await terminate([running.dbus]);
      if (opened.length) await this.endOpened(entry, running.runDir);
      rmSync(running.runDir, { recursive: true, force: true });
      this.saveMeta(entry);
      if (state === 'stopped') this.opts.log(`workspace ${entry.id}: desktop ${running.display} closed (${why})`);
    })().finally(() => {
      entry.stopping = undefined;
    });
    entry.stopping = stopping;
    return stopping;
  }

  /**
   * What an earlier run left behind (PocketClipboard was killed, or crashed). Desktops are not taken over: their
   * processes are ended and the chats get fresh ones, with a new generation, the next time they need one. A process
   * is only ended when it is provably that run's: the same pid with the same start time, started with this
   * desktop's mark in its environment. Anything else, such as a pid that is by now another program, is left alone.
   */
  private recover(): void {
    const now = this.now();
    let names: string[] = [];
    try {
      names = readdirSync(this.opts.root);
    } catch {}
    for (const name of names) {
      if (!WORKSPACE_ID_PATTERN.test(name)) continue;
      const dir = path.join(this.opts.root, name);
      const liveFile = path.join(dir, WORKSPACE_LIVE_FILE);
      const runDir = path.join(this.runtimeBase(), name);
      // What that run's helpers had started for the chat, by the same rule; first, while each can still be told
      // from anything else. A program that is a client of the desktop's X server ends with it below anyway.
      for (const pid of programsStarted(runDir, name)) {
        const start = processStart(pid);
        signalProgram(pid, 'SIGTERM');
        this.opts.log(`workspace ${name}: ended a program (${pid}) left by an earlier run`);
        setTimeout(() => {
          if (start && processStart(pid) === start && startedFor(pid, name)) signalProgram(pid, 'SIGKILL');
        }, 3000).unref();
      }
      try {
        const live = workspaceLiveSchema.parse(JSON.parse(readFileSync(liveFile, 'utf8')));
        for (const p of [{ ...live.xserver, role: 'xserver' }, ...(live.processes ?? [])]) {
          if (!sameProcess(p) || !startedFor(p.pid, name)) continue;
          try {
            process.kill(p.pid, 'SIGTERM');
            this.opts.log(`workspace ${name}: ended ${p.role} ${p.pid} left by an earlier run`);
            setTimeout(() => {
              try {
                if (sameProcess(p)) process.kill(p.pid, 'SIGKILL');
              } catch {}
            }, 3000).unref();
          } catch {}
        }
      } catch {}
      rmSync(liveFile, { force: true });
      rmSync(path.join(this.runtimeBase(), name), { recursive: true, force: true });
      let meta: Meta | undefined;
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Partial<Meta>;
        if (parsed.id === name && typeof parsed.generation === 'number') meta = { id: name, generation: Math.max(0, Math.floor(parsed.generation)), createdAt: Number(parsed.createdAt) || now, lastUsedAt: Number(parsed.lastUsedAt) || now, ...(typeof parsed.label === 'string' ? { label: parsed.label.slice(0, 120) } : {}), ...(typeof parsed.parent === 'string' && WORKSPACE_ID_PATTERN.test(parsed.parent) ? { parent: parsed.parent } : {}) };
      } catch {}
      if (!meta || now - meta.lastUsedAt > this.settings.retainMs) {
        // Nobody used it within the retention time (or it never got as far as a record): its profile goes.
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      this.entries.set(name, { ...meta, dir, state: 'stopped', metaSavedAt: meta.lastUsedAt });
    }
  }
}
