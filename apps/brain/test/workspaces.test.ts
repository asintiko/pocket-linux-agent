import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InnerMessage, InnerMessageBody, PairingCode, PayloadOf, ScreenImage, SessionEvent, WorkspaceBinding, WorkspaceErrorCode, WorkspaceInfo } from '@pocket/protocol';
import type { ComputerTarget } from '../src/computer-tools.js';
import type { ExecutorHandle } from '../src/executor.js';
import type { PcHandle } from '../src/pc-tools.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const home = mkdtempSync(join(tmpdir(), 'pocket-desktops-'));
process.env.POCKET_HOME = home;
process.env.POCKET_LOG_DIR = join(home, 'logs');
process.env.POCKET_NO_KEYCHAIN = '1';
process.env.POCKET_WORKSPACE = join(home, 'workspace');
process.env.POCKET_PEOPLE = join(home, 'people');

const { generateIdentity, innerMessageBodySchema, parsePairingCode, parsePairingUri, PEER_FEATURES, WORKSPACE_ID_PATTERN } = await import('@pocket/protocol');
const { DeviceLink, joinAccount } = await import('@pocket/transport');
const { startNodeRelay } = await import('../../relay/src/node-server.js');
const { Brain } = await import('../src/daemon.js');
const { computerTools, ComputerState } = await import('../src/computer-tools.js');
const { ensureDirs, OWNER_ID, paths } = await import('../src/store.js');
const { jobScope, workspaceId } = await import('../src/workspaces.js');

type Relay = Awaited<ReturnType<typeof startNodeRelay>>;
type Link = InstanceType<typeof DeviceLink>;

let relay: Relay;
let brain: InstanceType<typeof Brain>;
const links: Link[] = [];

const until = <T>(what: string, fn: (resolve: (v: T) => void) => void, ms = 10_000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms);
    fn((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });

