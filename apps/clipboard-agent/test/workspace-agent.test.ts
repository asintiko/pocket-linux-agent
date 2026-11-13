import { describe, expect, it } from 'vitest';
import {
  b64,
  generateIdentity,
  serializeIdentity,
  type ClipboardItem,
  type ComputerAction,
  type InnerMessage,
  type InnerMessageBody,
  type ScreenImage,
  type WorkspaceErrorCode,
  type WorkspaceInfo,
} from '@pocket/protocol';
import { ClipboardAgent, type AgentState, type WorkspaceHost } from '../src/agent.js';
import type { ClipboardBackend } from '../src/clipboard.js';
import type { ComputerBackend } from '../src/computer.js';

const BRAIN = 'brain-device';
const A = `ws_${'a'.repeat(26)}`;
const B = `ws_${'b'.repeat(26)}`;
const PICTURE: ScreenImage = { mime: 'image/jpeg', dataBase64: 'AAAA', width: 1280, height: 800 };

function fakeClipboard(initial: string) {
  let text = initial;
  const used: string[] = [];
  const backend: ClipboardBackend = {
    read: async () => {
      used.push('read');
      return text ? [{ kind: 'text', text } satisfies ClipboardItem] : [];
    },
    write: async (item) => {
      used.push('write');
      if (item.kind === 'text') text = item.text;
    },
  };
  return { backend, used, text: () => text };
}

function fakeComputer(name: string) {
  const acts: ComputerAction[] = [];
  let released = 0;
  const backend: ComputerBackend = {
    act: async (action) => {
      acts.push(action);
      return action.action === 'screenshot' ? { image: PICTURE, text: name } : { text: name };
    },
    release: () => void released++,
    close: () => {},
  };
  return { backend, acts, released: () => released };
}

const failure = (code: WorkspaceErrorCode, message: string) => Object.assign(new Error(message), { code });

/** Per-chat desktops as the agent uses them, without any X server behind them. */
function fakeHost() {
  const desktops = new Map<string, { generation: number; clipboard: ReturnType<typeof fakeClipboard>; computer: ReturnType<typeof fakeComputer> }>();
  const calls: string[] = [];
  const info = (id: string): WorkspaceInfo => ({ id, generation: desktops.get(id)?.generation ?? 0, state: desktops.has(id) ? 'running' : 'stopped' });
  const host: WorkspaceHost = {
    hostId: 'f'.repeat(32),
    async use(binding) {
      calls.push(`use ${binding.id}${binding.generation !== undefined ? `@${binding.generation}` : ''}`);
      let desktop = desktops.get(binding.id);
      if (binding.generation !== undefined && desktop?.generation !== binding.generation) throw failure('workspace_stale', 'This desktop was started again since the last screenshot.');
      if (!desktop) desktops.set(binding.id, (desktop = { generation: 1, clipboard: fakeClipboard(''), computer: fakeComputer(binding.id) }));
      return { info: info(binding.id), computer: desktop.computer.backend, clipboard: desktop.clipboard.backend };
    },
    status: (binding) => info(binding.id),
    list: () => [...desktops.keys()].map(info),
    async capture(id) {
      calls.push(`capture ${id}`);
      if (!desktops.has(id)) throw failure('workspace_unavailable', 'This desktop is not running right now.');
      return { image: PICTURE, info: info(id) };
    },
    async reset(id, opts) {
      calls.push(`reset ${id}${opts?.wipe ? ' wipe' : ''}${opts?.children ? ' children' : ''}`);
      desktops.delete(id);
      return info(id);
    },
    release: (id) => void calls.push(`release ${id}`),
    releaseAll: () => void calls.push('releaseAll'),
  };
  return { host, desktops, calls };
}

