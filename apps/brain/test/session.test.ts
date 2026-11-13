import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MAX_SYSTEM_PROMPT_LENGTH, type SessionEvent, type SessionMeta } from '@pocket/protocol';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const base = `${(process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/pocket-session-test-${process.pid}`;
  process.env.POCKET_HOME = `${base}/home`;
  process.env.POCKET_LOG_DIR = `${base}/logs`;
  process.env.POCKET_WORKSPACE = `${base}/workspace`;
  process.env.POCKET_PEOPLE = `${base}/people`;
  process.env.POCKET_SKILLS_DIR = `${base}/no-skills`;
  return { base, home: `${base}/home`, workspace: `${base}/workspace` };
});

const kimi = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importActual) => ({ ...(await importActual<object>()), query: vi.fn() }));
vi.mock('../src/kimi-engine.js', () => ({ KimiEngine: { start: kimi.start } }));

vi.mock('../src/codex.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/codex.js')>()),
  runCodexTurn: vi.fn(),
}));

vi.mock('../src/marketllm.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/marketllm.js')>()),
  runMarketTurn: vi.fn(),
  withMarket: vi.fn(async (models, owner) => owner ? [...models,
    { value: 'marketllm/gpt-6.1-sol', displayName: 'GPT 6.1 Sol', description: 'MarketLLM', efforts: ['low', 'high', 'ultra'] },
    { value: 'marketllm/deepseek-v4-flash', displayName: 'DeepSeek', description: 'MarketLLM', efforts: [] },
  ] : models),
}));

const { runCodexTurn } = await import('../src/codex.js');
const { runMarketTurn } = await import('../src/marketllm.js');
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { Session } = await import('../src/session.js');
const { chatFolder, DEFAULT_MAC_WORKSPACE } = await import('../src/sandbox.js');
type Host = ConstructorParameters<typeof Session>[1];

/** Stands in for the Claude Code process: the test pushes the messages it would stream. */
class StubQuery {
  readonly setModel = vi.fn(async (_model?: string) => {});
  readonly applyFlagSettings = vi.fn(async (_settings: Record<string, unknown>) => {});
  readonly supportedModels = vi.fn(async () => [{ value: 'fable', displayName: 'Fable', description: 'Deepest', supportedEffortLevels: ['low', 'high', 'max'] }]);
  readonly interrupt = vi.fn(async () => undefined);
  private readonly queue: SDKMessage[] = [];
  private waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null;

  constructor(readonly options: Options) {}