const eventually = async (what: string, check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The brain publishes a code over its WebSocket; under load the HTTP lookup can get to the relay first. */
async function joinWhenPublished(opts: Parameters<typeof joinAccount>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await joinAccount(opts);
    } catch (e) {
      if (attempt >= 20 || !/not found/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function connect(code: PairingCode, role: 'executor' | 'client', name: string, userName?: string) {
  const joined = await joinWhenPublished({ relayUrl: relay.url, code, role, name, userName });
  const link = new DeviceLink({
    relayUrl: relay.url,
    accountId: joined.bundle.accountId,
    deviceId: joined.deviceId,
    role,
    identity: joined.identity,
    peers: { [joined.bundle.brainDeviceId]: joined.bundle.brainEncPub },
  });
  links.push(link);
  const inbox: InnerMessage[] = [];
  const waiters: { match: (m: InnerMessage) => boolean; resolve: (m: InnerMessage) => void }[] = [];
  const handlers: ((m: InnerMessage) => void)[] = [];
  link.on('message', ({ message }) => {
    inbox.push(message);
    for (const handler of handlers) handler(message);
    for (const w of waiters.splice(0)) {
      if (w.match(message)) w.resolve(message);
      else waiters.push(w);
    }
  });
  const ready = until<void>(`${name} ready`, (ok) => link.on('ready', () => ok()));
  link.connect();
  await ready;
  const brainId = joined.bundle.brainDeviceId;
  const next = <T extends InnerMessage['type']>(type: T, after = 0, test: (m: Extract<InnerMessage, { type: T }>) => boolean = () => true) =>
    until<Extract<InnerMessage, { type: T }>>(`${name} ← ${type}`, (resolve) => {
      const matches = (m: InnerMessage) => m.type === type && test(m as Extract<InnerMessage, { type: T }>);
      const hit = inbox.slice(after).find(matches);
      if (hit) resolve(hit as Extract<InnerMessage, { type: T }>);
      else waiters.push({ match: matches, resolve: (m) => resolve(m as Extract<InnerMessage, { type: T }>) });
    });
  return {
    deviceId: joined.deviceId,
    send: (body: InnerMessageBody) => link.send(brainId, body),
    inbox,
    next,
    onMessage: (handler: (m: InnerMessage) => void) => void handlers.push(handler),
    /** Everything of one type that arrived after `after` (an inbox index). */
    got: <T extends InnerMessage['type']>(type: T, after = 0) => inbox.slice(after).filter((m): m is Extract<InnerMessage, { type: T }> => m.type === type),
    ask: <T extends InnerMessage['type']>(body: InnerMessageBody, type: T) => {
      const mark = inbox.length;
      link.send(brainId, body);
      return next(type, mark);
    },
  };
}

type Device = Awaited<ReturnType<typeof connect>>;

const PICTURE: ScreenImage = { mime: 'image/jpeg', dataBase64: 'AAAA', width: 1280, height: 800 };
const HOST_A = 'a'.repeat(32);

/** Answers like PocketClipboard on Linux with per-chat desktops: enough of it to see what the brain asks of it. */
function fakeDesktops(device: Device) {
  const running = new Map<string, number>();
  const starts = new Map<string, number>();
  const parents = new Map<string, string>();
  let ensureFails: string | undefined;
  let closingMs = 0;
  const info = (b: WorkspaceBinding): WorkspaceInfo => {
    const generation = running.get(b.id);
    return {
      id: b.id,
      generation: generation ?? starts.get(b.id) ?? 0,
      state: generation ? 'running' : 'stopped',
      ...(generation ? { display: ':101', width: 1280, height: 800 } : {}),
      ...(b.label ? { label: b.label } : {}),
      ...(b.parent ? { parent: b.parent } : {}),
    };
  };
  const use = (b: WorkspaceBinding): { workspace: WorkspaceInfo } | { error: string; code: WorkspaceErrorCode } => {
    if (b.parent) parents.set(b.id, b.parent);
    if (b.generation !== undefined) {
      return running.get(b.id) === b.generation ? { workspace: info(b) } : { error: 'This desktop was started again since the last screenshot.', code: 'workspace_stale' };
    }
    if (!running.has(b.id)) {
      if (ensureFails) return { error: ensureFails, code: 'workspace_unavailable' };
      const generation = (starts.get(b.id) ?? 0) + 1;
      starts.set(b.id, generation);
      running.set(b.id, generation);
    }
    return { workspace: info(b) };
  };
  device.onMessage((m) => {
    switch (m.type) {
      case 'workspace.control': {
        const { requestId, op, workspace, children } = m.payload;
        if (!workspace) return void device.send({ type: 'workspace.state', payload: { requestId, workspaces: [] } });
        if (op === 'ensure') return void device.send({ type: 'workspace.state', payload: { requestId, ...use(workspace) } });
        if (op === 'capture') {
          const shown = running.has(workspace.id) ? { workspace: info(workspace), image: PICTURE } : { error: 'This desktop is not running right now.', code: 'workspace_unavailable' as const };
          return void device.send({ type: 'workspace.state', payload: { requestId, ...shown } });
        }
        if (op === 'reset' || op === 'delete') {
          running.delete(workspace.id);
          if (children) for (const [child, parent] of parents) if (parent === workspace.id) running.delete(child);
          // A desktop that keeps its files takes a moment to close: its programs are asked to close first.
          if (op === 'reset' && closingMs) return void setTimeout(() => device.send({ type: 'workspace.state', payload: { requestId, workspace: info(workspace) } }), closingMs);
        }
        return void device.send({ type: 'workspace.state', payload: { requestId, workspace: info(workspace) } });
      }
      case 'computer.act': {
        const { requestId, workspace, action } = m.payload;
        if (!workspace) return void device.send({ type: 'computer.done', payload: { requestId, text: 'on the real screen' } });
        const used = use(workspace);
        const done = 'workspace' in used ? { text: `in ${workspace.id}`, ...(action.action === 'screenshot' ? { image: PICTURE, region: { x: 0, y: 0, width: 1280, height: 800 } } : {}) } : {};
        return void device.send({ type: 'computer.done', payload: { requestId, ...used, ...done } });
      }
      case 'clipboard.read': {
        const { requestId, workspace } = m.payload;
        if (!workspace) return void device.send({ type: 'clipboard.data', payload: { requestId, items: [{ kind: 'text', text: 'the person\'s own clipboard' }] } });
        return void device.send({ type: 'clipboard.data', payload: { requestId, items: [{ kind: 'text', text: `clipboard of ${workspace.id}` }], ...use(workspace) } });
      }
      case 'clipboard.write': {
        const { requestId, workspace } = m.payload;
        return void device.send({ type: 'clipboard.done', payload: { requestId, ...(workspace ? use(workspace) : {}) } });
      }
      case 'screen.capture': {
        const { requestId, workspace } = m.payload;
        return void device.send({ type: 'screen.image', payload: { requestId, image: PICTURE, ...(workspace ? use(workspace) : {}) } });
      }
      default:
        return;
    }
  });
  return {
    running,
    /** The desktop went away and came back, as after sitting unused: same name, next generation. */
    restart(id: string) {
      const generation = (starts.get(id) ?? 0) + 1;
      starts.set(id, generation);
      running.set(id, generation);
    },
    failEnsure(why: string | undefined) {
      ensureFails = why;
    },
    /** How long a desktop takes to close when its files are kept. */
    closeIn(ms: number) {
      closingMs = ms;
    },
  };
}

/** Answers tool calls like the VS Code extension; a queued reply stands in for what a call would really return. */
function fakeExecutor(device: Device) {
  const replies: ((call: PayloadOf<'tool.call'>) => { content: string; isError: boolean })[] = [];
  device.onMessage((m) => {
    if (m.type !== 'tool.call') return;
    const reply = replies.shift()?.(m.payload) ?? { content: `ran ${m.payload.name}`, isError: false };
    device.send({ type: 'tool.result', payload: { callId: m.payload.callId, ...reply } });
  });
  return { replies };
}

interface Internals {
  pcHandle(sessionId: string, agent?: string): PcHandle;
  executorHandle(sessionId: string): ExecutorHandle;
  executor: { info(id: string | undefined): { capabilities?: string[]; os?: string; workspaceHost?: string } | null };
  sessions: Map<string, SessionInternals>;
}

interface SessionInternals {
  handle(msg: unknown): void;
  trackToolUse(id: string, name: string, input: unknown, parentId?: string): unknown;
  computerTarget(extra: unknown): Promise<ComputerTarget>;
  reconcile(): void;
  q: unknown;
}

const inner = () => brain as unknown as Internals;
const pcOf = (sessionId: string, agent?: string) => inner().pcHandle(sessionId, agent);
const executorOf = (sessionId: string) => inner().executorHandle(sessionId);
const capsOf = (deviceId: string) => inner().executor.info(deviceId)?.capabilities ?? [];
const callerOf = (toolUseId: string) => ({ _meta: { 'claudecode/toolUseId': toolUseId } });

let owner: Device;
let oldPhone: Device;
let masha: Device;
let pc: Device;
let code: Device;
let desktops: ReturnType<typeof fakeDesktops>;
let tools: ReturnType<typeof fakeExecutor>;
let chatA: string;
let chatB: string;
let idA: string;
let idB: string;
let scopeA: string;
let scopeB: string;

const pcStatus = (capabilities: string[], os = 'linux 6.6.9-amd64'): InnerMessageBody => ({
  type: 'executor.status',
  payload: { workspaces: [], os, shell: 'none', capabilities, ...(capabilities.includes('workspaces') ? { workspaceHost: HOST_A } : {}) },
});
const codeStatus = (capabilities: string[], os = 'linux 6.6.9-amd64', workspaceHost: string | undefined = HOST_A): InnerMessageBody => ({
  type: 'executor.status',
  payload: { workspaces: ['/home/u/project'], os, shell: os.startsWith('win') ? 'pwsh' : 'bash', capabilities, ...(workspaceHost ? { workspaceHost } : {}) },
});
const DESKTOP_PC = ['clipboard', 'screenshot', 'computer', 'workspaces'];
const DESKTOP_CODE = ['tools', 'workspace-env'];

async function setPc(capabilities: string[], os?: string) {
  pc.send(pcStatus(capabilities, os));
  await eventually('the computer status', () => capsOf(pc.deviceId).join() === capabilities.join() && (os === undefined || inner().executor.info(pc.deviceId)?.os === os));
}
async function setCode(capabilities: string[], os?: string, workspaceHost?: string) {
  code.send(codeStatus(capabilities, os, workspaceHost ?? HOST_A));
  await eventually('the executor status', () => {
    const info = inner().executor.info(code.deviceId);
    return (info?.capabilities ?? []).join() === capabilities.join() && (os === undefined || info?.os === os) && info?.workspaceHost === (workspaceHost ?? HOST_A);
  });
}

beforeAll(async () => {
  ensureDirs();
  relay = await startNodeRelay({ port: 0 });
  brain = new Brain(generateIdentity(), { relayUrl: relay.url, devices: [], users: [], allowlist: [], sessions: [], replay: {} }, { persist: false });
  brain.start();
  await until<void>('brain ready', (ok) => {
    const t = setInterval(() => brain.status().relayConnected && (clearInterval(t), ok()), 25);
  });

  owner = await connect(parsePairingUri(brain.startPairing().uri).code, 'client', 'owner-phone');
  const status = await owner.ask({ type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } }, 'host.status');
  expect(status.payload.features).toEqual(expect.arrayContaining([PEER_FEATURES.subagents, PEER_FEATURES.workspaces]));
  // A phone with a build from before subagent cards and desktops: it says nothing about what it understands.
  oldPhone = await connect(parsePairingUri(brain.startPairing().uri).code, 'client', 'old-phone');
  await oldPhone.ask({ type: 'status.get', payload: {} }, 'host.status');
  masha = await connect(parsePairingUri(brain.startPairing(undefined, { invite: {} }).uri).code, 'client', 'masha-phone', 'Masha');
  await masha.ask({ type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } }, 'host.status');

  // The owner's Linux computer: PocketClipboard and the VS Code extension are two devices in one login.
  pc = await connect(parsePairingCode((await owner.ask({ type: 'computer.pair', payload: {} }, 'computer.pairing')).payload.code), 'executor', 'kali');
  desktops = fakeDesktops(pc);
  code = await connect(parsePairingCode((await owner.ask({ type: 'computer.pair', payload: {} }, 'computer.pairing')).payload.code), 'executor', 'kali-code');
  tools = fakeExecutor(code);
  expect(pc.deviceId).not.toBe(code.deviceId);
  await setPc(DESKTOP_PC);
  await setCode(DESKTOP_CODE);

  chatA = (await owner.ask({ type: 'session.create', payload: { title: 'Chat A' } }, 'session.created')).payload.session.sessionId;
  chatB = (await owner.ask({ type: 'session.create', payload: { title: 'Chat B' } }, 'session.created')).payload.session.sessionId;
  for (const sessionId of [chatA, chatB]) await owner.ask({ type: 'computer.select', payload: { deviceId: code.deviceId, sessionId } }, 'computers.result');
  expect(brain.sessionMode(chatA)).toEqual({ mode: 'remote', executorId: code.deviceId, pcId: pc.deviceId });
  expect(brain.sessionMode(chatB)).toEqual({ mode: 'remote', executorId: code.deviceId, pcId: pc.deviceId });

  const of = { accountId: brain.accountId, userId: OWNER_ID, deviceId: pc.deviceId };
  idA = workspaceId({ ...of, sessionId: chatA });
  idB = workspaceId({ ...of, sessionId: chatB });
  scopeA = jobScope({ accountId: brain.accountId, userId: OWNER_ID, sessionId: chatA });
  scopeB = jobScope({ accountId: brain.accountId, userId: OWNER_ID, sessionId: chatB });
});

afterAll(async () => {
  for (const l of links) l.close();
  brain.stop();
  await relay.close();
});

describe('which desktop a chat gets', () => {
  it('derives a stable name from the owner, the computer and the chat, and nothing else', () => {
    const of = { accountId: 'acct', userId: 'owner', deviceId: 'dev', sessionId: 's1' };
    expect(workspaceId(of)).toMatch(WORKSPACE_ID_PATTERN);
    expect(workspaceId(of)).toBe(workspaceId({ ...of }));
    const others = [{ ...of, accountId: 'acct2' }, { ...of, userId: 'masha' }, { ...of, deviceId: 'dev2' }, { ...of, sessionId: 's2' }, { ...of, child: 'task1' }, { ...of, child: 'task2' }];
    expect(new Set([workspaceId(of), ...others.map((o) => workspaceId(o))]).size).toBe(others.length + 1);
    // The parts are kept apart: moving characters between two of them names another desktop.
    expect(workspaceId({ ...of, userId: 'ownerd', deviceId: 'ev' })).not.toBe(workspaceId(of));
    expect(jobScope({ accountId: 'acct', userId: 'owner', sessionId: 's1' })).toMatch(/^job_[0-9a-f]{24}$/);
    expect(jobScope({ accountId: 'acct', userId: 'owner', sessionId: 's1' })).not.toBe(jobScope({ accountId: 'acct', userId: 'owner', sessionId: 's2' }));
  });

  it("sends each chat's steps, screenshots and clipboard to that chat's desktop", async () => {
    expect(idA).not.toBe(idB);
    expect(pcOf(chatA).desktop).toEqual({ key: 'main' });
    const mark = pc.inbox.length;
    const [a, b] = await Promise.all([pcOf(chatA).computer({ action: 'screenshot' }), pcOf(chatB).computer({ action: 'screenshot' })]);
    expect(a).toMatchObject({ text: `in ${idA}`, workspace: { id: idA, generation: 1, state: 'running' } });
    expect(b).toMatchObject({ text: `in ${idB}`, workspace: { id: idB, generation: 1, state: 'running' } });
    expect(pc.got('computer.act', mark).map((m) => m.payload.workspace)).toEqual(expect.arrayContaining([{ id: idA, label: 'Chat A' }, { id: idB, label: 'Chat B' }]));

    expect((await pcOf(chatA).clipboardRead()).items).toEqual([{ kind: 'text', text: `clipboard of ${idA}` }]);
    expect((await pcOf(chatB).clipboardRead()).items).toEqual([{ kind: 'text', text: `clipboard of ${idB}` }]);
    await pcOf(chatB).screenshot();
    await pcOf(chatA).clipboardWrite({ kind: 'text', text: 'x' });
    for (const type of ['clipboard.read', 'screen.capture', 'clipboard.write'] as const) {
      for (const m of pc.got(type, mark)) {
        expect(m.payload.workspace?.id === idA || m.payload.workspace?.id === idB).toBe(true);
        expect(m.payload.scope).toBeUndefined();
      }
    }
    expect(pc.got('clipboard.write', mark).map((m) => m.payload.workspace?.id)).toEqual([idA]);
    expect(pc.got('screen.capture', mark).map((m) => m.payload.workspace?.id)).toEqual([idB]);
  });

  it('lets nothing in a step choose the desktop', async () => {
    const mark = pc.inbox.length;
    // What a model could try to smuggle in with its arguments: another chat's desktop, a display, a cookie file.
    const [tool] = computerTools(() => pcOf(chatA), new ComputerState(), { sleep: async () => undefined });
    // Claude Code checks a call against the tool's own description first: what is not in it is dropped, and a display
    // is a monitor's number inside the desktop, never the name of an X display.
    const shape = z.object(tool!.inputSchema as z.ZodRawShape);
    expect(shape.safeParse({ action: 'screenshot', display: ':0' }).success).toBe(false);
    const input = shape.parse({ action: 'screenshot', workspace: { id: idB }, xauthority: '/home/u/.Xauthority', generation: 7 });
    expect(input).toEqual({ action: 'screenshot' });
    await tool!.handler(input as never, {});
    const acts = pc.got('computer.act', mark);
    expect(acts.length).toBeGreaterThan(0);
    for (const act of acts) expect(act.payload.workspace).toEqual({ id: idA, label: 'Chat A' });
    // And a request that carries such a field to the computer anyway is not a message PocketClipboard accepts.
    expect(innerMessageBodySchema.safeParse({ type: 'computer.act', payload: { requestId: 'r', action: { action: 'screenshot' }, workspace: { id: ':0' } } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'computer.act', payload: { requestId: 'r', action: { action: 'screenshot' }, workspace: { id: '../../etc' } } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'tool.call', payload: { callId: 'c', name: 'run_command', args: {}, context: { scope: scopeA, workspace: { id: idA, generation: 1, display: ':0' } } } })).toMatchObject({
      success: true,
      data: { payload: { context: { scope: scopeA, workspace: { id: idA, generation: 1 } } } },
    });
  });

  it("keeps the phone's own clipboard and screenshot requests on the real desktop, and says so", async () => {
    const mark = pc.inbox.length;
    const clip = await owner.ask({ type: 'clipboard.get', payload: { requestId: 'r1', deviceId: pc.deviceId } }, 'clipboard.result');
    expect(clip.payload.items).toEqual([{ kind: 'text', text: "the person's own clipboard" }]);
    await owner.ask({ type: 'screen.get', payload: { requestId: 'r2', deviceId: pc.deviceId } }, 'screen.result');
    await owner.ask({ type: 'clipboard.set', payload: { requestId: 'r3', deviceId: pc.deviceId, item: { kind: 'text', text: 'from the phone' } } }, 'clipboard.written').catch(() => undefined);
    expect(pc.got('clipboard.read', mark).map((m) => m.payload)).toEqual([{ requestId: 'r1', scope: 'host' }]);
    expect(pc.got('screen.capture', mark).map((m) => m.payload)).toEqual([{ requestId: 'r2', scope: 'host' }]);
    expect(pc.got('clipboard.write', mark).map((m) => [m.payload.scope, m.payload.workspace])).toEqual([['host', undefined]]);
  });

  it('refuses a step planned on a desktop that has been started again since', async () => {
    const first = await pcOf(chatA).computer({ action: 'screenshot' });
    const generation = first.workspace!.generation;
    desktops.restart(idA);
    const stale = await pcOf(chatA).computer({ action: 'click', x: 10, y: 10, button: 'left', count: 1 }, { generation });
    expect(stale).toMatchObject({ code: 'workspace_stale' });
    expect(stale.text).toBeUndefined();
    // The other chat's desktop is none the wiser.
    expect(await pcOf(chatB).computer({ action: 'click', x: 10, y: 10, button: 'left', count: 1 }, { generation: 1 })).toMatchObject({ text: `in ${idB}` });
  });

  it("shows a person only the desktops of their own chats", async () => {
    const mark = pc.inbox.length;
    const refused = await masha.ask({ type: 'workspace.preview', payload: { requestId: 'p1', sessionId: chatA } }, 'workspace.preview.result');
    expect(refused.payload).toMatchObject({ requestId: 'p1', error: 'Session not found' });
    expect(refused.payload.image).toBeUndefined();
    expect((await masha.ask({ type: 'workspace.get', payload: { requestId: 'p2', sessionId: chatA } }, 'workspace.result')).payload).toMatchObject({ supported: false, desktops: [], error: 'Session not found' });
    expect((await masha.ask({ type: 'workspace.reset', payload: { requestId: 'p3', sessionId: chatA, wipe: true } }, 'workspace.result')).payload.error).toBe('Session not found');
    await pause(100);
    expect(pc.got('workspace.control', mark)).toEqual([]);
    expect(desktops.running.has(idA)).toBe(true);

    const mine = await owner.ask({ type: 'workspace.preview', payload: { requestId: 'p4', sessionId: chatA } }, 'workspace.preview.result');
    expect(mine.payload).toMatchObject({ requestId: 'p4', key: 'main', image: PICTURE, generation: desktops.running.get(idA) });
    // Looking is a request of its own kind: it carries the chat's desktop and is not a step on it.
    expect(pc.got('workspace.control', mark).map((m) => [m.payload.op, m.payload.workspace?.id])).toEqual([['capture', idA]]);
    const listed = await owner.ask({ type: 'workspace.get', payload: { requestId: 'p5', sessionId: chatA } }, 'workspace.result');
    expect(listed.payload).toMatchObject({ supported: true, computer: { deviceId: pc.deviceId, name: 'kali', online: true }, desktops: [{ key: 'main', label: 'Chat A', state: 'running' }] });
  });
});

describe('a computer without desktops for chats', () => {
  it('gets no chat request at all when it is a Linux PocketClipboard from before them', async () => {
    await setPc(['clipboard', 'screenshot', 'computer']);
    try {
      const mark = pc.inbox.length;
      expect(pcOf(chatA).desktop).toBeUndefined();
      expect(pcOf(chatA).blocked).toMatch(/cannot give this chat a desktop of its own/);
      for (const answer of [await pcOf(chatA).computer({ action: 'screenshot' }), await pcOf(chatA).clipboardRead(), await pcOf(chatA).screenshot()]) {
        expect(answer).toMatchObject({ code: 'workspace_unavailable', error: expect.stringMatching(/install-linux\.sh/) });
      }
      await pause(100);
      expect(pc.got('computer.act', mark).concat(pc.got('clipboard.read', mark) as never[], pc.got('screen.capture', mark) as never[])).toEqual([]);
      const status = await owner.ask({ type: 'workspace.get', payload: { requestId: 'o1', sessionId: chatA } }, 'workspace.result');
      expect(status.payload).toMatchObject({ supported: false, desktops: [], reason: expect.stringMatching(/cannot give this chat a desktop/) });
    } finally {
      await setPc(DESKTOP_PC);
    }
  });

  it('is used as before where its owner switched them off, or where it is not Linux', async () => {
    for (const [capabilities, os] of [[['clipboard', 'screenshot', 'computer', 'host-desktop'], 'linux 6.6.9-amd64'], [['clipboard', 'screenshot', 'computer'], 'win32 10.0.22631']] as const) {
      await setPc([...capabilities], os);
      const mark = pc.inbox.length;
      expect(pcOf(chatA).desktop).toBeUndefined();
      expect(pcOf(chatA).blocked).toBeUndefined();
      expect(await pcOf(chatA).computer({ action: 'screenshot' })).toMatchObject({ text: 'on the real screen' });
      expect(pc.got('computer.act', mark).map((m) => m.payload.workspace)).toEqual([undefined]);
    }
    await setPc(DESKTOP_PC, 'linux 6.6.9-amd64');
  });
});

describe("a chat's commands", () => {
  it('run inside its desktop, which is started for them, with its own list of background jobs', async () => {
    desktops.running.delete(idA);
    const pcMark = pc.inbox.length;
    const codeMark = code.inbox.length;
    expect(await executorOf(chatA).call('run_command', { command: 'xterm &' })).toEqual({ content: 'ran run_command', isError: false });
    const generation = desktops.running.get(idA)!;
    expect(pc.got('workspace.control', pcMark).map((m) => [m.payload.op, m.payload.workspace])).toEqual([['ensure', { id: idA, label: 'Chat A' }]]);
    expect(code.got('tool.call', codeMark).map((m) => m.payload)).toEqual([
      { callId: expect.any(String), name: 'run_command', args: { command: 'xterm &' }, context: { scope: scopeA, workspace: { id: idA, generation } } },
    ]);

    // A desktop seen running a moment ago is not asked for again before every command.
    await executorOf(chatA).call('run_command', { command: 'xclock' });
    expect(pc.got('workspace.control', pcMark)).toHaveLength(1);
    // Other tools start no programs: they get the chat's job list, and no desktop is started for them.
    await executorOf(chatA).call('read_file', { path: 'README.md' });
    await executorOf(chatB).call('command_output', { id: 'bg1' });
    const calls = code.got('tool.call', codeMark).map((m) => m.payload);
    expect(calls[1]!.context).toEqual({ scope: scopeA, workspace: { id: idA, generation } });
    expect(calls[2]!.context).toEqual({ scope: scopeA });
    expect(calls[3]!.context).toEqual({ scope: scopeB });
    expect(scopeA).not.toBe(scopeB);

    await executorOf(chatB).call('run_command', { command: 'xeyes' });
    expect(code.got('tool.call', codeMark).at(-1)!.payload.context).toEqual({ scope: scopeB, workspace: { id: idB, generation: desktops.running.get(idB) } });
  });

  it('are run again in the desktop as it is now when it was started anew in between', async () => {
    await executorOf(chatA).call('run_command', { command: 'true' });
    const before = desktops.running.get(idA)!;
    desktops.restart(idA);
    const codeMark = code.inbox.length;
    // What the extension answers when the record on its machine names another generation: nothing was run.
    tools.replies.push(() => ({ content: `[workspace_stale] This chat's desktop was started again (it is generation ${before + 1}, the command was meant for ${before}). The command was not run.`, isError: true }));
    expect(await executorOf(chatA).call('run_command', { command: 'xterm' })).toEqual({ content: 'ran run_command', isError: false });
    expect(code.got('tool.call', codeMark).map((m) => m.payload.context?.workspace?.generation)).toEqual([before, before + 1]);
  });

  it('run without any display, and say why, when the desktop cannot be started', async () => {
    const chatC = (await owner.ask({ type: 'session.create', payload: { title: 'Chat C' } }, 'session.created')).payload.session.sessionId;
    await owner.ask({ type: 'computer.select', payload: { deviceId: code.deviceId, sessionId: chatC } }, 'computers.result');
    desktops.failEnsure('Missing on this computer: Xvfb, openbox. Run apps/clipboard-agent/scripts/install-linux.sh again.');
    try {
      const codeMark = code.inbox.length;
      const result = await executorOf(chatC).call('run_command', { command: 'firefox' });
      expect(result.content).toMatch(/^ran run_command\n\[No desktop for this command: Missing on this computer: Xvfb, openbox\./);
      expect(result.content).toMatch(/It ran without a display/);
      const sent = code.got('tool.call', codeMark)[0]!.payload;
      // No desktop is named, so the extension gives the command no display at all: never the person's.
      expect(sent.context).toEqual({ scope: jobScope({ accountId: brain.accountId, userId: OWNER_ID, sessionId: chatC }) });
      expect(sent.args).toEqual({ command: 'firefox' });
    } finally {
      desktops.failEnsure(undefined);
    }
  });

  it('get no desktop from a PocketClipboard that is not in the same login as the extension', async () => {
    await setCode(DESKTOP_CODE, undefined, 'b'.repeat(32));
    try {
      const pcMark = pc.inbox.length;
      const codeMark = code.inbox.length;
      await executorOf(chatA).call('run_command', { command: 'xterm' });
      expect(pc.got('workspace.control', pcMark)).toEqual([]);
      expect(code.got('tool.call', codeMark)[0]!.payload.context).toEqual({ scope: scopeA });
    } finally {
      await setCode(DESKTOP_CODE);
    }
  });

  it('lose the display themselves on a Linux extension from before desktops, and stay as they are elsewhere', async () => {
    await setCode(['tools']);
    let codeMark = code.inbox.length;
    await executorOf(chatA).call('run_command', { command: 'firefox' });
    await executorOf(chatA).call('read_file', { path: 'a.txt' });
    let calls = code.got('tool.call', codeMark).map((m) => m.payload);
    expect((calls[0]!.args as { command: string }).command).toMatch(/^unset DISPLAY XAUTHORITY WAYLAND_SOCKET; export WAYLAND_DISPLAY=\S+ GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb\nfirefox$/);
    expect(calls[0]!.context).toBeUndefined();
    expect(calls[1]!.args).toEqual({ path: 'a.txt' });

    await setCode(['tools'], 'win32 10.0.22631');
    codeMark = code.inbox.length;
    await executorOf(chatA).call('run_command', { command: 'notepad' });
    calls = code.got('tool.call', codeMark).map((m) => m.payload);
    expect(calls[0]).toEqual({ callId: expect.any(String), name: 'run_command', args: { command: 'notepad' } });
    await setCode(DESKTOP_CODE, 'linux 6.6.9-amd64');
  });
});

describe('subagents of a chat', () => {
  const started = (id: string, toolUseId: string, description: string, extra: Record<string, unknown> = {}) => ({
    type: 'system', subtype: 'task_started', task_id: id, tool_use_id: toolUseId, description, subagent_type: 'general-purpose', ...extra,
  });
  const childCalls = (parentToolUseId: string, id: string, name: string, input: unknown) => ({
    type: 'assistant', parent_tool_use_id: parentToolUseId, message: { content: [{ type: 'tool_use', id, name, input }] },
  });
  const cards = (device: Device, mark: number, id: string) =>
    device.got('session.event', mark).map((m) => m.payload.event).filter((e): e is Extract<SessionEvent, { kind: 'subagent' }> => e.kind === 'subagent' && e.id === id);

  it('get desktops of their own, are shown in the chat as they work, and end one by one', async () => {
    const session = inner().sessions.get(chatA)!;
    const ownerMark = owner.inbox.length;
    const oldMark = oldPhone.inbox.length;
    const pcMark = pc.inbox.length;
    const codeMark = code.inbox.length;
    await pcOf(chatA).computer({ action: 'screenshot' });

    session.handle(started('t1', 'toolu_1', 'Fill in the form'));
    session.handle(started('t2', 'toolu_2', 'Read the docs page'));
    session.handle(childCalls('toolu_1', 'toolu_c1', 'mcp__pocket__computer', { action: 'screenshot' }));
    session.handle(childCalls('toolu_2', 'toolu_c2', 'mcp__pocket__computer', { action: 'screenshot' }));
    session.trackToolUse('toolu_m1', 'mcp__pocket__computer', { action: 'screenshot' });

    // Whose call it is comes from the tool use Claude Code names, never from the call's arguments.
    const [one, two, main] = await Promise.all([session.computerTarget(callerOf('toolu_c1')), session.computerTarget(callerOf('toolu_c2')), session.computerTarget(callerOf('toolu_m1'))]);
    expect([one.pc.desktop, two.pc.desktop, main.pc.desktop]).toEqual([{ key: 't1' }, { key: 't2' }, { key: 'main' }]);
    expect(new Set([one.state, two.state, main.state]).size).toBe(3);
    const of = { accountId: brain.accountId, userId: OWNER_ID, deviceId: pc.deviceId, sessionId: chatA };
    const id1 = workspaceId({ ...of, child: 't1' });
    const id2 = workspaceId({ ...of, child: 't2' });
    const actMark = pc.inbox.length;
    await Promise.all([one.pc.computer({ action: 'screenshot' }), two.pc.computer({ action: 'screenshot' }), main.pc.computer({ action: 'screenshot' })]);
    expect(pc.got('computer.act', actMark).map((m) => m.payload.workspace)).toEqual(
      expect.arrayContaining([
        { id: id1, label: 'Chat A · Fill in the form', parent: idA },
        { id: id2, label: 'Chat A · Read the docs page', parent: idA },
        { id: idA, label: 'Chat A' },
      ]),
    );
    expect(new Set([id1, id2, idA, idB]).size).toBe(4);
    // A call nobody can be named for is not run on somebody's desktop on a guess.
    await expect(session.computerTarget({})).rejects.toThrow(/could not be matched to the agent that made it/);

    // A child's command runs in the child's desktop once it has one, under the chat's own job list.
    await executorOf(chatA).call('run_command', { command: 'xterm' }, { agent: 't1' });
    expect(code.got('tool.call', codeMark).at(-1)!.payload.context).toEqual({ scope: scopeA, workspace: { id: id1, generation: desktops.running.get(id1) } });

    // The phone sees both cards; the desktops are listed with the chat's own.
    await owner.next('session.event', ownerMark, (m) => m.payload.event.kind === 'subagent' && m.payload.event.id === 't2' && m.payload.event.desktop === true);
    expect(cards(owner, ownerMark, 't1').map((e) => e.status)).toEqual(expect.arrayContaining(['starting', 'running']));
    expect(cards(owner, ownerMark, 't1').at(-1)).toMatchObject({ name: 'general-purpose', task: 'Fill in the form', desktop: true, steps: [{ id: 'toolu_c1', tool: expect.any(String), status: 'running' }] });
    const listed = await owner.ask({ type: 'workspace.get', payload: { requestId: 'w1', sessionId: chatA } }, 'workspace.result');
    expect(listed.payload.desktops.map((d) => [d.key, d.state])).toEqual([['main', 'running'], ['t1', 'running'], ['t2', 'running']]);
    expect((await owner.ask({ type: 'workspace.preview', payload: { requestId: 'w2', sessionId: chatA, key: 't2' } }, 'workspace.preview.result')).payload.image).toEqual(PICTURE);

    // A phone that opens the chat now gets the history with the cards as they stand, each once.
    const history = (await owner.ask({ type: 'session.history', payload: { sessionId: chatA } }, 'session.history.result')).payload.events;
    const live = history.filter((e) => e.kind === 'subagent');
    expect(live.filter((e) => e.kind === 'subagent' && e.id === 't1').at(-1)).toMatchObject({ status: 'running', desktop: true });
    // A build from before the cards is sent none of it, live or in history: it would reject what it cannot read.
    expect(oldPhone.got('session.event', oldMark).filter((m) => m.payload.event.kind === 'subagent')).toEqual([]);
    const oldHistory = (await oldPhone.ask({ type: 'session.history', payload: { sessionId: chatA } }, 'session.history.result')).payload.events;
    expect(oldHistory.filter((e) => e.kind === 'subagent')).toEqual([]);
    // Reconnecting brings the cards of the running children again, as they are, without a request for history.
    const again = owner.inbox.length;
    await owner.ask({ type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } }, 'host.status');
    await owner.next('session.event', again, (m) => m.payload.event.kind === 'subagent' && m.payload.event.id === 't2');
    expect(cards(owner, again, 't1').at(-1)).toMatchObject({ status: 'running' });

    // Stopping one child: Claude Code ends that task alone and reports it.
    const stopped: string[] = [];
    session.q = {
      stopTask: async (id: string) => {
        stopped.push(id);
        session.handle({ type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped', summary: 'stopped' });
      },
    };
    const cancelMark = owner.inbox.length;
    const controlMark = pc.inbox.length;
    const killMark = code.inbox.length;
    owner.send({ type: 'subagent.cancel', payload: { sessionId: chatA, id: 't1' } });
    await owner.next('session.event', cancelMark, (m) => m.payload.event.kind === 'subagent' && m.payload.event.id === 't1' && m.payload.event.status === 'cancelled');
    expect(stopped).toEqual(['t1']);
    await eventually("the child's desktop to be closed", () => !desktops.running.has(id1));
    // Its desktop goes with it, and what it had running there; the sibling's and the chat's own stay.
    expect(pc.got('workspace.control', controlMark).filter((m) => m.payload.op === 'delete').map((m) => m.payload.workspace?.id)).toEqual([id1]);
    await eventually('the jobs of the child to be stopped', () => code.got('jobs.kill', killMark).length > 0);
    expect(code.got('jobs.kill', killMark).map((m) => m.payload)).toEqual([{ scope: scopeA, workspace: id1 }]);
    expect([desktops.running.has(id2), desktops.running.has(idA), desktops.running.has(idB)]).toEqual([true, true, true]);
    expect(cards(owner, cancelMark, 't2').filter((e) => e.status !== 'running' && e.status !== 'starting')).toEqual([]);
    expect((await two.pc.computer({ action: 'screenshot' })).text).toBe(`in ${id2}`);
    // Another person cannot stop a child of this chat.
    expect((await masha.ask({ type: 'subagent.cancel', payload: { sessionId: chatA, id: 't2' } }, 'error')).payload.code).toBe('unknown_session');
    expect(stopped).toEqual(['t1']);
    // A call still on its way from the child that was stopped is refused, not run somewhere else.
    await expect(session.computerTarget(callerOf('toolu_c1'))).rejects.toThrow(/already ended/);

    // The second child finishes with its report.
    const doneMark = owner.inbox.length;
    session.handle({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'The docs page lists three endpoints.' }] } });
    const done = await owner.next('session.event', doneMark, (m) => m.payload.event.kind === 'subagent' && m.payload.event.id === 't2' && m.payload.event.status === 'completed');
    expect(done.payload.event).toMatchObject({ result: 'The docs page lists three endpoints.' });
    await eventually("the second child's desktop to be closed", () => !desktops.running.has(id2));
    expect(desktops.running.has(idA)).toBe(true);
    const after = (await owner.ask({ type: 'session.history', payload: { sessionId: chatA } }, 'session.history.result')).payload.events;
    const lastOf = (id: string) => after.filter((e) => e.kind === 'subagent' && e.id === id).at(-1);
    expect(lastOf('t1')).toMatchObject({ status: 'cancelled' });
    expect(lastOf('t2')).toMatchObject({ status: 'completed', result: 'The docs page lists three endpoints.' });
    expect(pc.got('workspace.control', pcMark).filter((m) => m.payload.op === 'delete').map((m) => m.payload.workspace?.id)).toEqual([id1, id2]);
  });

  it('are closed as stopped when the daemon comes back without them', async () => {
    const chatD = (await owner.ask({ type: 'session.create', payload: { title: 'Chat D' } }, 'session.created')).payload.session.sessionId;
    const session = inner().sessions.get(chatD)!;
    // What a daemon that was killed left next to the chat's history: a child that was at work.
    const left: SessionEvent[] = [{ kind: 'subagent', id: 't9', status: 'running', name: 'Explore', task: 'Find the config', activity: 'Grep config', startedAt: 1000, at: 1500 }];
    const file = join(paths.sessionsDir, `${chatD}.agents.json`);
    writeFileSync(file, JSON.stringify(left));
    const mark = owner.inbox.length;
    session.reconcile();
    const closed = await owner.next('session.event', mark, (m) => m.payload.event.kind === 'subagent' && m.payload.event.id === 't9');
    expect(closed.payload.event).toMatchObject({ status: 'cancelled', task: 'Find the config', error: expect.stringMatching(/restarted/) });
    expect(closed.payload.event.kind === 'subagent' && closed.payload.event.activity).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    const history = (await owner.ask({ type: 'session.history', payload: { sessionId: chatD } }, 'session.history.result')).payload.events;
    expect(history.filter((e) => e.kind === 'subagent').map((e) => e.kind === 'subagent' && e.status)).toEqual(['cancelled']);
  });
});