function setup(opts: { desktops?: boolean; computer?: boolean; hostDesktop?: boolean } = {}) {
  const person = { clipboard: fakeClipboard("the person's own"), computer: fakeComputer('the real screen'), shots: 0 };
  const chats = fakeHost();
  const state: AgentState = {
    relayUrl: 'ws://127.0.0.1:9',
    accountId: 'account',
    brainDeviceId: BRAIN,
    brainEncPub: b64.encode(generateIdentity().encPub),
    deviceId: 'this-computer',
    identity: serializeIdentity(generateIdentity()),
    replay: {},
  };
  const agent = new ClipboardAgent(state, {
    clipboard: person.clipboard.backend,
    screen: { capture: async () => (person.shots++, PICTURE) },
    ...(opts.computer ? { computer: person.computer.backend } : {}),
    ...(opts.desktops !== false ? { workspaces: chats.host } : {}),
    ...(opts.hostDesktop ? { hostDesktop: true } : {}),
    log: () => {},
    onRelayMoved: () => {},
  });
  const sent: InnerMessageBody[] = [];
  const internals = agent as unknown as {
    link: { send(to: string, body: InnerMessageBody): boolean };
    onMessage(m: { from: string; message: InnerMessage }): Promise<void>;
    sendStatus(): void;
  };
  internals.link.send = (_to, body) => (sent.push(body), true);
  /** Delivers a message as if it came over the relay and returns what the agent answered. */
  const receive = async (body: InnerMessageBody, from = BRAIN) => {
    const mark = sent.length;
    await internals.onMessage({ from, message: { ts: 0, counter: 1, ...body } });
    return sent.slice(mark);
  };
  const status = () => {
    const mark = sent.length;
    internals.sendStatus();
    const [body] = sent.slice(mark);
    if (body?.type !== 'executor.status') throw new Error('no status');
    return body.payload;
  };
  return { receive, status, person, chats };
}

const payloadOf = (replies: InnerMessageBody[]) => replies[0]!.payload as Record<string, unknown>;