  push(msg: Record<string, unknown>): void {
    const m = msg as unknown as SDKMessage;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
    } else this.queue.push(m);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

const RESULT = { type: 'result', subtype: 'success', duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
const settle = () => new Promise((r) => setTimeout(r, 10));

let stub: StubQuery;
const metas: SessionMeta[] = [];
const kimiOptions: unknown[] = [];
const kimiTurns: { type: string; text?: string }[][] = [];
let kimiCounter = 0;

function host(over: Partial<Host> = {}): Host {
  return {
    executorFor: () => ({ id: undefined, online: false, info: null, root: undefined, call: async () => ({ content: '', isError: true }) }),
    pcFor: () => ({ id: undefined, name: undefined, online: false, capabilities: [], clipboardRead: async () => ({}), clipboardWrite: async () => ({}), screenshot: async () => ({}), computer: async () => ({}) }),
    guestRoot: () => undefined,
    userName: () => 'Owner',
    emit: () => {},
    metaChanged: (m) => void metas.push(m),
    canUseTool: async (_s, _t, input) => ({ behavior: 'allow', updatedInput: input }),
    claudeOptions: () => ({}),
    ownerChat: () => true,
    onClaudeVersion: () => {},
    ...over,
  };
}

function newSession(id = 'aaaaaaaa-1111-2222-3333-444444444444', over: Partial<SessionMeta> = {}) {
  const now = Date.UTC(2026, 9, 23, 12);
  return new Session({ sessionId: id, title: 'Test', state: 'idle', createdAt: now, updatedAt: now, userId: 'owner', ...over }, host(), false);
}

const appended = () => (stub.options.systemPrompt as { append?: string }).append ?? '';

beforeEach(() => {
  metas.length = 0;
  kimiOptions.length = 0;
  kimiTurns.length = 0;
  kimiCounter = 0;
  mkdirSync(join(dirs.home, 'sessions'), { recursive: true });
  vi.mocked(query).mockImplementation(({ options }) => {
    stub = new StubQuery(options ?? {});
    return stub as unknown as Query;
  });
  kimi.start.mockReset();
  vi.mocked(runMarketTurn).mockReset();
  kimi.start.mockImplementation(async (...args: unknown[]) => {
    const options = args[0] as { prompt: string; resumeId?: string };
    kimiOptions.push(options);
    return {
      sessionId: options.resumeId ?? `kimi-${++kimiCounter}`,
      prompt: async (content: { type: string; text?: string }[]) => {
        kimiTurns.push(content);
        return { stopReason: 'end_turn' };
      },
      close: () => {},
    };
  });
});

afterAll(() => rmSync(dirs.base, { recursive: true, force: true }));

describe('Claude switching its own model', () => {
  it('gets the chat_* tools in the Mac prompt and allow list', async () => {
    const s = newSession();
    await s.send({ text: 'hi', from: 'phone' });
    expect(stub.options.allowedTools).toEqual(expect.arrayContaining(['mcp__pocket__chat_models', 'mcp__pocket__chat_configure']));
    expect(JSON.stringify(stub.options.systemPrompt)).toMatch(/chat_configure/);
    s.stop();
  });

  it('shows the change at once and applies it to the live process only after the turn', async () => {
    const s = newSession();
    await s.send({ text: 'switch to Fable and think at maximum', from: 'phone' });
    expect(s.meta.state).toBe('running');

    s.configureAfterTurn({ model: 'fable', effort: 'max' });
    expect(s.meta).toMatchObject({ model: 'fable', effort: 'max' });
    expect(metas.at(-1)).toMatchObject({ model: 'fable', effort: 'max' });
    await settle();
    expect(stub.setModel).not.toHaveBeenCalled();
    expect(stub.applyFlagSettings).not.toHaveBeenCalled();

    stub.push(RESULT);
    await settle();
    expect(stub.setModel).toHaveBeenCalledWith('fable');
    expect(stub.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });
    s.stop();
  });

  it('starts the next process with the new model when the old one stopped first', async () => {
    const s = newSession('bbbbbbbb-1111-2222-3333-444444444444');
    await s.send({ text: 'use Fable', from: 'phone' });
    s.configureAfterTurn({ model: 'fable' });
    s.stop();
    const first = stub;
    await s.send({ text: 'again', from: 'phone' });
    expect(stub).not.toBe(first);
    expect(stub.options.model).toBe('fable');
    expect(first.setModel).not.toHaveBeenCalled();
    s.stop();
  });
});

describe('conversation-specific system prompts', () => {
  it('uses updated and cleared prompts on resumed Claude sessions', async () => {
    const s = newSession('chat-prompt', { systemPrompt: '  Use short bullets  ' });
    expect(s.meta.systemPrompt).toBe('Use short bullets');
    await s.send({ text: 'first turn', from: 'phone' });
    const firstEngine = s.meta.engine?.id;
    expect(firstEngine).toBeDefined();
    expect(stub.options.systemPrompt).toMatchObject({ snapshot: false });
    expect(appended()).toContain('Use short bullets');

    await s.configure({ systemPrompt: '  Use a checklist  ' });
    expect(s.meta.systemPrompt).toBe('Use a checklist');
    stub.push(RESULT);
    await settle();

    await s.send({ text: 'second turn', from: 'phone' });
    expect(stub.options.resume).toBe(firstEngine);
    expect(stub.options.systemPrompt).toMatchObject({ snapshot: false });
    expect(appended()).toContain('Use a checklist');
    expect(appended()).not.toContain('Use short bullets');
    const secondEngine = s.meta.engine?.id;
    await s.configure({ systemPrompt: '   ' });
    expect(s.meta.systemPrompt).toBeUndefined();
    stub.push(RESULT);
    await settle();

    await s.send({ text: 'third turn', from: 'phone' });
    expect(stub.options.resume).toBe(secondEngine);
    expect(appended()).not.toContain('Use short bullets');
    expect(appended()).not.toContain('Use a checklist');
    s.stop();
  });

  it('preserves the Kimi conversation across prompt edits, clears, and process restarts', async () => {
    const meta = {
      sessionId: 'kimi-chat',
      title: 'Kimi chat',
      state: 'idle' as const,
      createdAt: Date.UTC(2026, 9, 23, 12),
      updatedAt: Date.UTC(2026, 9, 23, 12),
      userId: 'owner',
      model: 'kimi:kimi-code/k2',
      systemPrompt: 'Original chat rules',
    };
    const cwd = chatFolder(meta);
    const s = new Session({ ...meta, engine: { id: 'kimi-old', cwd } }, host(), false);

    await s.send({ text: 'first turn', from: 'phone' });
    const initial = kimiOptions[0] as { prompt: string; resumeId?: string };
    expect(initial.resumeId).toBe('kimi-old');
    expect(initial.prompt).not.toContain('Original chat rules');
    expect(kimiTurns[0]?.map((block) => block.text)).toEqual([expect.stringContaining('Original chat rules'), 'first turn']);

    await s.configure({ systemPrompt: 'Updated chat rules' });
    expect(s.meta.engine?.id).toBe('kimi-old');
    await s.send({ text: 'second turn', from: 'phone' });
    const updated = kimiOptions[1] as { prompt: string; resumeId?: string };
    expect(updated.resumeId).toBe('kimi-old');
    expect(updated.prompt).not.toContain('Updated chat rules');
    expect(updated.prompt).not.toContain('Original chat rules');
    expect(kimiTurns[1]?.map((block) => block.text)).toEqual([expect.stringContaining('Updated chat rules'), 'second turn']);
    expect(JSON.stringify(kimiTurns[1])).not.toContain('Original chat rules');

    const updatedEngine = s.meta.engine?.id;
    s.stop();
    await s.send({ text: 'resume with the same prompt', from: 'phone' });
    const resumed = kimiOptions[2] as { prompt: string; resumeId?: string };
    expect(resumed.resumeId).toBe(updatedEngine);
    expect(kimiTurns[2]?.[0]?.text).toContain('Updated chat rules');

    await s.configure({ systemPrompt: '' });
    expect(s.meta.systemPrompt).toBeUndefined();
    expect(s.meta.engine?.id).toBe('kimi-old');
    await s.send({ text: 'third turn', from: 'phone' });
    const cleared = kimiOptions[3] as { prompt: string; resumeId?: string };
    expect(cleared.resumeId).toBe('kimi-old');
    expect(cleared.prompt).not.toContain('Original chat rules');
    expect(cleared.prompt).not.toContain('Updated chat rules');
    expect(kimiTurns[3]?.[0]?.text).toContain('No additional conversation-specific instructions');
    expect(JSON.stringify(kimiTurns[3])).not.toContain('Updated chat rules');
    s.stop();
  });

  it('rejects an over-limit prompt without changing saved metadata', async () => {
    const s = newSession('bounded-prompt', { systemPrompt: 'Keep this' });
    await expect(s.configure({ systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1) })).rejects.toThrow(/8000/);
    expect(s.meta.systemPrompt).toBe('Keep this');
    s.stop();
  });

  it('timestamps new durable history and keeps legacy events undated', async () => {
    const emitted: SessionEvent[] = [];
    const now = Date.UTC(2026, 9, 23, 12);
    const id = 'timestamped-history';
    const s = new Session(
      { sessionId: id, title: 'Test', state: 'idle', createdAt: now, updatedAt: now, userId: 'owner' },
      host({ emit: (_sessionId, event) => emitted.push(event) }),
      false,
    );
    await s.send({ text: 'new event', from: 'phone' });
    expect(emitted[0]).toMatchObject({ kind: 'user', at: expect.any(Number) });
    expect(s.history()[0]).toMatchObject({ kind: 'user', at: emitted[0]?.at });
    stub.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fallback response' }] } });
    await vi.waitFor(() => {
      expect(emitted.find((event) => event.kind === 'text_delta')).toMatchObject({ text: 'Fallback response', at: expect.any(Number) });
      expect(s.history().find((event) => event.kind === 'text')).toMatchObject({ text: 'Fallback response', at: expect.any(Number) });
    });
    s.stop();

    const legacyId = 'legacy-history';
    writeFileSync(join(dirs.home, 'sessions', `${legacyId}.jsonl`), `${JSON.stringify({ kind: 'user', text: 'old event', from: 'phone' })}\n`);
    const legacy = newSession(legacyId);
    expect(legacy.history()[0]).not.toHaveProperty('at');
    legacy.stop();
  });

  it('keeps guest workspace restrictions after conversation-specific instructions', async () => {
    const guestRoot = join(dirs.home, 'guest-root');
    const now = Date.UTC(2026, 9, 23, 12);
    const s = new Session(
      { sessionId: 'guest-prompt', title: 'Guest', state: 'idle', createdAt: now, updatedAt: now, userId: 'guest', systemPrompt: 'Use short bullets' },
      host({ guestRoot: () => guestRoot }),
      false,
    );
    await s.send({ text: 'hello', from: 'phone' });
    expect(appended().indexOf('# Conversation-specific instructions')).toBeLessThan(appended().indexOf('# Your own workspace'));
    expect(appended()).toContain('never try to look outside your folder');
    expect(stub.options.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
    s.stop();
  });
});

describe('a sandbox per Mac chat', () => {
  it('gives a new chat its own folder, the Seatbelt sandbox and edits without asking', async () => {
    const s = newSession('feedfacecafe');
    await s.send({ text: 'hi', from: 'phone' });
    const folder = chatFolder(s.meta);
    expect(folder).toBe(`${dirs.workspace}/chats/2026-10-23-feedface`);
    expect(stub.options.cwd).toBe(folder);
    expect(existsSync(folder)).toBe(true);
    expect(s.meta.engine?.cwd).toBe(folder);
    expect(stub.options.permissionMode).toBe('acceptEdits');
    expect(stub.options.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: false });
    expect(appended()).toMatch(/This chat's own folder/);
    expect(appended()).toMatch(/# Sandbox/);
    s.stop();
  });

  it('puts the notes from earlier back into the prompt and keeps attachments in the folder', async () => {
    const s = newSession('notesnotes');
    const folder = chatFolder(s.meta);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'NOTES.md'), 'The user is building a slide deck in deck/.');
    await s.send({ text: 'look', from: 'phone', attachments: [{ mime: 'text/plain', name: 'brief.txt', dataBase64: Buffer.from('brief').toString('base64') }] });
    expect(appended()).toMatch(/## NOTES\.md\nThe user is building a slide deck/);
    expect(readFileSync(join(folder, 'attachments', 'brief.txt'), 'utf8')).toBe('brief');
    s.stop();
  });

  it('leaves chats that already live in the shared folder there, asking for edits as before', async () => {
    const s = newSession('legacychat', { engine: { id: 'old-engine', cwd: DEFAULT_MAC_WORKSPACE } });
    await s.send({ text: 'hi', from: 'phone' });
    expect(stub.options.cwd).toBe(DEFAULT_MAC_WORKSPACE);
    expect(stub.options.resume).toBe('old-engine');
    expect(stub.options.permissionMode).toBe('default');
    expect(appended()).not.toMatch(/own folder/);
    s.stop();
  });

  it('runs without the sandbox when POCKET_SANDBOX=off', async () => {
    process.env.POCKET_SANDBOX = 'off';
    try {
      const s = newSession('nosandbox');
      await s.send({ text: 'hi', from: 'phone' });
      expect(stub.options.sandbox).toBeUndefined();
      expect(appended()).not.toMatch(/# Sandbox/);
      s.stop();
    } finally {
      delete process.env.POCKET_SANDBOX;
    }
  });
});

describe('Codex session routing', () => {
  it('persists its own thread and records partial text before a provider error', async () => {
    const session = newSession('codex-chat', { systemPrompt: 'Short answers' });
    vi.mocked(runCodexTurn).mockImplementationOnce(async ({ onThread }) => { onThread('codex-thread'); });
    await session.configure({ model: 'codex/default' });
    await session.send({ text: 'hello', from: 'phone' });
    expect(session.meta).toMatchObject({ codexThreadId: 'codex-thread', state: 'idle' });
    expect(session.meta.engine).toBeUndefined();

    vi.mocked(runCodexTurn).mockImplementationOnce(async ({ onDelta }) => {
      onDelta('Partial answer');
      throw new Error('ChatGPT usage limit reached');
    });
    await session.send({ text: 'again', from: 'phone' });
    expect(session.history().map(({ kind }) => kind)).toEqual(['user', 'result', 'user', 'text', 'error']);
    expect(runCodexTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: 'codex-thread', instructions: 'Short answers', text: 'again',
    }));
  });

  it('rejects forged Codex selection and sends from a guest', async () => {
    const ownerSession = newSession('guest-codex');
    const guest = new Session(ownerSession.meta, host({ ownerChat: () => false }), false);
    await expect(guest.configure({ model: 'codex/default' })).rejects.toThrow('Only the owner');
    const restored = new Session({ ...guest.meta, model: 'codex/default' }, host({ ownerChat: () => false }), true);
    await expect(restored.send({ text: 'hello', from: 'phone' })).rejects.toThrow('Only the owner');
    expect(restored.history()).toEqual([]);
  });
});