describe("what the person does from the phone, as the chat's agent meets it", () => {
  it('lets go of a mouse button the chat left held down when its reply is stopped, and says after a reset that the desktop is a new one', async () => {
    const chatE = (await owner.ask({ type: 'session.create', payload: { title: 'Chat E' } }, 'session.created')).payload.session.sessionId;
    await owner.ask({ type: 'computer.select', payload: { deviceId: code.deviceId, sessionId: chatE } }, 'computers.result');
    const idE = workspaceId({ accountId: brain.accountId, userId: OWNER_ID, deviceId: pc.deviceId, sessionId: chatE });
    type Tool = { name: string; handler(input: never, extra: unknown): Promise<{ content: { type: string; text?: string }[] }> };
    const computer = (inner().sessions.get(chatE) as unknown as { pocketTools(): Tool[] }).pocketTools().find((t) => t.name === 'computer')!;
    const step = async (input: Record<string, unknown>) => (await computer.handler(input as never, {})).content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const stop = () => owner.send({ type: 'session.interrupt', payload: { sessionId: chatE } });

    expect(await step({ action: 'screenshot' })).toMatch(/This is this chat's own Linux desktop/);
    expect(await step({ action: 'left_mouse_down', coordinate: [10, 10] })).toMatch(/held down/);
    let mark = pc.inbox.length;
    stop();
    const released = () => pc.got('computer.act', mark).filter((m) => m.payload.action.action === 'release');
    await eventually('the button to be let go', () => released().length > 0);
    // On that chat's desktop, and without naming a start of it: letting go is right whatever the desktop is by now.
    expect(released().map((m) => m.payload.workspace)).toEqual([{ id: idE, label: 'Chat E' }]);
    // Nothing held and no step in flight: a second stop has nothing to let go of.
    mark = pc.inbox.length;
    stop();
    await pause(150);
    expect(pc.got('computer.act', mark)).toEqual([]);

    await owner.ask({ type: 'workspace.reset', payload: { requestId: 'e1', sessionId: chatE } }, 'workspace.result');
    expect(await step({ action: 'left_click', coordinate: [10, 10] })).toMatch(/Take a screenshot first/);
    expect(await step({ action: 'screenshot' })).toMatch(/freshly started desktop: the one from before was closed/);
    expect(await step({ action: 'screenshot' })).not.toMatch(/freshly started/);
    await owner.ask({ type: 'workspace.reset', payload: { requestId: 'e2', sessionId: chatE, wipe: true } }, 'workspace.result');
    expect(await step({ action: 'screenshot' })).toMatch(/the user deleted the one from before together with its files/);
  });

  it('is idle again, not typing, after a question that a background subagent raised when no reply was running', async () => {
    const chatF = (await owner.ask({ type: 'session.create', payload: { title: 'Chat F' } }, 'session.created')).payload.session.sessionId;
    await owner.ask({ type: 'computer.select', payload: { deviceId: code.deviceId, sessionId: chatF } }, 'computers.result');
    const host = (brain as unknown as { sessionHost(): { canUseTool(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ behavior: string }> } }).sessionHost();
    const states = (after: number) => owner.got('session.event', after).filter((m) => m.payload.sessionId === chatF).map((m) => (m.payload.event.kind === 'state' ? m.payload.event.state : undefined)).filter(Boolean);
    const answer = async (after: number) => {
      const request = await owner.next('permission.request', after, (m) => m.payload.sessionId === chatF);
      owner.send({ type: 'permission.respond', payload: { requestId: request.payload.requestId, decision: 'allow' } });
    };

    let mark = owner.inbox.length;
    const asked = host.canUseTool(chatF, 'mcp__pocket__Bash', { command: 'ls' }, new AbortController().signal);
    await answer(mark);
    expect((await asked).behavior).toBe('allow');
    await eventually('the chat to settle', () => states(mark).length === 2);
    expect(states(mark)).toEqual(['waiting_permission', 'idle']);

    // In the middle of a reply the same question leaves the chat replying, as before.
    const session = inner().sessions.get(chatF) as unknown as { setState(state: string): void };
    mark = owner.inbox.length;
    session.setState('running');
    await eventually('the reply to show', () => states(mark).includes('running'));
    mark = owner.inbox.length;
    const during = host.canUseTool(chatF, 'mcp__pocket__Bash', { command: 'pwd' }, new AbortController().signal);
    await answer(mark);
    await during;
    await eventually('the chat to go on', () => states(mark).length === 2);
    expect(states(mark)).toEqual(['waiting_permission', 'running']);
    session.setState('idle');
  });
});

describe('cleaning up', () => {
  it('closes only the desktop that was asked for and stops only what ran in it', async () => {
    await pcOf(chatA).computer({ action: 'screenshot' });
    await pcOf(chatB).computer({ action: 'screenshot' });
    const pcMark = pc.inbox.length;
    const codeMark = code.inbox.length;
    // The desktop keeps its files, so it closes in order and takes a moment over it. What the chat left running in
    // it is stopped after that, not before: a browser one of its commands started is asked to close like any other.
    desktops.closeIn(300);
    const asked = owner.ask({ type: 'workspace.reset', payload: { requestId: 'c1', sessionId: chatA } }, 'workspace.result');
    await eventually('the desktop to be asked to close', () => pc.got('workspace.control', pcMark).some((m) => m.payload.op === 'reset'));
    await pause(100);
    expect(code.got('jobs.kill', codeMark)).toEqual([]);
    const result = await asked;
    desktops.closeIn(0);
    expect(result.payload).toMatchObject({ requestId: 'c1', supported: true, desktops: [{ key: 'main', state: 'stopped' }] });
    expect(pc.got('workspace.control', pcMark).filter((m) => m.payload.op !== 'status').map((m) => [m.payload.op, m.payload.workspace?.id, m.payload.children])).toEqual([['reset', idA, true]]);
    await eventually('the jobs in it to be stopped', () => code.got('jobs.kill', codeMark).length > 0);
    expect(code.got('jobs.kill', codeMark).map((m) => m.payload)).toEqual([{ scope: scopeA, workspace: idA }]);
    expect([desktops.running.has(idA), desktops.running.has(idB)]).toEqual([false, true]);
    // The chat's next step starts a fresh desktop: a new generation, which its old screenshots do not fit.
    expect((await pcOf(chatA).computer({ action: 'screenshot' })).workspace).toMatchObject({ id: idA, state: 'running' });
  });

  it('removes the desktops and stops the jobs of a chat that is deleted, and of no other', async () => {
    await pcOf(chatA).computer({ action: 'screenshot' });
    const pcMark = pc.inbox.length;
    const codeMark = code.inbox.length;
    await owner.ask({ type: 'session.delete', payload: { sessionId: chatA } }, 'session.deleted');
    await eventually('the desktop to be removed', () => pc.got('workspace.control', pcMark).some((m) => m.payload.op === 'delete'));
    expect(pc.got('workspace.control', pcMark).map((m) => [m.payload.op, m.payload.workspace?.id, m.payload.children])).toEqual([['delete', idA, true]]);
    await eventually('the jobs to be stopped', () => code.got('jobs.kill', codeMark).length > 0);
    expect(code.got('jobs.kill', codeMark).map((m) => m.payload)).toEqual([{ scope: scopeA }]);
  });

  it('closes the desktop a chat leaves behind when it moves to another computer', async () => {
    await pcOf(chatB).computer({ action: 'screenshot' });
    const other = await connect(parsePairingCode((await owner.ask({ type: 'computer.pair', payload: {} }, 'computer.pairing')).payload.code), 'executor', 'laptop');
    const otherDesktops = fakeDesktops(other);
    other.send({ type: 'executor.status', payload: { workspaces: [], os: 'linux 6.8', shell: 'none', capabilities: DESKTOP_PC, workspaceHost: 'c'.repeat(32) } });
    await eventually('the second computer', () => capsOf(other.deviceId).includes('workspaces'));
    await owner.ask({ type: 'computer.select', payload: { deviceId: other.deviceId, sessionId: chatB } }, 'computers.result');
    expect(brain.sessionMode(chatB)?.pcId).toBe(other.deviceId);
    const pcMark = pc.inbox.length;
    const moved = await pcOf(chatB).computer({ action: 'screenshot' });
    const idOnOther = workspaceId({ accountId: brain.accountId, userId: OWNER_ID, deviceId: other.deviceId, sessionId: chatB });
    // Another computer, another desktop: the name is bound to the device, so the old one cannot be reached from here.
    expect(idOnOther).not.toBe(idB);
    expect(moved.workspace).toMatchObject({ id: idOnOther, generation: 1 });
    expect(otherDesktops.running.has(idOnOther)).toBe(true);
    await eventually('the old desktop to be closed', () => !desktops.running.has(idB));
    expect(pc.got('workspace.control', pcMark).map((m) => [m.payload.op, m.payload.workspace?.id])).toEqual([['reset', idB]]);
  });
});
