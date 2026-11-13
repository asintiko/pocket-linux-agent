import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_WAYLAND, WORKSPACE_HOST_FILE, WORKSPACE_LIVE_FILE, type InnerMessage, type InnerMessageBody, type ToolContext as CallContext, type WorkspaceLive } from '@pocket/protocol';
import { ToolDispatcher } from '../src/dispatch.js';
import { createPathGuard } from '../src/path-guard.js';
import { backgroundJobs, killAllBackground, tools, type ToolContext } from '../src/tools/index.js';
import { callPlacement, commandEnvironment, readWorkspaceHost, resolveWorkspace, WorkspaceEnvError } from '../src/workspace-env.js';

const linux = process.platform === 'linux';
const A = `ws_${'a'.repeat(26)}`;
const B = `ws_${'b'.repeat(26)}`;
const CHILD = `ws_${'c'.repeat(26)}`;
const SCOPE_A = 'job_aaaaaaaaaaaaaaaaaaaaaaaa';
const SCOPE_B = 'job_bbbbbbbbbbbbbbbbbbbbbbbb';
const BRAIN = 'brain-1';

/** When a process started, as the kernel counts it; what a desktop's record holds next to the pid of its X server. */
const startOf = (pid: number): string => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
};

let home: string;
let registry: string;
let project: string;