describe('PocketClipboard with per-chat desktops', () => {
  it('tells the Mac that chats get desktops here, and which login they are in', () => {
    const on = setup().status();
    // A desktop of its own needs no switch of the person's: it is not their screen.
    expect(on.capabilities).toEqual(expect.arrayContaining(['clipboard', 'screenshot', 'computer', 'workspaces']));
    expect(on.capabilities).not.toContain('host-desktop');
    expect(on.workspaceHost).toBe('f'.repeat(32));

    const off = setup({ desktops: false, hostDesktop: true, computer: true }).status();
    expect(off.capabilities).toContain('host-desktop');
    expect(off.capabilities).not.toContain('workspaces');
    expect(off.workspaceHost).toBeUndefined();

    // Wanted, but not there (a program is missing): neither is said, and the Mac gives chats an error.
    const broken = setup({ desktops: false, computer: true }).status();
    expect(broken.capabilities).not.toContain('workspaces');
    expect(broken.capabilities).not.toContain('host-desktop');
  });

  it("keeps each chat's clipboard in its desktop and the person's own for the phone", async () => {
    const { receive, person, chats } = setup();
    expect(await receive({ type: 'clipboard.write', payload: { requestId: 'w1', item: { kind: 'text', text: 'from chat A' }, workspace: { id: A } } })).toEqual([
      { type: 'clipboard.done', payload: { requestId: 'w1', workspace: { id: A, generation: 1, state: 'running' } } },
    ]);
    await receive({ type: 'clipboard.write', payload: { requestId: 'w2', item: { kind: 'text', text: 'from chat B' }, workspace: { id: B } } });
    expect(payloadOf(await receive({ type: 'clipboard.read', payload: { requestId: 'r1', workspace: { id: A } } })).items).toEqual([{ kind: 'text', text: 'from chat A' }]);
    expect(payloadOf(await receive({ type: 'clipboard.read', payload: { requestId: 'r2', workspace: { id: B } } })).items).toEqual([{ kind: 'text', text: 'from chat B' }]);
    expect(person.clipboard.used).toEqual([]);
    expect(person.clipboard.text()).toBe("the person's own");

    // The phone's own request says that it is about the computer itself, and gets exactly that.
    expect(payloadOf(await receive({ type: 'clipboard.read', payload: { requestId: 'r3', scope: 'host' } })).items).toEqual([{ kind: 'text', text: "the person's own" }]);
    await receive({ type: 'clipboard.write', payload: { requestId: 'w3', item: { kind: 'text', text: 'from the phone' }, scope: 'host' } });
    expect(person.clipboard.text()).toBe('from the phone');
    expect(chats.desktops.get(A)!.clipboard.text()).toBe('from chat A');
    expect(chats.desktops.get(B)!.clipboard.text()).toBe('from chat B');
    // A Mac from before desktops marks nothing: that is the person's own too, as it always was.
    expect(payloadOf(await receive({ type: 'clipboard.read', payload: { requestId: 'r4' } })).items).toEqual([{ kind: 'text', text: 'from the phone' }]);
  });

  it("carries out a chat's steps and screenshots in its desktop, also where the person allowed their own screen", async () => {
    const { receive, person, chats } = setup({ computer: true });
    const click: ComputerAction = { action: 'click', x: 5, y: 6, button: 'left', count: 1 };
    expect(await receive({ type: 'computer.act', payload: { requestId: 'c1', action: click, workspace: { id: A } } })).toEqual([
      { type: 'computer.done', payload: { requestId: 'c1', text: A, workspace: { id: A, generation: 1, state: 'running' } } },
    ]);
    const shot = await receive({ type: 'screen.capture', payload: { requestId: 's1', workspace: { id: B } } });
    expect(shot).toEqual([{ type: 'screen.image', payload: { requestId: 's1', image: PICTURE, workspace: { id: B, generation: 1, state: 'running' } } }]);
    expect(chats.desktops.get(A)!.computer.acts).toEqual([click]);
    expect(chats.desktops.get(B)!.computer.acts).toEqual([{ action: 'screenshot' }]);
    expect(person.computer.acts).toEqual([]);
    expect(person.shots).toBe(0);

    // The phone's screenshot is of the real screen.
    await receive({ type: 'screen.capture', payload: { requestId: 's2', scope: 'host' } });
    expect(person.shots).toBe(1);
    expect(chats.desktops.get(A)!.computer.acts).toEqual([click]);
  });

  it('refuses a step that names no desktop instead of carrying it out on the real screen', async () => {
    const { receive, person, chats } = setup();
    const reply = await receive({ type: 'computer.act', payload: { requestId: 'c1', action: { action: 'screenshot' } } });
    expect(reply).toEqual([{ type: 'computer.done', payload: { requestId: 'c1', error: expect.stringMatching(/desktops of their own, and this request named none/), code: 'workspace_required' } }]);
    expect(person.computer.acts).toEqual([]);
    expect(chats.calls).toEqual([]);

    // Only the person's own switch opens the real screen, and then only for a request that names no desktop.
    const allowed = setup({ computer: true });
    expect(payloadOf(await allowed.receive({ type: 'computer.act', payload: { requestId: 'c2', action: { action: 'screenshot' } } })).text).toBe('the real screen');
    expect(allowed.chats.calls).toEqual([]);
  });

  it('refuses a step planned on a desktop that is gone, and does nothing', async () => {
    const { receive, chats } = setup({ computer: true });
    await receive({ type: 'computer.act', payload: { requestId: 'c1', action: { action: 'screenshot' }, workspace: { id: A } } });
    const stale = await receive({ type: 'computer.act', payload: { requestId: 'c2', action: { action: 'click', x: 1, y: 1, button: 'left', count: 1 }, workspace: { id: A, generation: 7 } } });
    expect(stale).toEqual([{ type: 'computer.done', payload: { requestId: 'c2', error: expect.stringMatching(/started again/), code: 'workspace_stale' } }]);
    expect(chats.desktops.get(A)!.computer.acts).toEqual([{ action: 'screenshot' }]);
  });

  it('never falls back to the real screen or clipboard when desktops are not available', async () => {
    const { receive, person } = setup({ desktops: false, computer: true });
    for (const body of [
      { type: 'computer.act', payload: { requestId: 'q1', action: { action: 'screenshot' }, workspace: { id: A } } },
      { type: 'clipboard.read', payload: { requestId: 'q2', workspace: { id: A } } },
      { type: 'clipboard.write', payload: { requestId: 'q3', item: { kind: 'text', text: 'x' }, workspace: { id: A } } },
      { type: 'screen.capture', payload: { requestId: 'q4', workspace: { id: A } } },
      { type: 'workspace.control', payload: { requestId: 'q5', op: 'ensure', workspace: { id: A } } },
    ] satisfies InnerMessageBody[]) {
      const reply = payloadOf(await receive(body));
      expect(reply).toMatchObject({ code: 'workspace_unavailable', error: expect.stringMatching(/no per-chat desktops/) });
      expect(reply.items ?? reply.image ?? reply.text).toBeUndefined();
    }
    expect(person.computer.acts).toEqual([]);
    expect(person.clipboard.used).toEqual([]);
    expect(person.clipboard.text()).toBe("the person's own");
    expect(person.shots).toBe(0);
  });

  it('lets go of one desktop without starting it, and of everything on the kill switch', async () => {
    const { receive, person, chats } = setup({ computer: true });
    expect(await receive({ type: 'computer.act', payload: { requestId: 'c1', action: { action: 'release' }, workspace: { id: A } } })).toEqual([
      { type: 'computer.done', payload: { requestId: 'c1', text: 'Let go of all keys and mouse buttons.' } },
    ]);
    expect(chats.calls).toEqual([`release ${A}`]);
    expect(chats.desktops.size).toBe(0);
    expect(person.computer.released()).toBe(0);

    await receive({ type: 'control.kill', payload: { scope: 'all' } });
    expect(chats.calls).toEqual([`release ${A}`, 'releaseAll']);
    expect(person.computer.released()).toBe(1);
  });

  it('starts, shows, closes and removes desktops when the Mac asks, and only then', async () => {
    const { receive, chats } = setup();
    expect(payloadOf(await receive({ type: 'workspace.control', payload: { requestId: 'k1', op: 'status', workspace: { id: A } } })).workspace).toEqual({ id: A, generation: 0, state: 'stopped' });
    expect(chats.desktops.size).toBe(0);
    // Looking in does not start a desktop.
    expect(payloadOf(await receive({ type: 'workspace.control', payload: { requestId: 'k2', op: 'capture', workspace: { id: A } } }))).toMatchObject({ code: 'workspace_unavailable' });
    expect(chats.desktops.size).toBe(0);

    expect(payloadOf(await receive({ type: 'workspace.control', payload: { requestId: 'k3', op: 'ensure', workspace: { id: A } } })).workspace).toMatchObject({ state: 'running', generation: 1 });
    const seen = payloadOf(await receive({ type: 'workspace.control', payload: { requestId: 'k4', op: 'capture', workspace: { id: A } } }));
    expect(seen).toMatchObject({ image: PICTURE, workspace: { id: A, state: 'running' } });
    // A look is not a step: the desktop's own helper was not asked for a screenshot.
    expect(chats.desktops.get(A)!.computer.acts).toEqual([]);
    expect(payloadOf(await receive({ type: 'workspace.control', payload: { requestId: 'k5', op: 'list' } })).workspaces).toEqual([{ id: A, generation: 1, state: 'running' }]);

    await receive({ type: 'workspace.control', payload: { requestId: 'k6', op: 'ensure', workspace: { id: B } } });
    expect(payloadOf(await receive({ type: 'workspace.control', payload: { requestId: 'k7', op: 'reset', workspace: { id: A }, children: true } })).workspace).toMatchObject({ id: A, state: 'stopped' });
    await receive({ type: 'workspace.control', payload: { requestId: 'k8', op: 'delete', workspace: { id: A } } });
    expect(chats.calls.filter((c) => c.startsWith('reset'))).toEqual([`reset ${A} children`, `reset ${A} wipe`]);
    expect([...chats.desktops.keys()]).toEqual([B]);
  });

  it('takes requests from the paired Mac only', async () => {
    const { receive, person, chats } = setup({ computer: true });
    for (const body of [
      { type: 'computer.act', payload: { requestId: 'x1', action: { action: 'screenshot' }, workspace: { id: A } } },
      { type: 'clipboard.read', payload: { requestId: 'x2', workspace: { id: A } } },
      { type: 'workspace.control', payload: { requestId: 'x3', op: 'delete', workspace: { id: A }, children: true } },
      { type: 'clipboard.read', payload: { requestId: 'x4', scope: 'host' } },
    ] satisfies InnerMessageBody[]) {
      expect(await receive(body, 'another-device')).toEqual([]);
    }
    expect(chats.calls).toEqual([]);
    expect(person.clipboard.used).toEqual([]);
  });
});
