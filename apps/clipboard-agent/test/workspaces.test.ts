import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { chatCommandEnvironment, HUMAN_SESSION_VARIABLES, NO_WAYLAND, WORKSPACE_LIVE_FILE, workspaceLiveSchema, type WorkspaceLive } from '@pocket/protocol';
import {
  clientList,
  displayInUse,
  processStart,
  programsStarted,
  windowPid,
  WorkspaceError,
  workspaceEnvironment,
  WorkspaceManager,
  workspaceSettings,
  writeWrappers,
  xauthorityRecord,
  type WorkspaceManagerOptions,
} from '../src/linux/workspaces.js';

const helper = path.resolve('apps/clipboard-agent/src/linux/computer.py');
const linux = process.platform === 'linux';
const has = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
/** Real desktops need the programs the installer puts there; elsewhere those tests are skipped, not faked. */
const realX = linux && WorkspaceManager.unavailable() === null && has('xclip');

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const desktopId = () => `ws_${Array.from({ length: 26 }, () => BASE32[Math.floor(Math.random() * 32)]).join('')}`;
const temp = (name: string) => mkdtempSync(path.join(tmpdir(), `pocket-${name}-`));
const alive = (pid: number) => existsSync(`/proc/${pid}`) && !/^\S+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));

async function eventually(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Processes that carry the mark every process of desktop `id` is started with. */
function marked(id: string): { pid: number; cmdline: string; environ: string[] }[] {
  const found: { pid: number; cmdline: string; environ: string[] }[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const environ = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
      if (environ.includes(`POCKET_WORKSPACE_ID=${id}`)) found.push({ pid: Number(name), cmdline: readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' '), environ });
    } catch {}
  }
  return found;
}

const managers: WorkspaceManager[] = [];
const children: ChildProcess[] = [];

function manager(settings: WorkspaceManagerOptions['settings'] = {}, extra: Partial<WorkspaceManagerOptions> = {}) {
  const root = extra.root ?? temp('ws');
  const logs: string[] = [];
  const m = new WorkspaceManager({ root, helperScript: helper, log: (line) => logs.push(line), settings, ...extra });
  managers.push(m);
  return { m, root, logs };
}

const liveOf = (root: string, id: string): WorkspaceLive => workspaceLiveSchema.parse(JSON.parse(readFileSync(path.join(root, id, WORKSPACE_LIVE_FILE), 'utf8')));

/**
 * A program for the computer tool's `open` step that is itself no client of the X server: its window belongs to a
 * child, and it stays in the background, as a launcher or a server with a small control window does. It writes its
 * pid down. Nothing ends it when the desktop's X server goes.
 */
function worker(title: string): { file: string; pid: string } {
  const dir = temp('worker');
  const file = path.join(dir, 'worker.sh');
  const pid = path.join(dir, 'pid');
  writeFileSync(file, `#!/bin/sh\npython3 -c "import tkinter; r = tkinter.Tk(); r.title('${title}'); r.mainloop()" &\necho $$ > '${pid}'\nexec sleep 300\n`);
  chmodSync(file, 0o755);
  return { file, pid };
}

