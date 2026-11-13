import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@pocket/protocol';

const testKey = 'market-test-key';
let home: string;
let provider: typeof import('../src/marketllm.js');
const fetchMock = vi.fn();
const catalogue = {
  data: [
    { id: 'gpt-6-astra', display_name: 'Astra', supports_vision: true },
    { id: 'deepseek-v4-flash', display_name: 'DeepSeek' },
    { id: 'gpt-image-2', output_modalities: ['image'] },
  ],
  models: [{ slug: 'gpt-6-astra', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] }],
};

function stream(chunks: object[], terminated = true) {
  const data = chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\r\n\r\n').join('') + (terminated ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const reply = () => stream([
  { choices: [{ delta: { content: 'Привет' }, finish_reason: null }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]);

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'pocket-market-test-'));
  mkdirSync(join(home, 'sessions'));
  writeFileSync(join(home, 'marketllm-api-key'), testKey, { mode: 0o600 });
  vi.stubEnv('POCKET_HOME', home);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/models') ? Response.json(catalogue) : reply());
  provider = await import('../src/marketllm.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function options() {
  const events: SessionEvent[] = [];
  return {
    sessionId: 'test-chat', scope: 'pc-a', instructions: 'Be concise', model: 'marketllm/gpt-6-astra',
    text: 'hello', tools: [], signal: new AbortController().signal,
    emit: (event: SessionEvent) => { events.push(event); },
    canUseTool: vi.fn(async (_name: string, input: Record<string, unknown>) => ({ behavior: 'allow' as const, updatedInput: input })),
    events,
  };
}

describe('MarketLLM provider', () => {
  it('shows only owner-accessible conversation models and advertised effort levels', async () => {
    expect(await provider.withMarket([], false)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    const models = await provider.withMarket([], true);
    expect(models.map((model) => model.value)).toEqual(['marketllm/gpt-6-astra', 'marketllm/deepseek-v4-flash']);
    expect(models[0]?.efforts).toEqual(['low', 'ultra']);
    expect(models[1]?.efforts).toEqual([]);
    expect((await provider.withMarket([], true, false))[0]?.efforts).toEqual(['low']);
  });

  it('reads token balance using a private short-lived portal session', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return Response.json(catalogue);
      if (url.endsWith('/login')) {
        expect(JSON.parse(String(init?.body))).toEqual({ key: testKey });
        return Response.json({ ok: true }, { headers: { 'set-cookie': 'portal=fixture; HttpOnly; Secure' } });
      }
      expect(init?.headers).toMatchObject({ cookie: 'portal=fixture' });
      return Response.json(url.endsWith('/balance') ? { token_balance: 123456 } : { ok: true });
    });
    const models = await provider.withMarket([], true);
    expect(models[0]?.description).toBe('MarketLLM · 123,456 tokens left');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/logout'))).toBe(true);
  });

  it('streams split UTF-8/SSE, preserves exact usage and resumes independent chat history', async () => {
    const turn = options();
    await expect(provider.runMarketTurn(turn)).resolves.toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(turn.events.filter((event) => event.kind === 'text')).toEqual([{ kind: 'text', text: 'Привет' }]);
    await provider.runMarketTurn({ ...turn, text: 'again', effort: 'ultra' });
    const sent = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(sent.model).toBe('gpt-6-astra');
    expect(sent.reasoning_effort).toBe('ultra');
    expect(sent.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it('keeps tool results together before tool images and totals usage across rounds', async () => {
    let round = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/models')) return Response.json(catalogue);
      round++;
      if (round > 1) return reply();
      return stream([
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'shot', function: { name: 'pc_screenshot', arguments: '{}' } },
          { index: 1, id: 'read', function: { name: 'pc_read', arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 7 } },
      ]);
    });
    const turn = options();
    await expect(provider.runMarketTurn({
      ...turn,
      tools: [
        { name: 'pc_screenshot', description: 'screen', inputSchema: {}, handler: async () => ({ content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }) },
        { name: 'pc_read', description: 'read', inputSchema: {}, handler: async () => ({ content: [{ type: 'text', text: 'clipboard' }] }) },
      ],
    })).resolves.toEqual({ inputTokens: 32, outputTokens: 10 });
    const sent = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(sent.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(turn.canUseTool).toHaveBeenCalledTimes(2);
  });

  it('repairs interrupted tool batches before appending the next user message', async () => {
    const turn = options();
    writeFileSync(join(home, 'sessions/test-chat.marketllm.json'), JSON.stringify({
      scope: 'pc-a',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'same-id', type: 'function', function: { name: 'computer', arguments: '{}' } }] },
      ],
    }));
    await provider.runMarketTurn(turn);
    const stored = JSON.parse(readFileSync(join(home, 'sessions/test-chat.marketllm.json'), 'utf8'));
    expect(stored.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'same-id', content: expect.stringContaining('cancelled') });
    expect(turn.canUseTool).not.toHaveBeenCalled();
  });

  it('finalizes partial text before surfacing a truncated stream and retries only pre-response gateway failures', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/models')) return Response.json(catalogue);
      if (url.startsWith('https://api.')) return new Response('temporarily down', { status: 503 });
      return stream([{ choices: [{ delta: { content: 'Partial' }, finish_reason: null }] }], false);
    });
    const turn = options();
    await expect(provider.runMarketTurn(turn)).rejects.toThrow('before the reply completed');
    expect(turn.events.at(-1)).toEqual({ kind: 'text', text: 'Partial' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(2);
  });
});
