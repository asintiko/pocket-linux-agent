import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'pocket-codex-test-'));
vi.stubEnv('POCKET_HOME', root);
const { runCodexTurn, withCodex } = await import('../src/codex.js');

const binary = join(root, 'codex-fixture');
beforeAll(() => {
  writeFileSync(binary, `#!${process.execPath}
const assert = require('node:assert/strict');
const readline = require('node:readline');
const path = require('node:path');
const { realpathSync } = require('node:fs');
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.OPENAI_BASE_URL, undefined);
assert.equal(realpathSync(process.env.CODEX_HOME), path.join(path.dirname(__filename), 'codex'));
assert.ok(process.argv.includes('model_provider="openai"'));
assert.ok(process.argv.includes('shell_tool'));
const send = (data) => process.stdout.write(JSON.stringify(data) + '\\n');
const cli = readline.createInterface({ input: process.stdin });
cli.on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => send({ id, result });
  if (method === 'initialize') reply({});
  if (method === 'account/read') {
    const type = process.cwd().endsWith('api-key') ? 'apiKey' : 'chatgpt';
    reply({ account: { type }, requiresOpenaiAuth: true });
  }
  if (method === 'model/list') {
    const options = (levels) => levels.map((reasoningEffort) => ({ reasoningEffort }));
    reply(params.cursor ? {
      data: [{ model: 'gpt-6-luna', displayName: 'GPT-6 Luna', supportedReasoningEfforts: options(['low', 'max']) }],
      nextCursor: null,
    } : {
      data: [{ model: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: true, supportedReasoningEfforts: options(['low', 'max', 'ultra']) }],
      nextCursor: 'next',
    });
  }
  if (method === 'account/rateLimits/read') {
    reply({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 }, secondary: { usedPercent: 30, windowDurationMins: 10080 } } });
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.developerInstructions, 'Keep it short');
    if (method === 'thread/resume') assert.equal(params.threadId, 'codex-thread');
    reply({ thread: { id: 'codex-thread' } });
  }
  if (method === 'turn/start') {
    const { threadId } = params;
    const text = params.input[0].text;
    const notify = (method, data) => send({ method, params: { threadId, ...data } });
    reply({ turn: { id: 'codex-turn' } });
    if (text === 'ultra') {
      assert.equal(params.model, 'gpt-6-astra');
      assert.equal(params.effort, 'ultra');
    }
    if (text === 'max') {
      assert.equal(params.model, 'gpt-6-luna');
      assert.equal(params.effort, 'max');
    }
    if (text === 'cancel') {
      notify('item/agentMessage/delta', { itemId: 'one', delta: 'Working' });
      return;
    }
    if (text === 'quota') {
      notify('turn/completed', { turn: { status: 'failed', error: { message: 'ChatGPT usage limit reached' } } });
      return;
    }
    notify('item/agentMessage/delta', { itemId: 'one', delta: 'Hello ' });
    notify('item/agentMessage/delta', { itemId: 'one', delta: 'there' });
    notify('item/completed', { item: { type: 'agentMessage', id: 'one', text: 'Hello there' } });
    notify('item/completed', { item: { type: 'agentMessage', id: 'two', text: 'Done' } });
    notify('turn/completed', { turn: { status: 'completed' } });
  }
});
`, { mode: 0o700 });
  vi.stubEnv('POCKET_CODEX_PATH', binary);
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  vi.stubEnv('OPENAI_BASE_URL', 'https://fixture.invalid');
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function options(cwd = root, text = 'hello') {
  return {
    cwd,
    text,
    instructions: 'Keep it short',
    signal: new AbortController().signal,
    onThread: vi.fn(),
    onDelta: vi.fn(),
  };
}

describe('Codex subscription provider', () => {
  it('paginates the owner catalog with per-model efforts and quota, keeping old clients compatible', async () => {
    expect(await withCodex([], false)).toEqual([]);
    expect(await withCodex([], true)).toMatchObject([
      { value: 'codex/default', description: 'GPT-6 Astra · 5h 80% left · 7d 70% left' },
      { value: 'codex/gpt-6-astra', efforts: ['low', 'max', 'ultra'] },
      { value: 'codex/gpt-6-luna', efforts: ['low', 'max'] },
    ]);
    expect((await withCodex([], true, false))[1]?.efforts).toEqual(['low', 'max']);
  });

  it('sends the selected model and exact reasoning level, rejecting unavailable options', async () => {
    await runCodexTurn({ ...options(root, 'ultra'), model: 'codex/gpt-6-astra', effort: 'ultra' });
    await runCodexTurn({ ...options(root, 'max'), model: 'codex/gpt-6-luna', effort: 'max', threadId: 'codex-thread' });
    await expect(runCodexTurn({ ...options(), model: 'codex/gpt-6-luna', effort: 'ultra' })).rejects.toThrow('unavailable for GPT-6 Luna');
    await expect(runCodexTurn({ ...options(), model: 'codex/not-in-catalog' })).rejects.toThrow('unavailable for the current Codex account');
  });

  it('starts and resumes a thread, streaming each message without duplication', async () => {
    const turn = options();
    await runCodexTurn(turn);
    expect(turn.onThread).toHaveBeenCalledWith('codex-thread');
    expect(turn.onDelta.mock.calls.flat().join('')).toBe('Hello there\n\nDone');

    const resumed = { ...options(), threadId: 'codex-thread' };
    await runCodexTurn(resumed);
    expect(resumed.onDelta.mock.calls.flat().join('')).toBe('Hello there\n\nDone');
  });

  it('rejects API-key accounts before starting a thread', async () => {
    const cwd = join(root, 'api-key');
    mkdirSync(cwd);
    const turn = options(cwd);
    await expect(runCodexTurn(turn)).rejects.toThrow('Sign in to ChatGPT');
    expect(turn.onThread).not.toHaveBeenCalled();
  });

  it('surfaces the account limit and lets the user abort a stalled turn', async () => {
    const limited = options(root, 'quota');
    await expect(runCodexTurn(limited)).rejects.toThrow('ChatGPT usage limit reached');
    expect(limited.onThread).not.toHaveBeenCalled();

    const controller = new AbortController();
    const turn = { ...options(root, 'cancel'), signal: controller.signal, onDelta: () => controller.abort() };
    await expect(runCodexTurn(turn)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