/** A small window, started the way the VS Code extension starts a chat's command: with the environment of its desktop. */
function openWindow(live: WorkspaceLive, title: string): ChildProcess {
  const child = spawn('python3', ['-c', `import tkinter\nr=tkinter.Tk()\nr.title(${JSON.stringify(title)})\nr.geometry('240x120+40+40')\nr.mainloop()`], {
    env: chatCommandEnvironment(process.env, live),
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

describe('what a desktop is made of', () => {
  it('writes a cookie file for exactly one display', () => {
    const cookie = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const record = xauthorityRecord(101, cookie, 'kali');
    const entries: { family: number; fields: Buffer[] }[] = [];
    for (let at = 0; at < record.length; ) {
      const family = record.readUInt16BE(at);
      at += 2;
      const fields: Buffer[] = [];
      for (let i = 0; i < 4; i++) {
        const length = record.readUInt16BE(at);
        fields.push(record.subarray(at + 2, at + 2 + length));
        at += 2 + length;
      }
      entries.push({ family, fields });
    }
    expect(entries.map((e) => [e.family, e.fields[0]!.toString(), e.fields[1]!.toString(), e.fields[2]!.toString()])).toEqual([
      [256, 'kali', '101', 'MIT-MAGIC-COOKIE-1'],
      [0xffff, '', '101', 'MIT-MAGIC-COOKIE-1'],
    ]);
    for (const e of entries) expect(e.fields[3]!.equals(cookie)).toBe(true);
  });

  it("gives commands the desktop's display and nothing of the person's session", () => {
    const dir = '/home/u/.pocket-clipboard/workspaces/ws_x';
    const made = workspaceEnvironment({ id: 'ws_x', generation: 3, dir, runDir: '/run/user/1000/pocket-ws/ab/ws_x', display: ':104', dataHome: '/home/u/.local/share', dataDirs: undefined });
    expect(made.command).toMatchObject({
      DISPLAY: ':104',
      XAUTHORITY: `${dir}/Xauthority`,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/pocket-ws/ab/ws_x/bus',
      XDG_SESSION_TYPE: 'x11',
      POCKET_WORKSPACE_ID: 'ws_x',
      POCKET_WORKSPACE_GENERATION: '3',
    });
    // Commands keep the person's own settings for their tools (git, npm); programs of the desktop get its own state.
    expect(made.command.XDG_CONFIG_HOME).toBeUndefined();
    // Except a browser's: one started past the wrappers must not find the person's profile either.
    expect(made.command.CHROME_CONFIG_HOME).toBe(`${dir}/home/config`);
    expect(made.app).toMatchObject({ XDG_CONFIG_HOME: `${dir}/home/config`, XDG_CACHE_HOME: `${dir}/home/cache`, XDG_DATA_HOME: `${dir}/home/data`, XDG_RUNTIME_DIR: '/run/user/1000/pocket-ws/ab/ws_x' });
    expect(made.path).toEqual([`${dir}/bin`]);

    const person = { PATH: '/usr/bin', HOME: '/home/u', DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', DESKTOP_STARTUP_ID: 'x' };
    const inside = chatCommandEnvironment(person, { env: made.command, path: made.path });
    expect(inside).toMatchObject({ DISPLAY: ':104', XAUTHORITY: `${dir}/Xauthority`, WAYLAND_DISPLAY: NO_WAYLAND, XDG_SESSION_TYPE: 'x11', GDK_BACKEND: 'x11', QT_QPA_PLATFORM: 'xcb', HOME: '/home/u', PATH: `${dir}/bin:/usr/bin` });
    expect(inside.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/pocket-ws/ab/ws_x/bus');
    expect(inside.DESKTOP_STARTUP_ID).toBeUndefined();

    // Without a desktop a command has no display at all: a window cannot open anywhere, least of all on the person's screen.
    const outside = chatCommandEnvironment(person);
    for (const name of ['DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'DESKTOP_STARTUP_ID']) expect(outside[name]).toBeUndefined();
    expect(outside).toMatchObject({ WAYLAND_DISPLAY: NO_WAYLAND, GDK_BACKEND: 'x11', HOME: '/home/u', PATH: '/usr/bin' });
    expect(HUMAN_SESSION_VARIABLES).toEqual(expect.arrayContaining(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'SESSION_MANAGER']));
  });

  it.runIf(linux)("starts browsers with the desktop's own profile, and never without their sandbox", () => {
    const dir = temp('wrap');
    const real = path.join(dir, 'real');
    mkdirSync(real);
    for (const name of ['firefox', 'chromium']) writeFileSync(path.join(real, name), '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', { mode: 0o755 });
    const app = { XDG_CONFIG_HOME: path.join(dir, 'home/config'), XDG_RUNTIME_DIR: path.join(dir, 'run') };
    const wrapped = writeWrappers({ dir, pathVariable: `${path.join(dir, 'bin')}:${real}`, app });
    expect(wrapped.sort()).toEqual(['chromium', 'firefox']);
    const run = (name: string, ...args: string[]) => spawnSync(path.join(dir, 'bin', name), args, { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(run('firefox', 'http://localhost:8000/')).toEqual([path.join(real, 'firefox'), '--profile', path.join(dir, 'profiles', 'firefox'), 'http://localhost:8000/']);
    const chromium = run('chromium', 'http://localhost:8000/');
    expect(chromium).toEqual([path.join(real, 'chromium'), `--user-data-dir=${path.join(dir, 'profiles', 'chromium')}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic', 'http://localhost:8000/']);
    expect(chromium.join(' ')).not.toMatch(/no-sandbox|remote-debugging/);
    // A profile the caller names is the caller's business; the default browser is one with a profile here.
    expect(run('chromium', '--user-data-dir=/tmp/other')).toEqual([path.join(real, 'chromium'), '--user-data-dir=/tmp/other']);
    expect(run('pocket-browser', 'about:blank')[0]).toBe(path.join(real, 'firefox'));
    expect(run('x-www-browser', 'about:blank')[0]).toBe(path.join(real, 'firefox'));
    // "Open this address" is the desktop's browser too, whatever the system calls its default; the rest stays the system's.
    writeFileSync(path.join(real, 'xdg-open'), '#!/bin/sh\nprintf "%s\\n" "system" "$@"\n', { mode: 0o755 });
    writeWrappers({ dir, pathVariable: `${path.join(dir, 'bin')}:${real}`, app });
    expect(run('xdg-open', 'https://example.org/a?b=c')).toEqual([path.join(real, 'firefox'), '--profile', path.join(dir, 'profiles', 'firefox'), 'https://example.org/a?b=c']);
    expect(run('xdg-open', '/tmp/report.html')[0]).toBe(path.join(real, 'firefox'));
    expect(run('xdg-open', '/tmp/notes.pdf')).toEqual(['system', '/tmp/notes.pdf']);
    expect(run('xdg-open', 'mailto:someone@example.org')).toEqual(['system', 'mailto:someone@example.org']);
    expect(spawnSync(path.join(dir, 'bin', 'pocket-app'), ['sh', '-c', 'echo $XDG_CONFIG_HOME $XDG_RUNTIME_DIR'], { encoding: 'utf8' }).stdout.trim()).toBe(`${app.XDG_CONFIG_HOME} ${app.XDG_RUNTIME_DIR}`);
    expect(statSync(path.join(dir, 'bin')).mode & 0o077).toBe(0);
  });

  it('keeps its limits within bounds', () => {
    expect(workspaceSettings({})).toMatchObject({ max: 6, idleMs: 30 * 60_000, retainMs: 14 * 24 * 60 * 60_000, width: 1280, height: 800, displayBase: 100 });
    expect(workspaceSettings({ POCKET_WORKSPACE_MAX: '500', POCKET_WORKSPACE_IDLE_MINUTES: '0', POCKET_WORKSPACE_SIZE: '1920x1080', POCKET_WORKSPACE_DISPLAY_BASE: 'x' })).toMatchObject({
      max: 32,
      idleMs: 60_000,
      width: 1920,
      height: 1080,
      displayBase: 100,
    });
    expect(workspaceSettings({ POCKET_WORKSPACE_SIZE: '99999x1' })).toMatchObject({ width: 1280, height: 800 });
  });

  it('reads the windows of a desktop and the process of each from what xprop prints', () => {
    expect(clientList('_NET_CLIENT_LIST(WINDOW): window id # 0x40000e, 0x60000A\n')).toEqual(['0x40000e', '0x60000A']);
    expect(clientList('_NET_CLIENT_LIST(WINDOW): window id # \n')).toEqual([]);
    // No list is not an empty desktop: no window manager is there to keep one, and nothing can be said about windows.
    expect(clientList('_NET_CLIENT_LIST:  no such atom on any window.\n')).toBeUndefined();
    expect(clientList('')).toBeUndefined();
    expect(windowPid('_NET_WM_PID(CARDINAL) = 4242\n')).toBe(4242);
    // Tk's windows name no process.
    expect(windowPid('_NET_WM_PID:  not found.\n')).toBe(0);
  });
});

/** Programs by the names the manager looks for, each a few lines of shell: enough to fail in a chosen way without any X. */
function stubPrograms(xvfb: 'dies' | 'lets-anyone-in'): string {
  const dir = temp('stubs');
  const script = (name: string, body: string) => {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(dir, name), 0o755);
  };
  for (const name of ['dbus-daemon', 'xprop', 'python3', 'xdotool', 'wmctrl', 'xrandr', 'xwininfo', 'openbox']) script(name, 'exit 0');
  script('Xvfb', xvfb === 'dies' ? 'echo "Fatal server error" >&2\nexit 1' : 'for a in "$@"; do case "$a" in :*) n="${a#:}";; esac; done\necho "$n" >&3\nexec /bin/sleep 300');
  return dir;
}

describe.runIf(linux)('a desktop that cannot be started', () => {
  it('is an error for the chat, never another screen', async () => {
    const id = desktopId();
    const { m, root } = manager({ displaySpan: 3 }, { baseEnv: { PATH: stubPrograms('dies'), HOME: temp('home'), DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority' } });
    const failed = await m.use({ id }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(WorkspaceError);
    expect(failed).toMatchObject({ code: 'workspace_unavailable', message: expect.stringMatching(/could not be started: No X server could be started/) });
    expect(m.status({ id })).toMatchObject({ state: 'failed', generation: 1, error: expect.stringMatching(/No X server/) });
    expect(existsSync(path.join(root, id, WORKSPACE_LIVE_FILE))).toBe(false);
    // A step planned on it is stale; looking in shows nothing.
    await expect(m.use({ id, generation: 1 })).rejects.toMatchObject({ code: 'workspace_stale' });
    await expect(m.capture(id)).rejects.toMatchObject({ code: 'workspace_unavailable' });
    expect(marked(id)).toEqual([]);
  });

  it('is refused when its X server would let clients in without the cookie', async () => {
    const id = desktopId();
    const { m, root } = manager({ displaySpan: 3 }, { baseEnv: { PATH: stubPrograms('lets-anyone-in'), HOME: temp('home') } });
    await expect(m.use({ id })).rejects.toMatchObject({ code: 'workspace_unavailable', message: expect.stringMatching(/accepts clients without the access cookie/) });
    expect(existsSync(path.join(root, id, WORKSPACE_LIVE_FILE))).toBe(false);
    // The server that was started for it is ended again: nothing of the attempt is left running.
    await eventually('the refused X server to end', () => marked(id).length === 0);
  });

  it('says which programs are missing', async () => {
    const empty = temp('empty');
    expect(WorkspaceManager.unavailable({ PATH: empty })).toMatch(/^Missing on this computer: Xvfb, dbus-daemon, xprop, .*openbox\. Run apps\/clipboard-agent\/scripts\/install-linux\.sh again\.$/);
    const { m } = manager({}, { baseEnv: { PATH: empty, HOME: temp('home') } });
    await expect(m.use({ id: desktopId() })).rejects.toMatchObject({ code: 'workspace_unavailable', message: expect.stringMatching(/Missing on this computer/) });
  });

  it('takes no name that is not a desktop of a chat', async () => {
    const { m } = manager({}, { baseEnv: { PATH: stubPrograms('dies'), HOME: temp('home') } });
    for (const id of [':0', '../../tmp/x', 'ws_short', `ws_${'A'.repeat(26)}`, '']) {
      await expect(m.use({ id })).rejects.toMatchObject({ code: 'workspace_unavailable', message: 'That is not the name of a desktop.' });
      await expect(m.reset(id, { wipe: true })).rejects.toMatchObject({ code: 'workspace_unavailable' });
    }
  });

  it('takes a program for one a chat opened only when it is still that process and was started for that desktop', async () => {
    const id = desktopId();
    const dir = temp('started');
    const start = (env: NodeJS.ProcessEnv) => {
      const child = spawn('sleep', ['300'], { stdio: 'ignore', env });
      children.push(child);
      return child.pid!;
    };
    const own = start({ ...process.env, POCKET_WORKSPACE_ID: id });
    const stale = start({ ...process.env, POCKET_WORKSPACE_ID: id });
    const bystander = start({ ...process.env });
    const neighbour = start({ ...process.env, POCKET_WORKSPACE_ID: desktopId() });
    await eventually('the programs to be there', () => [own, stale, bystander, neighbour].every((pid) => processStart(pid) !== undefined));
    writeFileSync(
      path.join(dir, 'started'),
      [
        `${own} ${processStart(own)}`,
        // The same line twice is one program.
        `${own} ${processStart(own)}`,
        // A pid that is by now another program: the start time written down is not this one's.
        `${stale} ${Number(processStart(stale)) - 1}`,
        // Alive, and its start time fits, but it was never started for this desktop, or for another one.
        `${bystander} ${processStart(bystander)}`,
        `${neighbour} ${processStart(neighbour)}`,
        // Nothing that is a process, and nothing that is a line of this list.
        '1 1',
        '999999999 5',
        `-${own} ${processStart(own)}`,
        `${own} ${processStart(own)} extra`,
        'not a line',
        '',
      ].join('\n'),
    );
    expect(programsStarted(dir, id)).toEqual([own]);
    expect(programsStarted(temp('empty'), id)).toEqual([]);
  });
});

describe.runIf(realX)('desktops on real X servers', { timeout: 120_000 }, () => {
  it('starts several at once, each with a display, a cookie and a session bus of its own', async () => {
    const [A, B, C] = [desktopId(), desktopId(), desktopId()];
    // The agent itself runs in a person's session; none of that may reach a desktop.
    const person = { ...process.env, DISPLAY: ':0', XAUTHORITY: '/home/person/.Xauthority', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' };
    const { m, root } = manager({}, { baseEnv: person });
    const [a, b, c] = await Promise.all([m.use({ id: A, label: 'chat A' }), m.use({ id: B, label: 'chat B' }), m.use({ id: C })]);
    expect([a.info, b.info, c.info].map((i) => [i.state, i.generation])).toEqual([['running', 1], ['running', 1], ['running', 1]]);
    expect(new Set([a.info.display, b.info.display, c.info.display]).size).toBe(3);
    expect([a.info.display, b.info.display, c.info.display]).not.toContain(':0');

    const lives = [A, B, C].map((id) => liveOf(root, id));
    for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'] as const) expect(new Set(lives.map((l) => l.env[key])).size).toBe(3);
    // Only this user can read the records and cookies.
    for (const file of [root, path.join(root, A), path.join(root, A, WORKSPACE_LIVE_FILE), lives[0]!.env.XAUTHORITY!]) expect(statSync(file).mode & 0o077).toBe(0);

    const first = lives[0]!;
    const server = readFileSync(`/proc/${first.xserver.pid}/cmdline`, 'utf8').split('\0');
    expect(server).toEqual(expect.arrayContaining([first.display, '-nolisten', 'tcp', '-auth', first.env.XAUTHORITY]));
    const refused = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: 6000 + Number(first.display.slice(1)) });
      socket.once('connect', () => (socket.destroy(), resolve('connected')));
      socket.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');

    const env = chatCommandEnvironment(person, first);
    const probe = (extra: Record<string, string>) => spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env: { ...env, ...extra }, encoding: 'utf8' }).status;
    expect(probe({})).toBe(0);
    expect(probe({ XAUTHORITY: '/dev/null' })).not.toBe(0);
    // Another chat's cookie does not open this chat's display.
    expect(probe({ XAUTHORITY: lives[1]!.env.XAUTHORITY! })).not.toBe(0);

    // Every process of the desktop was started without the person's session.
    const own = marked(A);
    expect(own.length).toBeGreaterThanOrEqual(3);
    for (const p of own) {
      expect(p.environ).not.toContain('DISPLAY=:0');
      expect(p.environ.some((v) => v === 'WAYLAND_DISPLAY=wayland-0' || v === 'XAUTHORITY=/home/person/.Xauthority' || v === 'XDG_SESSION_TYPE=wayland')).toBe(false);
    }
  });

  it("keeps clipboards apart, and puts a command's window on its own chat's desktop only", async () => {
    const [A, B] = [desktopId(), desktopId()];
    const { m, root } = manager();
    const [a, b] = await Promise.all([m.use({ id: A }), m.use({ id: B })]);
    expect(await a.clipboard.read()).toEqual([]);
    await a.clipboard.write({ kind: 'text', text: 'clipboard of chat A' });
    await b.clipboard.write({ kind: 'text', text: 'clipboard of chat B' });
    expect(await a.clipboard.read()).toEqual([{ kind: 'text', text: 'clipboard of chat A' }]);
    expect(await b.clipboard.read()).toEqual([{ kind: 'text', text: 'clipboard of chat B' }]);

    openWindow(liveOf(root, A), 'WINDOW-OF-A');
    openWindow(liveOf(root, B), 'WINDOW-OF-B');
    const titles = async (desktop: typeof a) => ((await desktop.computer.act({ action: 'windows' })).windows ?? []).map((w) => w.title);
    await eventually('the windows to appear', async () => (await titles(a)).includes('WINDOW-OF-A') && (await titles(b)).includes('WINDOW-OF-B'));
    expect(await titles(a)).not.toContain('WINDOW-OF-B');
    expect(await titles(b)).not.toContain('WINDOW-OF-A');

    // Pointers are apart too: moving one leaves the other where it was.
    await a.computer.act({ action: 'move', x: 300, y: 200 });
    await b.computer.act({ action: 'move', x: 900, y: 600 });
    expect((await a.computer.act({ action: 'cursor' })).cursor).toEqual({ x: 300, y: 200 });
    expect((await b.computer.act({ action: 'cursor' })).cursor).toEqual({ x: 900, y: 600 });
    const [shotA, shotB] = await Promise.all([a.computer.act({ action: 'screenshot' }), b.computer.act({ action: 'screenshot' })]);
    expect([shotA.image?.width, shotA.image?.height, shotB.image?.width]).toEqual([1280, 800, 1280]);
    expect(shotA.image!.dataBase64).not.toBe(shotB.image!.dataBase64);
    // Looking in is not a step: it does not change what the agent's next screenshot is compared with.
    const peek = await m.capture(A);
    expect(peek.image.width).toBe(1280);
    expect((await a.computer.act({ action: 'screenshot' })).change?.box).toBeUndefined();
  });

  it("does not touch the display, pointer or clipboard of the person's own session", async () => {
    // A stand-in for the person's desktop: an X server of its own with something on its clipboard and its pointer parked.
    const human = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '800x600x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    children.push(human);
    const number = await new Promise<string>((resolve, reject) => {
      human.stdio[3]!.once('data', (d: Buffer) => resolve(d.toString().trim()));
      human.once('exit', () => reject(new Error('the stand-in display did not start')));
    });
    const own: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${number}` };
    delete own.XAUTHORITY;
    const sh = (command: string) => spawnSync('sh', ['-c', command], { env: own, encoding: 'utf8' });
    const holder = spawn('xclip', ['-selection', 'clipboard', '-i'], { env: own, stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(holder);
    holder.stdin!.end("the person's clipboard");
    sh('xdotool mousemove 321 123');
    await eventually('the stand-in clipboard', () => sh('xclip -selection clipboard -o').stdout === "the person's clipboard");

    const id = desktopId();
    const { m } = manager({}, { baseEnv: own });
    const desktop = await m.use({ id });
    expect(desktop.info.display).not.toBe(own.DISPLAY);
    await desktop.clipboard.write({ kind: 'text', text: 'written by the agent' });
    await desktop.computer.act({ action: 'move', x: 700, y: 500 });
    await desktop.computer.act({ action: 'click', x: 640, y: 400, button: 'left', count: 1 });
    await desktop.computer.act({ action: 'type', text: 'typed by the agent' });
    await desktop.computer.act({ action: 'key', keys: 'ctrl+a' });
    await desktop.computer.act({ action: 'screenshot' });

    expect(sh('xclip -selection clipboard -o').stdout).toBe("the person's clipboard");
    expect(sh('xdotool getmouselocation').stdout).toMatch(/^x:321 y:123 /);
    expect(sh('xdotool search --onlyvisible --name "." 2>/dev/null | wc -l').stdout.trim()).toBe('0');
    for (const p of marked(id)) expect(p.environ).not.toContain(`DISPLAY=${own.DISPLAY}`);
  });

  it('refuses steps planned on a desktop that was closed or started again, and leaves the others alone', async () => {
    const [A, B] = [desktopId(), desktopId()];
    const { m, root } = manager();
    const [a, b] = await Promise.all([m.use({ id: A }), m.use({ id: B })]);
    await expect(m.use({ id: A, generation: 99 })).rejects.toMatchObject({ code: 'workspace_stale' });
    expect((await m.use({ id: A, generation: 1 })).info.generation).toBe(1);
    const profile = path.join(root, A, 'profiles', 'kept.txt');
    writeFileSync(profile, 'a saved login');
    const serverOfB = liveOf(root, B).xserver.pid;

    await m.reset(A);
    expect(m.status({ id: A })).toMatchObject({ state: 'stopped', generation: 1 });
    expect(existsSync(path.join(root, A, WORKSPACE_LIVE_FILE))).toBe(false);
    await expect(m.use({ id: A, generation: 1 })).rejects.toMatchObject({ code: 'workspace_stale' });
    // The other chat noticed nothing.
    expect(alive(serverOfB)).toBe(true);
    expect((await b.computer.act({ action: 'cursor' })).cursor).toBeDefined();
    await eventually('the processes of the closed desktop to end', () => marked(A).length === 0);

    const again = await m.use({ id: A });
    expect(again.info).toMatchObject({ state: 'running', generation: 2 });
    expect(liveOf(root, A).generation).toBe(2);
    await expect(m.use({ id: A, generation: 1 })).rejects.toMatchObject({ code: 'workspace_stale' });
    // Closing keeps the browser profile; removing takes it along.
    expect(readFileSync(profile, 'utf8')).toBe('a saved login');
    await m.reset(A, { wipe: true });
    expect(existsSync(path.join(root, A))).toBe(false);
    expect(m.list().map((w) => w.id)).toEqual([B]);
    // Removed, but its name counts on: nothing planned on the removed desktop can fit the one that comes after it,
    // also when PocketClipboard was restarted in between.
    await m.close();
    const next = manager({}, { root }).m;
    expect((await next.use({ id: A })).info).toMatchObject({ state: 'running', generation: 3 });
    await expect(next.use({ id: A, generation: 2 })).rejects.toMatchObject({ code: 'workspace_stale' });
    void a;
  });

  it('closes a desktop whose X server or helper died, without disturbing its neighbour', async () => {
    const [A, B] = [desktopId(), desktopId()];
    const { m, root } = manager();
    const [a, b] = await Promise.all([m.use({ id: A }), m.use({ id: B })]);
    await a.computer.act({ action: 'cursor' });
    await b.computer.act({ action: 'cursor' });

    // The helper of one desktop dies: the next step there starts a new one, on the same desktop.
    const helperOfA = marked(A).find((p) => p.cmdline.includes('computer.py'))!;
    process.kill(helperOfA.pid, 'SIGKILL');
    await eventually('the helper to be gone', () => !alive(helperOfA.pid));
    expect((await b.computer.act({ action: 'cursor' })).cursor).toBeDefined();
    await eventually('a new helper on the same desktop', async () => (await a.computer.act({ action: 'cursor' }).catch(() => undefined))?.cursor !== undefined);
    const replacement = marked(A).find((p) => p.cmdline.includes('computer.py'))!;
    expect(replacement.pid).not.toBe(helperOfA.pid);
    expect(replacement.environ).toContain(`DISPLAY=${a.info.display}`);

    // The X server of one desktop dies: that desktop is over, and says so instead of becoming some other screen.
    process.kill(liveOf(root, A).xserver.pid, 'SIGKILL');
    await eventually('the desktop to be marked as failed', () => m.status({ id: A }).state === 'failed');
    expect(m.status({ id: A }).error).toMatch(/X server stopped/);
    expect(existsSync(path.join(root, A, WORKSPACE_LIVE_FILE))).toBe(false);
    await expect(m.use({ id: A, generation: 1 })).rejects.toMatchObject({ code: 'workspace_stale', message: expect.stringMatching(/not running any more/) });
    expect((await b.computer.act({ action: 'screenshot' })).image?.width).toBe(1280);
    expect((await m.use({ id: B, generation: 1 })).info.state).toBe('running');
    // Asked for anew, the chat gets a fresh desktop with the next generation.
    expect((await m.use({ id: A })).info).toMatchObject({ state: 'running', generation: 2 });
  });

  it('keeps to its limit, makes room for a new chat, and closes what sits unused', async () => {
    const [A, B, C] = [desktopId(), desktopId(), desktopId()];
    let clock = Date.now();
    const { m, root } = manager({ max: 2, evictAfterMs: 60_000, idleMs: 10 * 60_000, retainMs: 60 * 60_000 }, { now: () => clock });
    await m.use({ id: A });
    clock += 1000;
    await m.use({ id: B });
    await expect(m.use({ id: C })).rejects.toMatchObject({ code: 'workspace_limit', message: expect.stringMatching(/already runs 2 chat desktops/) });
    expect(m.list().filter((w) => w.state === 'running').map((w) => w.id).sort()).toEqual([A, B].sort());

    // Once one has sat unused for a while it gives way: the one used least recently, with its files kept.
    clock += 61_000;
    await m.use({ id: B, generation: 1 });
    expect((await m.use({ id: C })).info.state).toBe('running');
    expect(m.status({ id: A }).state).toBe('stopped');
    expect(m.status({ id: B }).state).toBe('running');
    expect(existsSync(path.join(root, A, 'profiles'))).toBe(true);

    // Unused for the idle time: closed. Unused for the retention time: its files go too.
    clock += 11 * 60_000;
    await m.use({ id: C, generation: 1 });
    await m.closeIdle();
    expect([m.status({ id: B }).state, m.status({ id: C }).state]).toEqual(['stopped', 'running']);
    clock += 61 * 60_000;
    await m.use({ id: C, generation: 1 });
    await m.closeIdle();
    expect(m.list().map((w) => w.id)).toEqual([C]);
    expect([existsSync(path.join(root, A)), existsSync(path.join(root, B)), existsSync(path.join(root, C))]).toEqual([false, false, true]);
  });

  it('ends exactly its own processes when it closes', async () => {
    const id = desktopId();
    const bystander = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(bystander);
    const { m, root } = manager();
    const desktop = await m.use({ id });
    await desktop.computer.act({ action: 'cursor' });
    const live = liveOf(root, id);
    const window = openWindow(live, 'CLOSES-WITH-ITS-DESKTOP');
    await eventually('the window', async () => ((await desktop.computer.act({ action: 'windows' })).windows ?? []).some((w) => w.title === 'CLOSES-WITH-ITS-DESKTOP'));
    const own = marked(id).map((p) => p.pid);
    expect(own).toEqual(expect.arrayContaining([live.xserver.pid, ...(live.processes ?? []).map((p) => p.pid)]));

    await m.close();
    await eventually('the processes of the desktop to end', () => own.every((pid) => !alive(pid)) && marked(id).length === 0);
    // Its window was a client of its X server and went with it; a process that was never part of it is untouched.
    await eventually('the window to close', () => window.exitCode !== null || window.signalCode !== null);
    expect(alive(bystander.pid!)).toBe(true);
    expect(existsSync(path.join(root, id, WORKSPACE_LIVE_FILE))).toBe(false);
    expect(m.status({ id })).toMatchObject({ state: 'stopped', generation: 1 });
  });

  it('lets programs finish what they were writing before a desktop closes with its files kept, within a limit', async () => {
    const id = desktopId();
    const { m, root, logs } = manager({ quitMs: 4000 });
    const out = temp('quit');
    // A program that, like a browser, writes down what it holds when its window is closed, and takes a moment for it.
    const program = (title: string, file: string) => {
      const child = spawn('python3', ['-c', `import time, tkinter\nr=tkinter.Tk()\nr.title(${JSON.stringify(title)})\ndef close():\n    time.sleep(0.6); open(${JSON.stringify(file)}, 'w').write('saved'); r.destroy()\nr.protocol('WM_DELETE_WINDOW', close)\nr.mainloop()`], {
        env: chatCommandEnvironment(process.env, liveOf(root, id)),
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    };
    const shows = async (title: string) => {
      const desktop = await m.use({ id });
      await eventually(`the window ${title}`, async () => ((await desktop.computer.act({ action: 'windows' })).windows ?? []).some((w) => w.title === title));
    };

    await m.use({ id });
    const saver = program('SAVES-ON-CLOSE', path.join(out, 'reset'));
    await shows('SAVES-ON-CLOSE');
    await m.reset(id);
    // By the time the desktop is reported closed the program has ended by itself, its work written.
    expect(readFileSync(path.join(out, 'reset'), 'utf8')).toBe('saved');
    expect(saver.exitCode).toBe(0);

    // Deleting removes the files: nothing is asked of the programs and nothing waited for.
    await m.use({ id });
    program('DELETED', path.join(out, 'deleted'));
    await shows('DELETED');
    await m.reset(id, { wipe: true });
    expect(existsSync(path.join(out, 'deleted'))).toBe(false);

    // One that does not close, as an editor asking "save changes?" does not, holds the desktop up for the limit and no longer.
    const { m: brief, root: briefRoot, logs: briefLogs } = manager({ quitMs: 700 });
    await brief.use({ id });
    const stays = spawn('python3', ['-c', `import tkinter\nr=tkinter.Tk()\nr.title('STAYS')\nr.protocol('WM_DELETE_WINDOW', lambda: None)\nr.mainloop()`], { env: chatCommandEnvironment(process.env, liveOf(briefRoot, id)), stdio: 'ignore' });
    children.push(stays);
    const desktop = await brief.use({ id });
    await eventually('the window STAYS', async () => ((await desktop.computer.act({ action: 'windows' })).windows ?? []).some((w) => w.title === 'STAYS'));
    const started = Date.now();
    await brief.reset(id);
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(briefLogs.some((line) => /programs were still open after 1 s/.test(line))).toBe(true);
    expect(logs.some((line) => /still open/.test(line))).toBe(false);
    await eventually('the program that stayed to end with its desktop', () => stays.exitCode !== null || stays.signalCode !== null);
  });

  it('takes the display number of an X server that was killed and left its socket and lock behind', async () => {
    const id = desktopId();
    // Far from the numbers the other tests take, and from anything a machine is likely to run.
    const number = 700 + Math.floor(Math.random() * 200);
    mkdirSync('/tmp/.X11-unix', { recursive: true });
    // What a killed X server leaves: a socket nobody listens on, and a lock naming a process that is gone.
    const holder = spawn('python3', ['-c', `import socket, time\ns = socket.socket(socket.AF_UNIX)\ns.bind('/tmp/.X11-unix/X${number}')\ns.listen(1)\nprint('bound', flush=True)\ntime.sleep(60)`], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(holder);
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    expect(await displayInUse(number)).toBe(true);
    holder.kill('SIGKILL');
    await eventually('the holder of the socket to end', () => holder.exitCode !== null || holder.signalCode !== null);
    writeFileSync(`/tmp/.X${number}-lock`, `${String(holder.pid).padStart(10)}\n`);
    try {
      expect(existsSync(`/tmp/.X11-unix/X${number}`)).toBe(true);
      expect(await displayInUse(number)).toBe(false);

      const { m, root } = manager({ displayBase: number });
      await m.use({ id });
      // Before, the number was passed over for as long as the socket lay there, and the next one was taken.
      expect(liveOf(root, id).display).toBe(`:${number}`);
      expect(await displayInUse(number)).toBe(true);
    } finally {
      // The lock is this test's own: a desktop's X server neither writes one nor clears one.
      rmSync(`/tmp/.X${number}-lock`, { force: true });
    }
  });

  it('says so when the windows of a desktop cannot be listed, and does not take that for an empty desktop', async () => {
    const id = desktopId();
    const dir = temp('xprop');
    const broken = path.join(dir, 'broken');
    // The real xprop until the mark is there; from then on it ends by a signal, as a listing did on a hosted runner.
    writeFileSync(path.join(dir, 'xprop'), `#!/bin/sh\nif [ -e '${broken}' ]; then kill -SEGV $$; fi\nexec xprop "$@"\n`);
    chmodSync(path.join(dir, 'xprop'), 0o755);
    const { m, root, logs } = manager({ quitMs: 4000 }, { commands: { xprop: path.join(dir, 'xprop') } });
    const desktop = await m.use({ id });
    openWindow(liveOf(root, id), 'UNSEEN');
    await eventually('the window UNSEEN', async () => ((await desktop.computer.act({ action: 'windows' })).windows ?? []).some((w) => w.title === 'UNSEEN'));
    writeFileSync(broken, '');
    const started = Date.now();
    await m.reset(id);
    expect(logs.filter((line) => /could not be listed/.test(line))).toEqual([`workspace ${id}: its windows could not be listed (xprop ended by SIGSEGV); its programs are not asked to close and end with the desktop`]);
    // Nothing was waited for, and the desktop closed all the same.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(m.status({ id })).toMatchObject({ state: 'stopped' });
    await eventually('every process of the desktop to end', () => marked(id).length === 0);
  });

  /**
   * A program for the computer tool's `open` step: it shows a window, and writes down that it was asked to close. Like
   * most programs, and unlike Python left to itself, it is ended by writing to a pipe that nobody reads any more.
   */
  const notes = (title: string) => {
    const dir = temp('opened');
    const file = path.join(dir, 'notes.py');
    writeFileSync(
      file,
      `#!/usr/bin/env python3\nimport signal, sys, time, tkinter\nsignal.signal(signal.SIGPIPE, signal.SIG_DFL)\nr = tkinter.Tk()\nr.title(${JSON.stringify(title)})\ndef close():\n    time.sleep(0.6); open(sys.argv[1], 'w').write('saved'); r.destroy()\ndef mutter():\n    sys.stderr.write('a warning\\n'); sys.stderr.flush(); r.after(100, mutter)\nr.protocol('WM_DELETE_WINDOW', close)\nr.after(100, mutter)\nr.mainloop()\n`,
    );
    chmodSync(file, 0o755);
    return { file, saved: path.join(dir, 'saved') };
  };
  const titles = async (desktop: { computer: { act(a: { action: 'windows' }): Promise<{ windows?: { title: string }[] }> } }) => ((await desktop.computer.act({ action: 'windows' })).windows ?? []).map((w) => w.title);

  it('asks a program the chat opened with its computer tool to close as well, before anything ends it', async () => {
    const id = desktopId();
    const { m } = manager({ quitMs: 4000 });
    const program = notes('OPENED-BY-THE-CHAT');
    const desktop = await m.use({ id });
    await desktop.computer.act({ action: 'open', target: program.file, args: program.saved });
    await eventually('the window OPENED-BY-THE-CHAT', async () => (await titles(desktop)).includes('OPENED-BY-THE-CHAT'));
    await m.reset(id);
    // The helper ends what it started when its desktop goes. Before that the program had its moment, like any other.
    expect(readFileSync(program.saved, 'utf8')).toBe('saved');
    await eventually('every process of the desktop to end', () => marked(id).length === 0);
  });

  it('stops a step that is under way without ending what the chat opened on its desktop', async () => {
    const id = desktopId();
    const { m } = manager();
    const program = notes('STAYS-OPEN');
    const desktop = await m.use({ id });
    await desktop.computer.act({ action: 'open', target: program.file, args: program.saved });
    await eventually('the window STAYS-OPEN', async () => (await titles(desktop)).includes('STAYS-OPEN'));
    // Half a minute of typing, stopped after a moment: the person pressed Stop.
    const typing = desktop.computer.act({ action: 'type', text: 'a'.repeat(4000) }).then(() => 'typed all of it', (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 600));
    desktop.computer.release();
    expect(await typing).toMatch(/stopped by the user/i);
    await new Promise((r) => setTimeout(r, 400));
    // The desktop is kept for the next message, and so is what is open on it.
    expect(await titles(desktop)).toContain('STAYS-OPEN');
    expect(existsSync(program.saved)).toBe(false);
  });

  it('ends what the chat opened when its desktop closes, also what an earlier helper started and what is no X client', async () => {
    const id = desktopId();
    const { m } = manager({ quitMs: 500 });
    const program = worker('WORKER');
    const desktop = await m.use({ id });
    await desktop.computer.act({ action: 'open', target: program.file });
    await eventually('the window WORKER', async () => (await titles(desktop)).includes('WORKER'));
    const pid = Number(readFileSync(program.pid, 'utf8'));
    expect(marked(id).map((p) => p.pid)).toContain(pid);
    // The helper that started it is replaced: a step was stopped. The program stays, known to no helper any more.
    const typing = desktop.computer.act({ action: 'type', text: 'a'.repeat(4000) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600));
    desktop.computer.release();
    await typing;
    expect(alive(pid)).toBe(true);

    await m.reset(id);
    // Its window was a client of the X server; the program itself is not, and ended because the desktop ended it.
    expect(alive(pid)).toBe(false);
    await eventually('every process of the desktop to end', () => marked(id).length === 0);
  });
});

describe.runIf(realX)('what a killed agent leaves behind', { timeout: 120_000 }, () => {
  const bundle = path.join(temp('holder'), 'holder.cjs');
  buildSync({ entryPoints: [path.resolve('apps/clipboard-agent/test/fixtures/workspace-holder.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'silent' });

  /** An agent in its own process with one desktop running; resolves with the record of that desktop. */
  async function holder(root: string, id: string, mode: 'orphan' | 'tied', open?: string): Promise<{ child: ChildProcess; live: WorkspaceLive }> {
    const child = spawn(process.execPath, [bundle, root, helper, id, mode, ...(open ? [open] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    const line = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout!.on('data', (d: Buffer) => {
        text += d.toString();
        if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n')));
      });
      child.once('exit', () => reject(new Error('the agent stopped before its desktop was up')));
    });
    return { child, live: workspaceLiveSchema.parse(JSON.parse(line)) };
  }

  it('is ended by the next start, but only what provably was a desktop of that run', async () => {
    const [A, B] = [desktopId(), desktopId()];
    const root = temp('ws');
    // The chat had a program open that is no client of the X server: ending the desktop's X server does not end it.
    const program = worker('LEFT-BEHIND');
    const { child, live } = await holder(root, A, 'orphan', program.file);
    const opened = Number(readFileSync(program.pid, 'utf8'));
    const left = [live.xserver.pid, ...(live.processes ?? []).map((p) => p.pid), opened];
    child.kill('SIGKILL');
    await eventually('the agent to be gone', () => child.exitCode !== null || child.signalCode !== null);
    // Killed outright, and without setpriv to tie them to it, the desktop's processes are still there.
    expect(left.every(alive)).toBe(true);

    // A record that names a process which is no desktop: its pid is alive and even its start time fits.
    const bystander = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(bystander);
    mkdirSync(path.join(root, B), { mode: 0o700 });
    writeFileSync(path.join(root, B, 'meta.json'), JSON.stringify({ id: B, generation: 3, createdAt: Date.now(), lastUsedAt: Date.now() }));
    const forged: WorkspaceLive = { v: 1, id: B, generation: 3, display: ':977', xserver: { pid: bystander.pid!, start: processStart(bystander.pid!)! }, env: {}, path: [], startedAt: Date.now() };
    writeFileSync(path.join(root, B, WORKSPACE_LIVE_FILE), JSON.stringify(forged));

    const { m, logs } = manager({}, { root });
    await eventually('the processes the dead agent left to end', () => left.every((pid) => !alive(pid)));
    expect(alive(bystander.pid!)).toBe(true);
    expect(logs.filter((l) => /left by an earlier run/.test(l)).length).toBeGreaterThanOrEqual(1);
    expect(logs).toContain(`workspace ${A}: ended a program (${opened}) left by an earlier run`);
    expect(logs.some((l) => l.includes(String(bystander.pid)))).toBe(false);
    await eventually('nothing of the old desktop to be left', () => marked(A).length === 0);
    for (const id of [A, B]) expect(existsSync(path.join(root, id, WORKSPACE_LIVE_FILE))).toBe(false);

    // Nothing is taken over: the chats get fresh desktops, and no generation is handed out twice.
    expect(m.status({ id: A })).toMatchObject({ state: 'stopped', generation: 1 });
    expect(m.status({ id: B })).toMatchObject({ state: 'stopped', generation: 3 });
    await expect(m.use({ id: A, generation: 1 })).rejects.toMatchObject({ code: 'workspace_stale' });
    expect((await m.use({ id: A })).info).toMatchObject({ state: 'running', generation: 2 });
  });

  it.runIf(has('setpriv'))('ends with the agent where the kernel can tie it to it', async () => {
    const id = desktopId();
    const { child, live } = await holder(temp('ws'), id, 'tied');
    const own = [live.xserver.pid, ...(live.processes ?? []).map((p) => p.pid)];
    expect(own.every(alive)).toBe(true);
    child.kill('SIGKILL');
    await eventually('the desktop to end with its agent', () => own.every((pid) => !alive(pid)));
  });
});