/** The record PocketClipboard keeps of a running desktop; this process stands in for its X server. */
function desktop(id: string, generation: number, over: Partial<WorkspaceLive> = {}): WorkspaceLive {
  const dir = path.join(registry, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const live: WorkspaceLive = {
    v: 1,
    id,
    generation,
    display: `:${100 + generation}`,
    xserver: { pid: process.pid, start: startOf(process.pid) },
    env: { DISPLAY: `:${100 + generation}`, XAUTHORITY: path.join(dir, 'Xauthority'), DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/1000/pocket-ws/${id}/bus`, POCKET_WORKSPACE_ID: id },
    path: [path.join(dir, 'bin')],
    startedAt: 1,
    ...over,
  };
  fs.writeFileSync(path.join(dir, WORKSPACE_LIVE_FILE), JSON.stringify(live), { mode: 0o600 });
  return live;
}

const refusal = (run: () => unknown): WorkspaceEnvError => {
  try {
    run();
  } catch (e) {
    if (e instanceof WorkspaceEnvError) return e;
    throw e;
  }
  throw new Error('was not refused');
};

/** The person's own session, as the extension host has it in its environment. */
const PERSON = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/u', DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };

/** A call's context as the extension builds it: the paths it may touch, and where the brain placed the call. */
function ctx(call?: CallContext): ToolContext {
  return { guard: createPathGuard([project]), roots: [project], signal: new AbortController().signal, onOutput: () => {}, platform: process.platform, ...callPlacement(call, PERSON, registry) };
}

const SHOW = 'echo "display=$DISPLAY cookie=$XAUTHORITY wayland=$WAYLAND_DISPLAY bus=$DBUS_SESSION_BUS_ADDRESS desktop=$POCKET_WORKSPACE_ID session=$XDG_SESSION_TYPE"';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-env-')));
  registry = path.join(home, '.pocket-clipboard', 'workspaces');
  fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
  project = path.join(home, 'project');
  fs.mkdirSync(project);
});

afterEach(() => {
  killAllBackground();
  fs.rmSync(home, { recursive: true, force: true });
});

describe.runIf(linux)("finding a chat's desktop on this computer", () => {
  it('takes the display from the record of the running desktop, never from the call', () => {
    const live = desktop(A, 2);
    expect(resolveWorkspace({ id: A, generation: 2 }, registry)).toEqual(live);
    const env = commandEnvironment({ id: A, generation: 2 }, PERSON, registry)!;
    expect(env).toMatchObject({ DISPLAY: ':102', XAUTHORITY: live.env.XAUTHORITY, DBUS_SESSION_BUS_ADDRESS: live.env.DBUS_SESSION_BUS_ADDRESS, POCKET_WORKSPACE_ID: A, WAYLAND_DISPLAY: NO_WAYLAND, GDK_BACKEND: 'x11', HOME: '/home/u' });
    expect(env.PATH).toBe(`${live.path[0]}:${PERSON.PATH}`);
    expect(env.XDG_SESSION_TYPE).toBeUndefined();
  });

  it('gives a command without a desktop no display at all', () => {
    const env = commandEnvironment(undefined, PERSON, registry)!;
    for (const name of ['DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE']) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({ WAYLAND_DISPLAY: NO_WAYLAND, GDK_BACKEND: 'x11', QT_QPA_PLATFORM: 'xcb', HOME: '/home/u', PATH: PERSON.PATH });
  });

  it('refuses a desktop that is not running here instead of using another screen', () => {
    const missing = refusal(() => commandEnvironment({ id: A, generation: 1 }, PERSON, registry));
    expect(missing).toMatchObject({ code: 'workspace_unavailable', message: expect.stringMatching(/^\[workspace_unavailable\] .*not running on this computer.* The command was not run\.$/) });

    desktop(A, 3);
    const stale = refusal(() => resolveWorkspace({ id: A, generation: 2 }, registry));
    expect(stale).toMatchObject({ code: 'workspace_stale', message: expect.stringMatching(/^\[workspace_stale\] .*generation 3, the command was meant for 2/) });

    // The X server the record names is gone (here: a pid whose start time is another one).
    desktop(B, 1, { xserver: { pid: process.pid, start: '1' } });
    expect(refusal(() => resolveWorkspace({ id: B, generation: 1 }, registry))).toMatchObject({ code: 'workspace_unavailable', message: expect.stringMatching(/has stopped/) });
  });

  it('believes only records that nobody else could have written', () => {
    desktop(A, 1);
    expect(resolveWorkspace({ id: A, generation: 1 }, registry).display).toBe(':101');
    fs.chmodSync(path.join(registry, A, WORKSPACE_LIVE_FILE), 0o666);
    expect(refusal(() => resolveWorkspace({ id: A, generation: 1 }, registry)).code).toBe('workspace_unavailable');
    fs.chmodSync(path.join(registry, A, WORKSPACE_LIVE_FILE), 0o600);
    fs.chmodSync(path.join(registry, A), 0o777);
    expect(refusal(() => resolveWorkspace({ id: A, generation: 1 }, registry)).code).toBe('workspace_unavailable');
    fs.chmodSync(path.join(registry, A), 0o700);
    fs.chmodSync(registry, 0o770);
    expect(refusal(() => resolveWorkspace({ id: A, generation: 1 }, registry)).code).toBe('workspace_unavailable');
    fs.chmodSync(registry, 0o700);
    expect(resolveWorkspace({ id: A, generation: 1 }, registry).display).toBe(':101');

    // A folder that is a link to somewhere else, a record of another desktop, and names that are not desktops.
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.writeFileSync(path.join(elsewhere, WORKSPACE_LIVE_FILE), JSON.stringify({ ...desktop(CHILD, 1), id: B }), { mode: 0o600 });
    fs.symlinkSync(elsewhere, path.join(registry, B));
    expect(refusal(() => resolveWorkspace({ id: B, generation: 1 }, registry)).code).toBe('workspace_unavailable');
    fs.writeFileSync(path.join(registry, CHILD, WORKSPACE_LIVE_FILE), JSON.stringify({ ...desktop(CHILD, 1), id: A }), { mode: 0o600 });
    expect(refusal(() => resolveWorkspace({ id: CHILD, generation: 1 }, registry)).message).toMatch(/belongs to another one/);
    for (const id of ['../elsewhere', ':0', '/tmp', 'ws_short']) {
      expect(refusal(() => resolveWorkspace({ id, generation: 1 }, registry)).message).toMatch(/not the name of a desktop/);
    }
  });

  it('reads the name of this login only from a file that is its own', () => {
    expect(readWorkspaceHost(registry)).toBeUndefined();
    fs.writeFileSync(path.join(registry, WORKSPACE_HOST_FILE), `${'ab12'.repeat(8)}\n`, { mode: 0o600 });
    expect(readWorkspaceHost(registry)).toBe('ab12'.repeat(8));
    fs.chmodSync(path.join(registry, WORKSPACE_HOST_FILE), 0o664);
    expect(readWorkspaceHost(registry)).toBeUndefined();
    fs.chmodSync(path.join(registry, WORKSPACE_HOST_FILE), 0o600);
    fs.writeFileSync(path.join(registry, WORKSPACE_HOST_FILE), 'not a name', { mode: 0o600 });
    expect(readWorkspaceHost(registry)).toBeUndefined();
  });
});

describe.runIf(linux)("a chat's commands and background jobs", () => {
  it('run with the environment of the desktop the call names', async () => {
    const live = desktop(A, 4);
    desktop(B, 1);
    const inA = await tools.run_command({ command: SHOW }, ctx({ scope: SCOPE_A, workspace: { id: A, generation: 4 } }));
    expect(inA.content).toContain(`display=:104 cookie=${live.env.XAUTHORITY} wayland=${NO_WAYLAND} bus=${live.env.DBUS_SESSION_BUS_ADDRESS} desktop=${A} session=`);
    const inB = await tools.run_command({ command: SHOW }, ctx({ scope: SCOPE_B, workspace: { id: B, generation: 1 } }));
    expect(inB.content).toContain(`display=:101 `);
    expect(inB.content).toContain(`desktop=${B} `);
    // No desktop named: the person's display, cookie and session are gone from the command's environment.
    const none = await tools.run_command({ command: SHOW }, ctx({ scope: SCOPE_A }));
    expect(none.content).toContain(`display= cookie= wayland=${NO_WAYLAND} bus=${PERSON.DBUS_SESSION_BUS_ADDRESS} desktop= session=`);
    expect(none.content).not.toContain(':0');
    // Other tools get it too: git must not pop up a graphical prompt on the person's screen either.
    expect(ctx({ scope: SCOPE_A }).env?.DISPLAY).toBeUndefined();
  });

  it('belong to the chat that started them', async () => {
    desktop(A, 1);
    const a = ctx({ scope: SCOPE_A, workspace: { id: A, generation: 1 } });
    const b = ctx({ scope: SCOPE_B });
    const started = await tools.run_command({ command: `${SHOW}; sleep 30`, background: true }, a);
    const id = /id (bg\d+)/.exec(started.content)![1]!;
    const mine = await tools.command_output({ id, wait_ms: 3000 }, a);
    expect(mine.content).toContain(`display=:101 `);
    expect(mine.content).toContain('still running');

    // For another chat that job does not exist: it can neither read nor stop it.
    for (const tool of ['command_output', 'command_kill'] as const) {
      const other = await tools[tool]({ id }, b);
      expect(other).toMatchObject({ isError: true, content: expect.stringContaining(`No background command with id ${id}`) });
    }
    expect(backgroundJobs(SCOPE_B)).toEqual([]);
    expect(backgroundJobs(SCOPE_A)).toEqual([{ id, command: `${SHOW}; sleep 30`, scope: SCOPE_A, workspace: A, running: true }]);
    expect((await tools.command_kill({ id }, a)).content).toBe(`Stopping ${id}`);
  });
});

describe.runIf(linux)('stopping what a chat has going', () => {
  const msg = (body: InnerMessageBody): InnerMessage => ({ ts: 0, counter: 1, ...body });
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function setup() {
    const sent: InnerMessageBody[] = [];
    const d = new ToolDispatcher({
      brainDeviceId: BRAIN,
      send: (b) => sent.push(b),
      // What the extension does: the call's programs get the environment of the desktop the brain names, or the call fails unrun.
      createContext: (signal, onOutput, _root, context) => ({ ...ctx(context), signal, onOutput }),
    });
    const call = (callId: string, args: unknown, context?: CallContext, name = 'run_command') =>
      d.handle({ from: BRAIN, message: msg({ type: 'tool.call', payload: { callId, name, args, ...(context ? { context } : {}) } }) });
    const results = () => sent.flatMap((b) => (b.type === 'tool.result' ? [b.payload] : []));
    return { d, sent, call, results };
  }

  it("ends one chat's calls and jobs, or only those in one desktop, and nobody else's", async () => {
    desktop(A, 1);
    desktop(CHILD, 1);
    const { d, call, results } = setup();
    call('main', { command: 'sleep 30' }, { scope: SCOPE_A, workspace: { id: A, generation: 1 } });
    call('child', { command: 'sleep 30' }, { scope: SCOPE_A, workspace: { id: CHILD, generation: 1 } });
    call('other', { command: 'sleep 30' }, { scope: SCOPE_B });
    for (const [scope, workspace] of [[SCOPE_A, A], [SCOPE_A, CHILD], [SCOPE_B, undefined]] as const) {
      await tools.run_command({ command: 'sleep 30', background: true }, ctx({ scope, ...(workspace ? { workspace: { id: workspace, generation: 1 } } : {}) }));
    }
    await tick(150);
    expect(results()).toEqual([]);
    const running = () => backgroundJobs().filter((j) => j.running).map((j) => [j.scope, j.workspace]);
    expect(running()).toEqual([[SCOPE_A, A], [SCOPE_A, CHILD], [SCOPE_B, undefined]]);

    // A subagent ended, or its desktop was closed: only what ran in that desktop stops.
    d.handle({ from: BRAIN, message: msg({ type: 'jobs.kill', payload: { scope: SCOPE_A, workspace: CHILD } }) });
    await tick(300);
    expect(results().map((r) => r.callId)).toEqual(['child']);
    expect(running()).toEqual([[SCOPE_A, A], [SCOPE_B, undefined]]);

    // Somebody who is not the brain has no say.
    d.handle({ from: 'intruder', message: msg({ type: 'jobs.kill', payload: { scope: SCOPE_B } }) });
    await tick(100);
    expect(running()).toEqual([[SCOPE_A, A], [SCOPE_B, undefined]]);

    // The chat was deleted: everything of it stops, the other chat goes on.
    d.handle({ from: BRAIN, message: msg({ type: 'jobs.kill', payload: { scope: SCOPE_A } }) });
    await tick(300);
    expect(results().map((r) => r.callId)).toEqual(['child', 'main']);
    expect(running()).toEqual([[SCOPE_B, undefined]]);
    d.killAll();
    await tick(200);
    expect(results().map((r) => r.callId)).toEqual(['child', 'main', 'other']);
  });

  it('does not run a call whose desktop is not there', async () => {
    const { call, results } = setup();
    const marker = path.join(project, 'ran.txt');
    call('c1', { command: `touch ${marker}` }, { scope: SCOPE_A, workspace: { id: A, generation: 1 } });
    await tick(200);
    expect(results()).toEqual([{ callId: 'c1', content: expect.stringMatching(/^\[workspace_unavailable\] .*The command was not run\.$/), isError: true }]);
    expect(fs.existsSync(marker)).toBe(false);

    desktop(A, 2);
    call('c2', { command: `touch ${marker}` }, { scope: SCOPE_A, workspace: { id: A, generation: 1 } });
    await tick(200);
    expect(results()[1]).toMatchObject({ callId: 'c2', isError: true, content: expect.stringMatching(/^\[workspace_stale\]/) });
    expect(fs.existsSync(marker)).toBe(false);

    call('c3', { command: `touch ${marker}` }, { scope: SCOPE_A, workspace: { id: A, generation: 2 } });
    await tick(300);
    expect(results()[2]).toMatchObject({ callId: 'c3', isError: false });
    expect(fs.existsSync(marker)).toBe(true);
  });
});
