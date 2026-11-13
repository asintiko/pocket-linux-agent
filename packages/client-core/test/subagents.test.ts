import { b64, deriveDeviceId, generateIdentity, PEER_FEATURES, type InnerMessageBody, type SessionEvent } from '@pocket/protocol';
import { describe, expect, it } from 'vitest';
import { ChatClient } from '../src/chat-client.js';
import { applyEvent, buildThread, subagentEnded, type ChatItem } from '../src/thread.js';

type Card = Extract<SessionEvent, { kind: 'subagent' }>;
const card = (id: string, status: Card['status'], extra: Partial<Card> = {}): Card => ({ kind: 'subagent', id, status, name: 'general-purpose', task: `Task ${id}`, startedAt: 100, ...extra });
const cards = (items: ChatItem[]) => items.filter((it): it is Extract<ChatItem, { type: 'subagent' }> => it.type === 'subagent');

describe('subagent cards in a thread', () => {
  it('puts a card where the child started and changes it in place from then on', () => {
    let items = applyEvent([], { kind: 'user', text: 'check both pages', from: 'phone' });
    items = applyEvent(items, { kind: 'text_delta', text: 'On it' });
    items = applyEvent(items, card('t1', 'starting', { at: 110 }));
    // The text that was streaming is closed: the card comes after it, not inside it.
    expect(items.map((it) => it.type)).toEqual(['user', 'assistant', 'subagent']);
    expect(items[1]).toMatchObject({ streaming: false });
    const key = items[2]!.key;

    items = applyEvent(items, { kind: 'text', text: 'I started two helpers.' });
    items = applyEvent(items, card('t2', 'starting', { at: 120 }));
    items = applyEvent(items, card('t1', 'running', { activity: 'Read index.html', toolUses: 1, steps: [{ id: 'c1', tool: 'Read', status: 'running' }], at: 130 }));
    expect(items.map((it) => it.type)).toEqual(['user', 'assistant', 'subagent', 'assistant', 'subagent']);
    expect(items[2]).toMatchObject({ type: 'subagent', id: 't1', status: 'running', activity: 'Read index.html', at: 110, key });
    expect(items[4]).toMatchObject({ type: 'subagent', id: 't2', status: 'starting' });

    items = applyEvent(items, card('t1', 'completed', { result: 'Both links work.', endedAt: 200, at: 200 }));
    expect(items[2]).toMatchObject({ id: 't1', status: 'completed', result: 'Both links work.', endedAt: 200, at: 110, key });
    // What the finished card no longer carries is gone from it, not left over from the running one.
    expect((items[2] as Extract<ChatItem, { type: 'subagent' }>).activity).toBeUndefined();
    expect(items[4]).toMatchObject({ id: 't2', status: 'starting' });
  });

  it('never doubles a card, however often its events arrive', () => {
    const events: SessionEvent[] = [
      { kind: 'user', text: 'go', from: 'phone' },
      card('t1', 'starting'),
      card('t1', 'running', { toolUses: 1 }),
      card('t2', 'starting'),
      card('t1', 'completed', { result: 'done' }),
    ];
    const once = buildThread(events);
    expect(cards(once).map((c) => [c.id, c.status])).toEqual([['t1', 'completed'], ['t2', 'starting']]);
    // History loaded while live events of the same children come in: the same cards, not more of them.
    let items = once;
    for (const event of [...events.slice(1), card('t2', 'running', { activity: 'Grep' }), card('t2', 'running', { activity: 'Grep' })]) items = applyEvent(items, event);
    expect(cards(items).map((c) => [c.id, c.status])).toEqual([['t1', 'completed'], ['t2', 'running']]);
    expect(items).toHaveLength(once.length);
  });

  it('keeps a card that ended from going back to running', () => {
    let items = buildThread([card('t1', 'running'), card('t1', 'cancelled', { endedAt: 300 })]);
    // A progress line that was still on its way when the child was stopped.
    items = applyEvent(items, card('t1', 'running', { activity: 'still typing' }));
    expect(cards(items)).toHaveLength(1);
    expect(cards(items)[0]).toMatchObject({ status: 'cancelled', endedAt: 300 });
    expect(cards(items)[0]!.activity).toBeUndefined();
    // Its report may still follow, and a card that failed stays a failure.
    items = applyEvent(buildThread([card('t2', 'completed')]), card('t2', 'completed', { result: 'late report' }));
    expect(cards(items)[0]).toMatchObject({ status: 'completed', result: 'late report' });
    expect(['starting', 'running', 'completed', 'failed', 'cancelled'].map((s) => subagentEnded(s as Card['status']))).toEqual([false, false, true, true, true]);
  });

  it('keeps children apart from the tool calls and background commands of the chat', () => {
    const items = buildThread([
      { kind: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Task t1' } },
      card('t1', 'running', { toolUseId: 'toolu_1' }),
      { kind: 'tool_use', id: 'toolu_2', name: 'run_command', input: { command: 'npm run dev', background: true } },
      { kind: 'tool_result', id: 'toolu_2', content: 'Started in the background with id bg1.', isError: false },
      card('t1', 'failed', { toolUseId: 'toolu_1', error: 'The page did not load.' }),
      { kind: 'result' },
    ]);
    expect(items.map((it) => it.type)).toEqual(['tool', 'subagent', 'tool', 'result']);
    expect(cards(items)[0]).toMatchObject({ status: 'failed', error: 'The page did not load.', toolUseId: 'toolu_1' });
    // The reply ending says nothing about a child: a running one stays running.
    const running = buildThread([card('t3', 'running', { background: true }), { kind: 'result' }]);
    expect(cards(running)[0]).toMatchObject({ status: 'running', background: true });
  });
});

describe('ChatClient and the Mac it talks to', () => {
  function client() {
    const identity = generateIdentity();
    const brain = generateIdentity();
    const brainDeviceId = deriveDeviceId(brain.signPub);
    const c = new ChatClient({ relayUrl: 'http://127.0.0.1:1', accountId: 'acc', deviceId: deriveDeviceId(identity.signPub), identity, brainDeviceId, brainEncPub: b64.encode(brain.encPub) });
    const sent: InnerMessageBody[] = [];
    const internals = c as unknown as { link: { send(to: string, body: InnerMessageBody): boolean }; onMessage(m: { from: string; message: unknown }): void };
    internals.link.send = (_to, body) => (sent.push(body), true);
    const receive = (message: InnerMessageBody) => internals.onMessage({ from: brainDeviceId, message });
    const host = (features?: string[]) => receive({ type: 'host.status', payload: { hostname: 'mac', claudeVersion: '1', executors: [], activeExecutorId: null, workspaces: [], ...(features ? { features } : {}) } as never });
    /** The link to the relay is up again, with the Mac there or not. */
    const reconnect = (brainOnline = true) => (c as unknown as { link: { emit(event: 'ready', roster: unknown[], online: string[]): void } }).link.emit('ready', [], brainOnline ? [brainDeviceId] : []);
    return { c, sent, receive, host, reconnect };
  }

  it('reads a chat again after a reconnect when it shows a child still at work', () => {
    const { c, sent, receive, host, reconnect } = client();
    host([PEER_FEATURES.subagents, PEER_FEATURES.workspaces]);
    receive({ type: 'session.history.result', payload: { sessionId: 'busy', events: [card('t1', 'running', { activity: 'Read a.ts' })] } });
    receive({ type: 'session.history.result', payload: { sessionId: 'quiet', events: [card('t9', 'completed', { result: 'done' })] } });
    let mark = sent.length;
    reconnect(false);
    expect(sent.slice(mark).map((b) => b.type)).toEqual(['status.get']);
    mark = sent.length;
    reconnect();
    expect(sent.slice(mark)).toEqual([
      { type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } },
      { type: 'session.history', payload: { sessionId: 'busy' } },
    ]);
    // The child ended while the phone was away: the card says so, once.
    receive({ type: 'session.history.result', payload: { sessionId: 'busy', events: [card('t1', 'running'), card('t1', 'cancelled', { endedAt: 500, error: 'Stopped: Pocket was restarted on the Mac before this task finished.' })] } });
    expect(cards(c.getState().threads.busy!)).toMatchObject([{ id: 't1', status: 'cancelled', endedAt: 500 }]);
    mark = sent.length;
    reconnect();
    expect(sent.slice(mark).map((b) => b.type)).toEqual(['status.get']);
    c.close();
  });

  it('says what it understands when it asks for the status', () => {
    const { c, sent } = client();
    c.refresh();
    expect(sent).toContainEqual({ type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } });
  });

  it('asks an older Mac for nothing it would not understand', async () => {
    const { c, sent, host } = client();
    host();
    expect(c.supportsWorkspaces).toBe(false);
    await expect(c.loadWorkspace('s')).rejects.toThrow(/too old/);
    await expect(c.previewWorkspace('s')).rejects.toThrow(/too old/);
    await expect(c.resetWorkspace('s', { wipe: true })).rejects.toThrow(/too old/);
    expect(sent.filter((b) => b.type.startsWith('workspace.'))).toEqual([]);
  });

  it('keeps what the Mac reports about the desktops of a chat', async () => {
    const { c, sent, receive, host } = client();
    host([PEER_FEATURES.subagents, PEER_FEATURES.workspaces]);
    expect(c.supportsWorkspaces).toBe(true);
    const loading = c.loadWorkspace('s');
    const asked = sent.find((b) => b.type === 'workspace.get');
    expect(asked).toMatchObject({ payload: { sessionId: 's' } });
    const requestId = (asked as Extract<InnerMessageBody, { type: 'workspace.get' }>).payload.requestId;
    receive({ type: 'workspace.result', payload: { requestId, sessionId: 's', supported: true, computer: { deviceId: 'd', name: 'kali', online: true }, desktops: [{ key: 'main', label: 'Chat', state: 'running', generation: 1 }] } });
    expect((await loading).desktops).toEqual([{ key: 'main', label: 'Chat', state: 'running', generation: 1 }]);
    expect(c.getState().workspaces.s?.computer?.name).toBe('kali');

    const preview = c.previewWorkspace('s', 'task-1');
    const look = sent.find((b) => b.type === 'workspace.preview') as Extract<InnerMessageBody, { type: 'workspace.preview' }>;
    expect(look.payload).toMatchObject({ sessionId: 's', key: 'task-1' });
    receive({ type: 'workspace.preview.result', payload: { requestId: look.payload.requestId, sessionId: 's', key: 'task-1', error: 'This chat has no such desktop right now.' } });
    await expect(preview).rejects.toThrow(/no such desktop/);

    expect(c.cancelSubagent('s', 'task-1')).toBe(true);
    expect(sent.at(-1)).toEqual({ type: 'subagent.cancel', payload: { sessionId: 's', id: 'task-1' } });
    // A chat that is deleted takes what was known about its desktops with it.
    receive({ type: 'session.deleted', payload: { sessionId: 's' } });
    expect(c.getState().workspaces.s).toBeUndefined();
    c.close();
  });
});
