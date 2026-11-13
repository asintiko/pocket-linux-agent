import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parsePairingCode, parsePairingUri, serializeIdentity, WORKSPACE_ID_PATTERN, WORKSPACE_LIVE_FILE, workspaceLiveSchema, type PairingCode, type WorkspaceInfo } from '@pocket/protocol';
import { joinAccount, type WebSocketCtor } from '@pocket/transport';
import WebSocket from 'ws';
import { ClipboardAgent, type AgentState } from './agent.js';
import { BACKUP_NAME, restoreGestures } from './blocker/gestures.js';
import { CAMERA_PS_FILE } from './camera.js';
import { CameraHost } from './camera-host.js';
import { DEFAULT_ESCAPE, DEFAULT_PIN, validEscape, validPin } from './blocker/lock.js';
import { BLOCKER_PS_FILE } from './blocker/script.js';
import { BlockerView } from './blocker/view.js';
import { macClipboard, windowsClipboard } from './clipboard.js';
import { COMPUTER_PS, ComputerHost } from './computer.js';
import { linuxClipboard } from './linux/clipboard.js';
import { LINUX_PYTHON, linuxScreen, linuxThroughMsFor } from './linux/computer.js';
import { sameProcess, WorkspaceManager, workspaceRoot } from './linux/workspaces.js';
import { OverlayModel } from './overlay/model.js';
import { OVERLAY_PS_FILE } from './overlay/script.js';
import { OverlayWindow } from './overlay/window.js';
import { windowsScreen } from './screenshot.js';

const WS = WebSocket as unknown as WebSocketCtor;
const DEFAULT_RELAY = 'https://trunks-fineness-grumbling.ngrok-free.dev';
const APP = 'PocketClipboard';
const win = process.platform === 'win32';
const linux = process.platform === 'linux';
const home = win ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), APP) : path.join(os.homedir(), '.pocket-clipboard');
const files = {
  state: path.join(home, 'state.json'),
  log: path.join(home, 'agent.log'),
  exe: path.join(home, `${APP}.exe`),
  vbs: path.join(home, 'start-hidden.vbs'),
  overlay: path.join(home, 'overlay.ps1'),
  computer: path.join(home, 'computer.ps1'),
  blocker: path.join(home, 'blocker.ps1'),
  linuxComputer: path.join(home, 'computer.py'),
  linuxBlocker: path.join(home, 'blocker.py'),
  linuxView: path.join(home, 'workspace-view.py'),
  camera: path.join(home, 'camera.ps1'),
};
const user = (os.userInfo().username || 'user').replace(/[^\w.-]/g, '_');
const pipe = win ? `\\\\.\\pipe\\pocket-clipboard-${user}` : path.join(os.tmpdir(), `pocket-clipboard-${user}.sock`);
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const SERVICE = 'pocket-clipboard.service';
const serviceFile = path.join(os.homedir(), '.config', 'systemd', 'user', SERVICE);

