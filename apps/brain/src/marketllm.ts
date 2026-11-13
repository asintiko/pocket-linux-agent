import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionResult, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { type Effort, type ModelInfo, type SessionEvent } from '@pocket/protocol';
import { z } from 'zod';
import { paths } from './store.js';

const PREFIX = 'marketllm/';
const BASE_URLS = ['https://api.marketllmapi.ru/v1', 'https://reserve.marketllmapi.ru/v1'];
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const keyPath = () => join(paths.home, 'marketllm-api-key');

export const isMarketModel = (model: string | null | undefined): boolean => model?.startsWith(PREFIX) ?? false;

interface MarketModel {
  id: string;
  display_name?: string;
  output_modalities?: string[];
  context_window?: number;
  supports_vision?: boolean;
}
interface Catalogue {
  data: MarketModel[];
  models?: { slug: string; supported_reasoning_levels?: { effort: string }[] }[];
}
interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type Content = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: Content | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface MarketTurn {
  sessionId: string;
  scope: string;
  instructions: string;
  model: string;
  effort?: Effort;
  text: string;
  images?: { mime: string; dataBase64: string }[];
  tools: SdkMcpToolDefinition<any>[];
  signal: AbortSignal;
  emit(event: SessionEvent): void;
  canUseTool(name: string, input: Record<string, unknown>): Promise<PermissionResult>;
}