describe('MarketLLM session routing', () => {
  it('validates model reasoning and clears stale effort on a model switch', async () => {
    const session = newSession('market-config', { model: 'opus', effort: 'max' });
    await session.configure({ model: 'marketllm/gpt-6.1-sol', effort: 'ultra' });
    expect(session.meta).toMatchObject({ model: 'marketllm/gpt-6.1-sol', codexEffort: 'ultra' });
    expect(session.meta.effort).toBeUndefined();
    await expect(session.configure({ effort: 'medium' })).rejects.toThrow('does not support');
    expect(session.meta.codexEffort).toBe('ultra');
    await session.configure({ model: 'marketllm/deepseek-v4-flash' });
    expect(session.meta.effort).toBeUndefined();
    expect(session.meta.codexEffort).toBeUndefined();
    await expect(session.configure({ model: 'marketllm/unavailable' })).rejects.toThrow('unavailable');
    expect(session.meta.model).toBe('marketllm/deepseek-v4-flash');
  });

  it('rejects paid-key selection and restored sends from another person', async () => {
    const guest = new Session(newSession('market-guest').meta, host({ ownerChat: () => false }), false);
    await expect(guest.configure({ model: 'marketllm/gpt-6.1-sol' })).rejects.toThrow('Only the owner');
    expect(() => guest.configureAfterTurn({ model: 'marketllm/gpt-6.1-sol' })).toThrow('Only the owner');
    const restored = new Session({ ...guest.meta, model: 'marketllm/gpt-6.1-sol' }, host({ ownerChat: () => false }), true);
    await expect(restored.send({ text: 'hello', from: 'phone' })).rejects.toThrow('Only the owner');
    expect(restored.history()).toEqual([]);
    expect(runMarketTurn).not.toHaveBeenCalled();
  });

  it('records provider text before an error and success usage without duplicating text', async () => {
    const session = newSession('market-events', { model: 'marketllm/gpt-6.1-sol' });
    vi.mocked(runMarketTurn).mockImplementationOnce(async ({ emit }) => {
      emit({ kind: 'text_delta', text: 'Partial' });
      emit({ kind: 'text', text: 'Partial' });
      throw new Error('MarketLLM quota reached');
    });
    await session.send({ text: 'first', from: 'phone' });
    expect(session.history().map(({ kind }) => kind)).toEqual(['user', 'text', 'error']);
    expect(session.meta).toMatchObject({ state: 'idle', lastText: 'Partial' });
    vi.mocked(runMarketTurn).mockImplementationOnce(async ({ emit }) => {
      emit({ kind: 'text', text: 'Done' });
      return { inputTokens: 31, outputTokens: 4 };
    });
    await session.send({ text: 'second', from: 'phone' });
    expect(session.history().at(-1)).toMatchObject({ kind: 'result', inputTokens: 31, outputTokens: 4 });
    expect(session.meta.lastText).toBe('Done');
    expect(session.meta.engine).toBeUndefined();
  });

  it('reuses remote handlers and asks the phone for dangerous operations', async () => {
    const call = vi.fn(async () => ({ content: 'Started with id process-1.', isError: false }));
    const permission = vi.fn<Host['canUseTool']>(async (_id, _name, input) => ({ behavior: 'allow', updatedInput: input }));
    const meta = newSession('market-tools', { model: 'marketllm/gpt-6.1-sol', project: '/project' }).meta;
    const session = new Session(meta, host({
      executorFor: () => ({ id: 'linux', online: true, root: '/project', info: { workspaces: ['/project'], os: 'linux', shell: 'bash' }, call }),
      canUseTool: permission,
    }), false);
    vi.mocked(runMarketTurn).mockImplementationOnce(async ({ tools, canUseTool, emit, signal, instructions }) => {
      expect(instructions).toContain('linux');
      expect(instructions).not.toContain('mcp__pocket__');
      const input = { command: 'sleep 1', run_in_background: true };
      expect(await canUseTool('Read', { file_path: 'src/main.ts' })).toMatchObject({ behavior: 'allow' });
      expect(permission).not.toHaveBeenCalled();
      expect(await canUseTool('computer', { action: 'screenshot' })).toMatchObject({ behavior: 'allow' });
      expect(await canUseTool('Bash', input)).toMatchObject({ behavior: 'allow' });
      emit({ kind: 'tool_use', id: 'command', name: 'Bash', input });
      expect(session.runningTools()).toMatchObject([{ id: 'command', name: 'run_command' }]);
      await tools.find((definition) => definition.name === 'Bash')!.handler(input, undefined);
      expect(call).toHaveBeenCalledWith('run_command', { command: 'sleep 1', background: true }, expect.objectContaining({ signal }));
      emit({ kind: 'tool_result', id: 'command', content: 'Started', isError: false });
      expect(session.runningTools()).toEqual([]);
      return { inputTokens: 10, outputTokens: 2 };
    });
    await session.send({ text: 'work', from: 'phone' });
    expect(permission.mock.calls.map((args) => args[1])).toEqual(['mcp__pocket__computer', 'mcp__pocket__Bash']);
    expect(session.backgroundTasks()).toMatchObject([{ id: 'process-1' }]);
    session.stop();
  });

  it('aborts a running turn before switching providers and preserves partial text', async () => {
    const session = newSession('market-abort', { model: 'marketllm/gpt-6.1-sol' });
    vi.mocked(runMarketTurn).mockImplementationOnce(({ signal, emit }) => new Promise((_, reject) => {
      emit({ kind: 'text_delta', text: 'Before stop' });
      signal.addEventListener('abort', () => {
        emit({ kind: 'text', text: 'Before stop' });
        reject(signal.reason);
      }, { once: true });
    }));
    const pending = session.send({ text: 'hello', from: 'phone' });
    expect(session.live).toBe(true);
    await expect(session.configure({ model: 'codex/default' })).rejects.toThrow('finish the current turn');
    session.stop();
    expect(session.live).toBe(false);
    await pending;
    expect(session.history().map(({ kind }) => kind)).toEqual(['user', 'text']);
    expect(session.meta.state).toBe('idle');
    await session.configure({ model: 'codex/default' });
    expect(session.meta.model).toBe('codex/default');
  });

  it('separates computer history and denies a tool after the active computer changes', async () => {
    let computer = 'first';
    const baseHost = host();
    const session = new Session(newSession('market-scope', { model: 'marketllm/gpt-6.1-sol' }).meta, host({
      pcFor: () => ({ ...baseHost.pcFor('unused'), id: computer }),
    }), false);
    const scopes: string[] = [];
    vi.mocked(runMarketTurn).mockImplementationOnce(async ({ scope, canUseTool }) => {
      scopes.push(scope);
      computer = 'second';
      expect(await canUseTool('pc_clipboard_read', {})).toMatchObject({ behavior: 'deny' });
      return {};
    }).mockImplementationOnce(async ({ scope }) => { scopes.push(scope); return {}; });
    await session.send({ text: 'first computer', from: 'phone' });
    await session.send({ text: 'second computer', from: 'phone' });
    expect(scopes[0]).not.toBe(scopes[1]);
  });

  it('times out the same signal used for tools and clears its deadline', async () => {
    vi.useFakeTimers();
    try {
      const permission = vi.fn<Host['canUseTool']>(async (_id, _name, _input, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const session = new Session(newSession('market-timeout', { model: 'marketllm/gpt-6.1-sol' }).meta, host({ canUseTool: permission }), false);
      vi.mocked(runMarketTurn).mockImplementationOnce(async ({ canUseTool }) => {
        await canUseTool('computer', { action: 'screenshot' });
        return {};
      });
      const pending = session.send({ text: 'screen', from: 'phone' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await pending;
      expect(permission.mock.calls[0]?.[3].aborted).toBe(true);
      expect(session.history().at(-1)).toMatchObject({ kind: 'error', message: 'MarketLLM reply timed out after 10 minutes.' });
      expect(session.meta.state).toBe('idle');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a tool-requested model change until the current MarketLLM turn finishes', async () => {
    const session = newSession('market-deferred', { model: 'marketllm/gpt-6.1-sol', codexEffort: 'ultra' });
    vi.mocked(runMarketTurn).mockImplementationOnce(async ({ tools }) => {
      const configure = tools.find((definition) => definition.name === 'chat_configure')!;
      const result = await configure.handler({ model: 'marketllm/deepseek-v4-flash', effort: 'auto' }, undefined);
      expect(result.isError).not.toBe(true);
      expect(session.meta.model).toBe('marketllm/gpt-6.1-sol');
      return {};
    });
    await session.send({ text: 'switch model', from: 'phone' });
    expect(session.meta).toMatchObject({ model: 'marketllm/deepseek-v4-flash', state: 'idle' });
    expect(session.meta.codexEffort).toBeUndefined();
  });
});