function log(msg: string): void {
  try {
    mkdirSync(home, { recursive: true });
    if (existsSync(files.log) && statSync(files.log).size > 1_000_000) renameSync(files.log, `${files.log}.1`);
    appendFileSync(files.log, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
  if (process.stdout.isTTY) console.log(msg);
}

function loadState(): AgentState | undefined {
  try {
    return JSON.parse(readFileSync(files.state, 'utf8')) as AgentState;
  } catch {
    return undefined;
  }
}

function saveState(state: AgentState): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(`${files.state}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${files.state}.tmp`, files.state);
}

/** Makes the X11 helpers available next to the agent; the installer already places them there. */
function ensureLinuxAssets(): void {
  if (!linux) return;
  mkdirSync(home, { recursive: true });
  const scriptDir = path.dirname(path.resolve(process.argv[1] ?? '.'));
  const roots = [
    path.join(scriptDir, 'linux'),
    path.join(scriptDir, 'src', 'linux'),
    path.join(scriptDir, 'apps', 'clipboard-agent', 'src', 'linux'),
    path.join(process.cwd(), 'apps', 'clipboard-agent', 'src', 'linux'),
  ];
  for (const [name, target] of [['computer.py', files.linuxComputer], ['blocker.py', files.linuxBlocker], ['workspace-view.py', files.linuxView]] as const) {
    const source = roots.map((root) => path.join(root, name)).find((candidate) => existsSync(candidate));
    if (source && path.resolve(source) !== path.resolve(target)) copyFileSync(source, target);
    if (!existsSync(target)) throw new Error(`Missing Linux helper ${name}; run apps/clipboard-agent/scripts/install-linux.sh`);
  }
}

/** The chat overlay exists on Windows only; Linux has computer use and the lock overlay only. */
const overlayWanted = (state: AgentState) => win && state.overlay !== false;

/** The stub lock screen stays resident, unlocked, waiting for Alt+Shift+Space. */
const blockerWanted = (state: AgentState) => (win || linux) && state.blocker === true;

/** Asks the running background copy to do something; resolves undefined if none is running. */
function control(
  cmd: 'quit' | 'status' | 'overlay on' | 'overlay off' | 'blocker on' | 'blocker off' | 'blocker lock' | 'blocker unlock' | 'workspaces' | `workspaces ${'reset' | 'delete'} ${string}`,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = net.createConnection(pipe);
    s.setTimeout(3000, () => {
      s.destroy();
      resolve(undefined);
    });
    let out = '';
    s.on('connect', () => s.write(`${cmd}\n`));
    s.on('data', (d) => (out += d.toString()));
    s.on('end', () => resolve(out.trim()));
    s.on('error', () => resolve(undefined));
  });
}