function readKey(): string | undefined {
  try {
    return readFileSync(keyPath(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const key = readKey();
  if (!key) throw new Error('The MarketLLM key is missing on the host.');
  let failure = 'MarketLLM is unavailable.';
  for (const base of BASE_URLS) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(base + path, {
        ...init,
        redirect: 'error',
        headers: { ...init.headers, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      failure = error instanceof Error ? error.message : 'Network request failed';
      continue;
    }
    if (response.ok) return response;
    const raw = await response.text();
    let message = `MarketLLM returned HTTP ${response.status}.`;
    try {
      const body = JSON.parse(raw);
      message = body.error?.message ?? body.message ?? message;
    } catch {}
    failure = String(message).replaceAll(key, '[redacted]').slice(0, 500);
    if (![502, 503, 504].includes(response.status)) throw new Error(failure);
  }
  throw new Error(failure.replaceAll(key, '[redacted]'));
}

async function tokenBalance(): Promise<number | undefined> {
  const key = readKey();
  if (!key) return undefined;
  for (const api of BASE_URLS) {
    const origin = new URL(api).origin;
    const signal = AbortSignal.timeout(5_000);
    try {
      const login = await fetch(origin + '/portal/api/login', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', 'x-portal-request': '1', origin },
        body: JSON.stringify({ key }),
      });
      if (!login.ok) continue;
      const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      const authenticated = await login.json() as { ok?: boolean };
      if (!authenticated.ok || !cookie) continue;
      try {
        const response = await fetch(origin + '/portal/api/balance', {
          redirect: 'error', signal, headers: { cookie, 'x-portal-request': '1' },
        });
        if (!response.ok) continue;
        const result = await response.json() as { token_balance?: number };
        if (typeof result.token_balance === 'number' && Number.isFinite(result.token_balance)) return Math.max(0, result.token_balance);
      } finally {
        await fetch(origin + '/portal/api/logout', {
          method: 'POST', redirect: 'error', signal,
          headers: { cookie, 'content-type': 'application/json', 'x-portal-request': '1', origin },
          body: '{}',
        }).catch(() => undefined);
      }
    } catch {}
  }
  return undefined;
}

let cached: { key: string; expires: number; value: Promise<Catalogue> } | undefined;

function catalogue(): Promise<Catalogue> {
  const key = readKey() ?? '';
  if (cached && cached.key === key && cached.expires > Date.now()) return cached.value;
  const value = request('/models', { method: 'GET' }, AbortSignal.timeout(10_000)).then((response) => response.json() as Promise<Catalogue>);
  cached = { key, expires: Date.now() + 60_000, value };
  void value.catch(() => { if (cached?.value === value) cached = undefined; });
  return value;
}

let cachedBalance: { key: string; expires: number; value: Promise<number | undefined> } | undefined;

function balance(): Promise<number | undefined> {
  const key = readKey() ?? '';
  if (cachedBalance && cachedBalance.key === key && cachedBalance.expires > Date.now()) return cachedBalance.value;
  const value = tokenBalance();
  cachedBalance = { key, expires: Date.now() + 60_000, value };
  return value;
}

function levelsFor(model: string, data: Catalogue): Effort[] {
  const levels = data.models?.find((entry) => entry.slug === model)?.supported_reasoning_levels ?? [];
  return EFFORTS.filter((effort) => levels.some((level) => level.effort === effort));
}

export async function withMarket(models: readonly ModelInfo[], owner: boolean, supportsUltra = true): Promise<ModelInfo[]> {
  const rest = models.filter((model) => !isMarketModel(model.value));
  if (!owner || !readKey()) return rest;
  const [available, remaining] = await Promise.all([catalogue().catch(() => undefined), balance()]);
  if (!available) return rest;
  return [...rest, ...available.data.filter((model) => !model.output_modalities?.includes('image')).map((model) => ({
    value: PREFIX + model.id,
    displayName: model.display_name ?? model.id,
    description: remaining !== undefined
      ? `MarketLLM · ${remaining.toLocaleString('en-US')} tokens left`
      : 'MarketLLM',
    efforts: levelsFor(model.id, available).filter((level) => supportsUltra || level !== 'ultra'),
  }))];
}

interface Chunk {
  error?: { message: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: {
    delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
}

async function completion(response: Response, emit: MarketTurn['emit']): Promise<{ message: Message; usage: Usage }> {
  if (!response.body) throw new Error('MarketLLM returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finished = false;
  const calls = new Map<number, ToolCall>();
  const usage: Usage = {};
  const consume = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data) as Chunk;
    if (chunk.error) throw new Error(chunk.error.message);
    if (chunk.usage?.prompt_tokens !== undefined) usage.inputTokens = chunk.usage.prompt_tokens;
    if (chunk.usage?.completion_tokens !== undefined) usage.outputTokens = chunk.usage.completion_tokens;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finished = true;
    if (choice?.delta?.content) {
      text += choice.delta.content;
      emit({ kind: 'text_delta', text: choice.delta.content });
    }
    for (const delta of choice?.delta?.tool_calls ?? []) {
      const call = calls.get(delta.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
      if (delta.id) call.id = delta.id;
      if (delta.function?.name) call.function.name += delta.function.name;
      if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
      calls.set(delta.index, call);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!finished) throw new Error('The MarketLLM stream ended before the reply completed. Try again.');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some((call) => !call.id || !call.function.name)) throw new Error('MarketLLM returned an incomplete tool call.');
    return {
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      usage,
    };
  } finally {
    if (text) emit({ kind: 'text', text });
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function runMarketTurn(turn: MarketTurn): Promise<Usage> {
  const signal = turn.signal;
  const data = await catalogue();
  signal.throwIfAborted();
  const selected = turn.model.slice(PREFIX.length);
  const model = data.data.find((entry) => entry.id === selected && !entry.output_modalities?.includes('image'));
  if (!model) throw new Error('This MarketLLM model is unavailable. Refresh the model list.');
  if (turn.effort && !levelsFor(selected, data).includes(turn.effort)) throw new Error('This reasoning level is unavailable for the selected MarketLLM model.');
  if (turn.images?.length && !model.supports_vision) throw new Error('This MarketLLM model does not accept images. Choose a vision model.');

  const file = join(paths.sessionsDir, `${turn.sessionId}.marketllm.json`);
  let messages: Message[] = [];
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { scope: string; messages: Message[] };
    if (stored.scope === turn.scope) messages = stored.messages;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const persist = () => {
    const temporary = file + '.tmp';
    writeFileSync(temporary, JSON.stringify({ scope: turn.scope, messages }), { mode: 0o600 });
    renameSync(temporary, file);
  };
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) pending.set(call.id, call);
    if (message.role === 'tool' && message.tool_call_id) pending.delete(message.tool_call_id);
  }
  for (const call of pending.values()) {
    messages.push({ role: 'tool', tool_call_id: call.id, content: 'The previous turn was interrupted. This tool call was cancelled.' });
  }
  const content: Content = turn.images?.length
    ? [{ type: 'text', text: turn.text }, ...turn.images.map((image) => ({ type: 'image_url' as const, image_url: { url: `data:${image.mime};base64,${image.dataBase64}` } }))]
    : turn.text;
  messages.push({ role: 'user', content });
  persist();
  const definitions = new Map(turn.tools.map((tool) => [tool.name, tool]));
  const tools = turn.tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(z.object(tool.inputSchema)) },
  }));
  const usage: Usage = {};
  for (;;) {
    signal.throwIfAborted();
    const response = await request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: selected,
        messages: [{ role: 'system', content: turn.instructions }, ...messages],
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length ? { tools } : {}),
        ...(turn.effort ? { reasoning_effort: turn.effort } : {}),
      }),
    }, signal);
    let finalText = '';
    let result: Awaited<ReturnType<typeof completion>>;
    try {
      result = await completion(response, (event) => {
        if (event.kind === 'text') finalText = event.text;
        turn.emit(event);
      });
    } catch (error) {
      if (finalText) {
        messages.push({ role: 'assistant', content: finalText });
        persist();
      }
      throw error;
    }
    for (const key of ['inputTokens', 'outputTokens'] as const) {
      if (result.usage[key] !== undefined) usage[key] = (usage[key] ?? 0) + result.usage[key]!;
    }
    messages.push(result.message);
    persist();
    if (!result.message.tool_calls?.length) return usage;
    const imageParts: Exclude<Content, string> = [];
    for (const call of result.message.tool_calls) {
      signal.throwIfAborted();
      let input: Record<string, unknown> = {};
      let output: { content: any[]; isError?: boolean };
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object.');
        input = parsed as Record<string, unknown>;
        turn.emit({ kind: 'tool_use', id: call.id, name: call.function.name, input });
        const definition = definitions.get(call.function.name);
        if (!definition) throw new Error('This tool is unavailable.');
        const allowed = await turn.canUseTool(call.function.name, input);
        if (allowed.behavior !== 'allow') throw new Error(allowed.message);
        signal.throwIfAborted();
        const args = z.object(definition.inputSchema).parse(allowed.updatedInput ?? input);
        output = await definition.handler(args, undefined);
      } catch (error) {
        if (signal.aborted) throw error;
        output = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
      const texts = output.content.filter((part) => part.type === 'text').map((part) => String(part.text));
      const images = output.content.filter((part) => part.type === 'image');
      if (images.length && !model.supports_vision) {
        texts.push('The tool captured an image, but this model cannot view images. Choose a vision model.');
        output.isError = true;
      }
      const summary = texts.join('\n') || (images.length ? 'Screenshot attached.' : 'Tool completed.');
      messages.push({ role: 'tool', tool_call_id: call.id, content: summary });
      if (model.supports_vision && images.length) {
        imageParts.push({ type: 'text', text: `Image returned by tool ${call.id}.` }, ...images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })));
      }
      persist();
      turn.emit({ kind: 'tool_result', id: call.id, content: summary, isError: output.isError === true });
    }
    if (imageParts.length) {
      messages.push({ role: 'user', content: imageParts });
      persist();
    }
  }
}
