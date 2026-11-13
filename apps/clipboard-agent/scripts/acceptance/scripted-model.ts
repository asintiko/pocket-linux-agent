/**
 * A stand-in for the model behind Claude Code: the Messages API as far as Claude Code uses it, answered from a script
 * instead of by a model. Everything around it stays real in a run: the Claude Code process, its Agent tool and the
 * subagents it starts, its calls to the chat's tools and the questions those raise on the phone. What such a run
 * cannot show is what a real model would choose to do or say.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedRequest {
  /** 'main', the name a subagent was given in its task (`[[agent:name]]`), or 'aside' for a request without tools. */
  who: string;
  /** How many replies the model has given in this conversation so far. */
  turn: number;
  /** What the latest message of the user says, tool results included. */
  last: string;
  toolResults: { id: string; text: string; isError: boolean }[];
  /** Names of the tools the request offers. */
  tools: string[];
  model: string;
}

export interface ScriptedReply {
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
}

export type Script = (request: ScriptedRequest) => ScriptedReply | Promise<ScriptedReply>;

export interface ScriptedModel {
  url: string;
  /** Every request with the reply it got, in order: what the run's report quotes. */
  log: { who: string; turn: number; last: string; toolResults: ScriptedRequest['toolResults']; reply: ScriptedReply }[];
  close(): Promise<void>;
}

interface Block {
  type: string;
  text?: string;
  tool_use_id?: string;
  content?: string | Block[];
  is_error?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string | Block[];
}

const textOf = (content: string | Block[] | undefined): string =>
  typeof content === 'string' ? content : (content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'tool_result' ? textOf(b.content) : b.type === 'image' ? '[image]' : '')).join('\n');

function describe(body: { model?: string; messages?: Message[]; tools?: { name: string }[] }): ScriptedRequest {
  const messages = body.messages ?? [];
  const users = messages.filter((m) => m.role === 'user');
  const lastUser = users.at(-1);
  const named = /\[\[agent:([a-z0-9-]+)\]\]/.exec(textOf(users[0]?.content))?.[1];
  const tools = (body.tools ?? []).map((t) => t.name);
  return {
    who: named ?? (tools.length ? 'main' : 'aside'),
    turn: messages.filter((m) => m.role === 'assistant').length,
    last: textOf(lastUser?.content),
    toolResults: (typeof lastUser?.content === 'string' ? [] : (lastUser?.content ?? [])).filter((b) => b.type === 'tool_result').map((b) => ({ id: b.tool_use_id ?? '', text: textOf(b.content), isError: b.is_error === true })),
    tools,
    model: body.model ?? 'scripted',
  };
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

function contentOf(reply: ScriptedReply): Record<string, unknown>[] {
  return [...(reply.text ? [{ type: 'text', text: reply.text }] : []), ...(reply.tools ?? []).map((t) => ({ type: 'tool_use', id: id('toolu'), name: t.name, input: t.input }))];
}

function send(res: ServerResponse, stream: boolean, model: string, reply: ScriptedReply): void {
  const content = contentOf(reply);
  const stop = reply.tools?.length ? 'tool_use' : 'end_turn';
  const usage = { input_tokens: 12, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: id('msg'), type: 'message', role: 'assistant', model, stop_sequence: null };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': id('req') });
    res.end(JSON.stringify({ ...message, content, stop_reason: stop, usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': id('req') });
  const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      event('content_block_start', { index, content_block: { ...block, input: {} } });
      event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    event('content_block_stop', { index });
  });
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  event('message_stop', {});
  res.end();
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startScriptedModel(script: Script): Promise<ScriptedModel> {
  const log: ScriptedModel['log'] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://model').pathname;
      const body = req.method === 'POST' ? (JSON.parse((await read(req)) || '{}') as Parameters<typeof describe>[0] & { stream?: boolean }) : {};
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const request = describe(body);
        const reply = request.who === 'aside' ? { text: 'ok' } : await script(request);
        log.push({ who: request.who, turn: request.turn, last: request.last.slice(0, 2000), toolResults: request.toolResults.map((t) => ({ ...t, text: t.text.slice(0, 2000) })), reply });
        send(res, body.stream === true, request.model, reply);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `the scripted model has no ${path}` } }));
    })().catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e instanceof Error ? e.message : String(e) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    log,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Points the Claude Code processes this process starts at the scripted model, and at nothing else on the network.
 * The key is a placeholder: no request leaves the machine.
 */
export function useScriptedModel(model: ScriptedModel, env: NodeJS.ProcessEnv = process.env): void {
  env.ANTHROPIC_BASE_URL = model.url;
  env.ANTHROPIC_API_KEY = 'scripted-model-no-key';
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.DISABLE_ERROR_REPORTING = '1';
}