async function pair(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nPair this computer with the phone.');
    console.log('On the phone: open a chat, tap the phone icon, then "Add a computer". Paste the link it shows (or just the code).\n');
    const pasted = (await rl.question('Link or code from the phone: ')).trim();
    let relay = DEFAULT_RELAY;
    let code: PairingCode;
    if (/^pocketclaude:\/\//i.test(pasted)) {
      const parsed = parsePairingUri(pasted);
      relay = parsed.relayUrl;
      code = parsed.code;
    } else {
      code = parsePairingCode(pasted);
      relay = (await rl.question(`Relay address [${DEFAULT_RELAY}]: `)).trim() || DEFAULT_RELAY;
    }
    const joined = await joinAccount({
      relayUrl: relay,
      code,
      role: 'executor',
      name: os.hostname(),
      WebSocket: WS,
      confirmSafetyNumber: async (n) => !(await rl.question(`Safety number ${n} (the phone shows the same one). Press Enter to continue, or type n to stop: `)).trim().toLowerCase().startsWith('n'),
    });
    saveState({
      relayUrl: relay,
      accountId: joined.reply.accountId,
      brainDeviceId: joined.reply.brainDeviceId,
      brainEncPub: joined.bundle.brainEncPub,
      deviceId: joined.deviceId,
      identity: serializeIdentity(joined.identity),
      replay: {},
    });
    console.log('Paired.');
    return true;
  } catch (e) {
    console.error(`Pairing failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  removeOldExes();
  restoreGestures({ home, log });
  const state = loadState();
  if (!state) {
    log(`not paired; run "${linux ? 'PocketClipboard' : 'PocketClipboard.exe'} pair"`);
    process.exit(1);
  }
  ensureLinuxAssets();
  if (!win) rmSync(pipe, { force: true });
  let agent: ClipboardAgent | undefined;
  let computer: ComputerHost | undefined;
  // Desktops of the chats' own. They do not need the person's display, so they also work where nobody is logged in.
  let workspaces: WorkspaceManager | undefined;
  if (linux && state.workspaces !== false) {
    const missing = WorkspaceManager.unavailable();
    if (missing) log(`per-chat desktops are off: ${missing}`);
    else {
      try {
        workspaces = new WorkspaceManager({ root: workspaceRoot(), helperScript: files.linuxComputer, log });
      } catch (e) {
        log(`per-chat desktops are off: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  let camera: CameraHost | undefined;
  let overlay: { model: OverlayModel; window: OverlayWindow } | undefined;
  let blocker: BlockerView | undefined;
  const startBlocker = () => {
    if (blocker || (!win && !linux)) return;
    if (win) writeFileSync(files.blocker, BLOCKER_PS_FILE);
    const view = new BlockerView({
      script: win ? files.blocker : files.linuxBlocker,
      shell: linux ? LINUX_PYTHON : undefined,
      pin: state.blockerPin || DEFAULT_PIN,
      escape: state.blockerEscape || DEFAULT_ESCAPE,
      log,
      // The owner's own laptop: an unusual escape, not the ordinary Alt+Tab and friends.
      ownerMode: true,
      // Alt+Shift+Space puts the picture up, so the agent starts with the desktop in plain sight.
      locked: false,
      // Killing the window in Task Manager must not uncover the desktop: it comes back, however many times.
      maxCrashes: 1000,
      // A copy of the person's touchpad settings while the picture has them switched off, for a window that dies
      // before it can put them back itself.
      gestureBackup: path.join(home, BACKUP_NAME),
      // The chat overlay is topmost too: left up, it would show Claude's chat over the lock screen.
      onLock: (locked) => (locked ? stopOverlay() : startOverlay()),
    });
    blocker = view;
    view.start();
  };
  const stopBlocker = () => {
    if (!blocker) return;
    blocker.close();
    blocker = undefined;
    if (overlayWanted(state)) startOverlay();
  };
  const startOverlay = () => {
    // A lock screen that is up covers the chat window; an unlocked one leaves the desktop to itself.
    if (overlay || !win || blocker?.locked()) return;
    writeFileSync(files.overlay, OVERLAY_PS_FILE);
    const model = new OverlayModel({ window: (op) => void overlay?.window.send(op), request: (body) => agent?.request(body) }, state.overlayTheme);
    const window = new OverlayWindow({
      script: files.overlay,
      snapshot: () => model.snapshot(),
      log,
      onEvent: (e) => {
        model.windowEvent(e);
        if (e.ev !== 'theme' || e.theme === state.overlayTheme) return;
        state.overlayTheme = e.theme;
        saveState(state);
        model.setTheme(e.theme);
      },
    });
    overlay = { model, window };
    window.start();
    agent?.setOverlay(model);
  };
  const stopOverlay = () => {
    if (!overlay) return;
    agent?.setOverlay(undefined);
    overlay.window.close();
    overlay = undefined;
  };
  const server = net.createServer((s) => {
    s.on('data', (d) => {
      const cmd = d.toString().trim();
      if (cmd === 'status') {
        const desktops = workspaces ? `${workspaces.list().filter((w) => w.state === 'running').length} running` : 'off';
        s.end(`running, paired with account ${state.accountId}, overlay ${overlay ? 'on' : 'off'}, lock screen ${blocker ? (blocker.locked() ? 'on' : 'off (unlocked)') : 'off'}, chat desktops ${desktops}\n`);
      }
      if (cmd === 'workspaces') s.end(`${JSON.stringify(workspaces ? workspaces.describe() : null)}\n`);
      const desktop = /^workspaces (reset|delete) (ws_[a-z2-7]{26})$/.exec(cmd);
      if (desktop) {
        if (!workspaces) s.end('Per-chat desktops are off.\n');
        else {
          void workspaces.reset(desktop[2]!, { wipe: desktop[1] === 'delete', children: true }).then(
            () => s.end(desktop[1] === 'delete' ? 'Closed, and its files are removed.\n' : 'Closed. The chat gets a fresh desktop the next time it needs one.\n'),
            (e: unknown) => s.end(`${e instanceof Error ? e.message : String(e)}\n`),
          );
        }
      }
      if (cmd === 'quit') {
        s.end('bye\n');
        shutdown();
      }
      if (cmd === 'overlay on' || cmd === 'overlay off') {
        state.overlay = cmd === 'overlay on';
        saveState(state);
        if (state.overlay) startOverlay();
        else stopOverlay();
        s.end(`overlay ${overlay ? 'on' : 'off'}\n`);
      }
      if (cmd === 'blocker on' || cmd === 'blocker off') {
        state.blocker = cmd === 'blocker on';
        saveState(state);
        if (state.blocker) startBlocker();
        else stopBlocker();
        s.end(`lock screen ${blocker ? 'on' : 'off'}\n`);
      }
      if (cmd === 'blocker lock') {
        if (!blocker) {
          state.blocker = true;
          saveState(state);
          startBlocker();
        }
        blocker?.lock();
        s.end(`lock screen ${blocker ? 'on' : 'off'}\n`);
      }
      if (cmd === 'blocker unlock') {
        blocker?.release();
        s.end('lock screen off\n');
      }
    });
    s.on('error', () => {});
  });
  server.once('error', () => {
    log('already running');
    process.exit(0);
  });
  server.listen(pipe, () => {
    // Linux shares one X11 helper between pc_screenshot and full computer use; the latter still has its own switch.
    if ((win && state.computer) || linux) {
      if (win) writeFileSync(files.computer, COMPUTER_PS);
      computer = new ComputerHost({
        script: win ? files.computer : files.linuxComputer,
        log,
        blocker: () => blocker,
        shell: linux ? LINUX_PYTHON : undefined,
        throughFor: linux ? linuxThroughMsFor : undefined,
        throughDelayMs: linux ? 250 : undefined,
      });
    }
    if (win && state.camera) {
      writeFileSync(files.camera, CAMERA_PS_FILE);
      camera = new CameraHost({ script: files.camera, log });
    }
    agent = new ClipboardAgent(state, {
      clipboard: win ? windowsClipboard : linux ? linuxClipboard : macClipboard,
      screen: win ? windowsScreen : linux && computer ? linuxScreen(computer) : undefined,
      computer: state.computer ? computer : undefined,
      camera,
      workspaces,
      // Only the owner's own switch says this; desktops that are wanted but could not be set up leave chats with an error.
      hostDesktop: linux && state.workspaces === false,
      WebSocket: WS,
      log,
      onRelayMoved: (url) => {
        state.relayUrl = url;
        saveState(state);
        log(`relay moved to ${url}`);
      },
    });
    if (overlayWanted(state)) startOverlay();
    if (blockerWanted(state)) startBlocker();
    agent.connect();
    log(`started (${process.pid}${overlay ? ', overlay on' : ''}${blocker ? `, lock screen ${blocker.locked() ? 'on' : 'waiting for Alt+Shift+Space'}` : ''}${workspaces ? `, chat desktops on (at most ${workspaces.settings.max})` : ''})`);
  });
  const persist = setInterval(() => {
    if (!agent) return;
    state.replay = agent.replayState();
    saveState(state);
  }, 30_000);
  let stopping = false;
  const shutdown = () => {
    // Asked twice when a switch is changed from the command line: first to quit, then by systemd's SIGTERM as the
    // service is restarted. By then the state on disk holds what the command line wrote, and saving this process's
    // older copy over it lost the switch: `workspaces off` and `computer on` did nothing to a running service.
    if (stopping) return;
    stopping = true;
    clearInterval(persist);
    stopOverlay();
    stopBlocker();
    computer?.close();
    camera?.close();
    if (agent) {
      state.replay = agent.replayState();
      saveState(state);
      agent.close();
    }
    server.close();
    // The chats' desktops end with the agent: their X servers, session buses and everything running in them.
    void Promise.resolve(workspaces?.close())
      .catch(() => undefined)
      .then(() => {
        log('stopped');
        setTimeout(() => process.exit(0), 200);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function startHidden(): void {
  if (win) spawn('wscript.exe', [files.vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else if (linux) spawnSync('systemctl', ['--user', 'restart', SERVICE], { stdio: 'ignore' });
  else spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'run'], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * A running copy keeps its exe locked, but Windows still lets a locked exe be renamed. So the old file is moved
 * aside (removed on the next start) and the new one copied in; running copies are asked to quit first.
 */
async function replaceExe(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      copyFileSync(process.execPath, files.exe);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw e;
      if (i === 1) {
        spawnSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${APP}.exe`, '/FI', `PID ne ${process.pid}`], { stdio: 'ignore', windowsHide: true });
      } else if (i >= 2) {
        renameSync(files.exe, `${files.exe}.old-${Date.now()}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  copyFileSync(process.execPath, files.exe);
}

/** Old executables moved aside by an update; they can be deleted once nothing runs them. */
function removeOldExes(): void {
  try {
    for (const f of readdirSync(home)) if (f.startsWith(`${APP}.exe.old-`)) rmSync(path.join(home, f), { force: true });
  } catch {}
}

const systemdQuote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function installLinux(): Promise<void> {
  const script = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!/\.c?js$/.test(script)) throw new Error('Build the Linux agent first: bash apps/clipboard-agent/scripts/install-linux.sh');
  // The chats' own desktops need no session of the person's. What shows or touches the person's own screen (the lock
  // screen, screenshots of it, computer use on it) does, and only works in an X11 session.
  const ownSession = !!process.env.DISPLAY && (process.env.XDG_SESSION_TYPE ?? 'x11').toLowerCase() !== 'wayland';
  if (!ownSession) {
    console.log('No X11 session here: installing for per-chat desktops only. For the lock screen and your own screen, run this again from a terminal inside an X11 session.');
  }
  ensureLinuxAssets();
  await control('quit');
  mkdirSync(path.dirname(serviceFile), { recursive: true });
  const environment = ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PATH', 'LD_LIBRARY_PATH']
    .filter((name) => process.env[name])
    .map((name) => `Environment=${systemdQuote(`${name}=${process.env[name]}`)}`)
    .join('\n');
  const unit = `[Unit]
Description=PocketClipboard X11 agent
After=graphical-session.target

[Service]
Type=simple
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(script)} run
WorkingDirectory=${home}
Environment=${systemdQuote('PYTHONUNBUFFERED=1')}
${environment}
Restart=on-failure
RestartSec=3
# Stopping the service asks the agent alone to stop. It closes the chats' desktops in order: their programs are
# asked to close before anything ends them. Without this systemd would signal every process of every desktop at
# the same moment, the X servers included, and a browser would be gone before it wrote down what it held.
KillMode=mixed
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
  writeFileSync(serviceFile, unit, { mode: 0o600 });
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  const imported = ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PATH', 'LD_LIBRARY_PATH'].filter((name) => process.env[name]);
  if (imported.length) spawnSync('systemctl', ['--user', 'import-environment', ...imported], { stdio: 'ignore' });
  if (!loadState() && !(await pair())) return;
  const enabled = spawnSync('systemctl', ['--user', 'enable', SERVICE], { encoding: 'utf8' });
  if (enabled.status !== 0) throw new Error(enabled.stderr || enabled.stdout || 'Could not enable the systemd user service');
  // Restart, not start: an agent that was running was asked to quit above and may still be on its way out. Starting
  // a service systemd still counts as running does nothing, and once that agent had gone nothing was running: an
  // installation that was updated stayed stopped until the next login.
  const started = spawnSync('systemctl', ['--user', 'restart', SERVICE], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error(started.stderr || started.stdout || 'Could not start the systemd user service');
  console.log(`Installed ${SERVICE}. The agent starts with this user's session.`);
  const missing = WorkspaceManager.unavailable();
  console.log(missing ? `Per-chat desktops are off: ${missing}` : 'Every chat that works on this computer gets a desktop of its own; see them with: PocketClipboard workspaces');
  console.log('Next, if you want them: PocketClipboard blocker on (the lock screen); PocketClipboard computer on (lets chats use your own desktop too).');
}

async function install(): Promise<void> {
  if (linux) return installLinux();
  if (!win) throw new Error('install is for Windows or Linux');
  mkdirSync(home, { recursive: true });
  await control('quit');
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(files.exe).toLowerCase()) await replaceExe();
  writeFileSync(files.vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${files.exe}"" run", 0, False\r\n`);
  spawnSync('reg', ['add', RUN_KEY, '/v', APP, '/t', 'REG_SZ', '/d', `wscript.exe "${files.vbs}"`, '/f'], { stdio: 'ignore', windowsHide: true });
  console.log(`Installed to ${home} and set to start with Windows.`);
  if (!loadState() && !(await pair())) return;
  startHidden();
  console.log('Running in the background. The phone can now use this clipboard.');
}

async function uninstall(): Promise<void> {
  await control('quit');
  if (win) spawnSync('reg', ['delete', RUN_KEY, '/v', APP, '/f'], { stdio: 'ignore', windowsHide: true });
  if (linux) {
    spawnSync('systemctl', ['--user', 'disable', '--now', SERVICE], { stdio: 'ignore' });
    rmSync(serviceFile, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  }
  rmSync(files.vbs, { force: true });
  rmSync(files.state, { force: true });
  console.log(`Removed autostart and pairing. You can delete ${home}.`);
}

async function pause(): Promise<void> {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\nPress Enter to close.');
  rl.close();
}

const ago = (at: number | undefined): string => {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

/**
 * The chats' desktops, from the computer itself: which exist, and a window to look into one. Looking is read-only and
 * local: the viewer copies pictures of the desktop into an ordinary window on the screen it was started from, takes
 * no input for it, and opens nothing on the network.
 */
async function workspacesCommand(rest: string[]): Promise<void> {
  if (!linux) return console.log('Per-chat desktops exist on Linux only.');
  const [what, name, target] = rest;
  if (what === 'on' || what === 'off') {
    // A running agent saves its state on exit, so it stops before the switch is written and starts again after.
    const wasRunning = (await control('quit')) !== undefined;
    const state = loadState();
    if (!state) return console.log('Not paired.');
    state.workspaces = what === 'on';
    saveState(state);
    if (wasRunning) startHidden();
    const missing = what === 'on' ? WorkspaceManager.unavailable() : null;
    return console.log(what === 'off' ? 'Per-chat desktops off: the ones that were running are closed, their files stay.' : missing ? `Per-chat desktops stay off: ${missing}` : 'Per-chat desktops on: every chat that works here gets a desktop of its own.');
  }
  const raw = await control('workspaces');
  if (raw === undefined) return console.log('The agent is not running.');
  const list = JSON.parse(raw) as (WorkspaceInfo & { dir: string })[] | null;
  if (!list) return console.log('Per-chat desktops are off (PocketClipboard workspaces on).');
  if (!what || what === 'list') {
    if (!list.length) return console.log('No chat has a desktop here yet: one is started when a chat first needs it.');
    for (const w of list.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))) {
      console.log(`${w.id}  ${w.state.padEnd(8)} ${(w.display ?? '').padEnd(5)} gen ${String(w.generation).padEnd(3)} ${ago(w.lastUsedAt).padEnd(11)} ${w.parent ? '(subagent) ' : ''}${w.label ?? ''}`);
    }
    return console.log('\nLook into one: PocketClipboard workspaces view <desktop>   (the id, or the start of it or of its name)');
  }
  if (!['view', 'shot', 'reset', 'delete'].includes(what) || !name) {
    return console.log('Usage: PocketClipboard workspaces [on|off | view <desktop> | shot <desktop> [file.png] | reset <desktop> | delete <desktop>]');
  }
  const needle = name.toLowerCase();
  const matches = list.filter((w) => w.id === needle || w.id.startsWith(needle) || w.id.slice(3).startsWith(needle) || (w.label ?? '').toLowerCase().startsWith(needle));
  if (matches.length !== 1) return console.log(matches.length ? `"${name}" fits ${matches.length} desktops; use more of the id.` : `No desktop fits "${name}".`);
  const w = matches[0]!;
  if (what === 'reset' || what === 'delete') return console.log((await control(`workspaces ${what} ${w.id}`)) ?? 'The agent is not running.');
  // Read from the desktop's own record, which only this user can open, and only while its X server is the one that wrote it.
  let live;
  try {
    live = workspaceLiveSchema.parse(JSON.parse(readFileSync(path.join(w.dir, WORKSPACE_LIVE_FILE), 'utf8')));
  } catch {
    return console.log('That desktop is not running right now; it starts when its chat next uses it.');
  }
  if (!WORKSPACE_ID_PATTERN.test(live.id) || live.id !== w.id || !sameProcess(live.xserver)) return console.log('That desktop is not running right now.');
  const cookie = live.env.XAUTHORITY ? readFileSync(live.env.XAUTHORITY) : Buffer.alloc(0);
  if (what === 'shot') {
    const out = path.resolve(target ?? `pocket-desktop-${w.id.slice(3, 9)}.png`);
    const done = spawnSync(LINUX_PYTHON.command, [files.linuxView, '--source', live.display, '--once', out], { env: { ...process.env, XAUTHORITY: live.env.XAUTHORITY ?? '' }, encoding: 'utf8' });
    return console.log(done.status === 0 ? `Saved ${out}` : `Could not take the picture: ${(done.stderr || done.stdout || '').trim().split('\n').pop() ?? 'no reply'}`);
  }
  if (!process.env.DISPLAY) return console.log('There is no screen here to show it on; save a picture instead: PocketClipboard workspaces shot <desktop>');
  // One process draws on this screen and reads the desktop's, so it needs both cookies: this session's first.
  let own = Buffer.alloc(0);
  try {
    own = readFileSync(process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority'));
  } catch {}
  const merged = path.join(w.dir, 'viewer.Xauthority');
  writeFileSync(merged, Buffer.concat([own, cookie]), { mode: 0o600 });
  console.log(`Showing "${w.label ?? w.id}" (${live.display}) in a window. You are only looking: nothing you do there reaches the desktop. Close the window to stop.`);
  spawnSync(LINUX_PYTHON.command, [files.linuxView, '--source', live.display, '--title', `Pocket desktop: ${w.label ?? w.id.slice(3, 9)} (view only)`], { env: { ...process.env, XAUTHORITY: merged }, stdio: 'inherit' });
  rmSync(merged, { force: true });
}

/** In a single executable argv[1] repeats the executable path; under plain node it is the script. */
function args(): string[] {
  const rest = process.argv.slice(1);
  if (rest[0] && (path.resolve(rest[0]) === path.resolve(process.execPath) || /\.(c?js|ts)$/.test(rest[0]))) rest.shift();
  return rest;
}

async function main(): Promise<void> {
  const [cmd] = args();
  switch (cmd ?? (process.stdin.isTTY ? 'install' : 'run')) {
    case 'run':
      return run();
    case 'pair': {
      // A running agent saves its state on exit, so it has to be gone before the new pairing is written.
      const wasRunning = (await control('quit')) !== undefined;
      if ((await pair()) || wasRunning) startHidden();
      return pause();
    }
    case 'install':
      await install().catch((e: unknown) => console.error(e instanceof Error ? e.message : String(e)));
      return pause();
    case 'uninstall':
      return uninstall();
    case 'stop':
      console.log((await control('quit')) ? 'Stopped.' : 'Not running.');
      return;
    case 'status':
      console.log((await control('status')) ?? (loadState() ? 'Paired, not running.' : 'Not paired.'));
      return;
    case 'overlay': {
      const on = args()[1];
      const state = loadState();
      if (on !== 'on' && on !== 'off') return console.log('Usage: PocketClipboard.exe overlay on|off');
      if (!state) return console.log('Not paired.');
      state.overlay = on === 'on';
      saveState(state);
      const applied = await control(`overlay ${on}`);
      console.log(`Overlay ${on}.${applied ? '' : ' Applies when the agent starts.'}`);
      return;
    }
    case 'blocker': {
      const what = args()[1];
      const state = loadState();
      if (!state) return console.log('Not paired.');
      if (what === 'lock' || what === 'unlock') {
        const applied = await control(`blocker ${what}`);
        if (!applied && what === 'lock') {
          // Not running: the picture comes up as soon as the agent does.
          state.blocker = true;
          saveState(state);
          return console.log('The agent is not running; the lock screen comes up when it starts.');
        }
        return console.log(applied ? `Lock screen ${what === 'lock' ? 'on' : 'off'}.` : 'The agent is not running.');
      }
      if (what !== 'on' && what !== 'off' && what !== 'pass' && what !== 'word') {
        return console.log('Usage: PocketClipboard.exe blocker on|off | blocker lock|unlock | blocker pass <4-12 digits> | blocker word <letters>');
      }
      if (what === 'word') {
        const word = (args()[2] ?? '').toLowerCase();
        if (!validEscape(word)) return console.log('The escape word is 3 to 24 Latin letters.');
        state.blockerEscape = word;
        saveState(state);
        const wasRunning = (await control('quit')) !== undefined;
        if (wasRunning) startHidden();
        return console.log(`Escape word is now "${word}": type it at the lock screen and press Enter. Nothing shows on screen.`);
      }
      if (what === 'pass') {
        const pin = args()[2] ?? '';
        if (!validPin(pin)) return console.log('The password is 4 to 12 digits.');
        state.blockerPin = pin;
        saveState(state);
        // The window reads the password once, at start: the agent restarts and the lock screen comes up locked again.
        const wasRunning = (await control('quit')) !== undefined;
        if (wasRunning) startHidden();
        return console.log(`Password changed to ${pin}. The lock screen is locked again with it.`);
      }
      // The running agent applies the switch itself, so its shutdown cannot overwrite the new value.
      state.blocker = what === 'on';
      saveState(state);
      const applied = await control(`blocker ${what}`);
      if (applied === undefined) startHidden();
      console.log(what === 'on'
        ? 'Lock screen ready: Alt+Shift+Space or Ctrl+Alt+Space covers the desktop with the picture, the password lifts it.'
        : 'Lock screen gone: nothing left on this computer.');
      return;
    }
    case 'camera': {
      const on = args()[1];
      if (on === 'test') {
        // What the phone would see, without the phone: one frame, written next to the agent's files, and whatever
        // the camera said if it refused.
        mkdirSync(home, { recursive: true });
        writeFileSync(files.camera, CAMERA_PS_FILE);
        const host = new CameraHost({ script: files.camera, log: (m) => console.log(m) });
        try {
          const image = await host.capture(1280);
          const out = path.join(home, 'camera-test.jpg');
          writeFileSync(out, Buffer.from(image.dataBase64, 'base64'));
          return console.log(`The camera works: ${image.width}x${image.height}, ${Math.round(image.dataBase64.length / 1024)} KB, saved to ${out}`);
        } catch (e) {
          return console.log(`The camera did not take a frame: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          host.close();
        }
      }
      if (on !== 'on' && on !== 'off') return console.log('Usage: PocketClipboard.exe camera on|off | camera test');
      // A running agent saves its state on exit, so it stops before the switch is written and starts again after.
      const wasRunning = (await control('quit')) !== undefined;
      const state = loadState();
      if (!state) return console.log('Not paired.');
      state.camera = on === 'on';
      saveState(state);
      if (wasRunning) startHidden();
      console.log(on === 'on'
        ? 'Camera on: Claude and the phone may look through this computer\'s webcam one frame at a time.'
        : 'Camera off.');
      return;
    }
    case 'workspaces':
      return workspacesCommand(args().slice(1));
    case 'computer': {
      const on = args()[1];
      if (on !== 'on' && on !== 'off') return console.log('Usage: PocketClipboard.exe computer on|off');
      // A running agent saves its state on exit, so it stops before the switch is written and starts again after.
      const wasRunning = (await control('quit')) !== undefined;
      const state = loadState();
      if (!state) return console.log('Not paired.');
      state.computer = on === 'on';
      saveState(state);
      if (wasRunning) startHidden();
      console.log(on === 'on' ? 'Computer use on: Claude may use the mouse, keyboard and windows here after you allow it on the phone.' : 'Computer use off.');
      return;
    }
    default:
      console.log('Usage: PocketClipboard.exe [install | pair | run | status | stop | uninstall | overlay on|off | blocker on|off | blocker lock|unlock | blocker pass <digits> | blocker word <letters> | camera on|off | camera test | computer on|off | workspaces [on|off | view <desktop> | shot <desktop> [file] | reset <desktop> | delete <desktop>]]');
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
