import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Effort, ModelInfo } from '@pocket/protocol';
import { paths } from './store.js';

const CODEX_PREFIX = 'codex/';
const CODEX_AUTO = `${CODEX_PREFIX}default`;
const CODEX_HOME = join(paths.home, 'codex');
const SIGN_IN = 'Sign in to ChatGPT on the host with CODEX_HOME="${POCKET_HOME:-$HOME/.pocket-claude}/codex" codex login.';
const TURN_TIMEOUT_MS = 10 * 60_000;
const CATALOG_TTL_MS = 30_000;
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export const isCodexModel = (model: string | null | undefined) => model?.startsWith(CODEX_PREFIX) ?? false;

interface CatalogModel {
  model: string;
  displayName: string;
  isDefault?: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}

interface LimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
}

interface Limits {
  primary?: LimitWindow | null;
  secondary?: LimitWindow | null;
}

interface Catalog {
  models: CatalogModel[];
  limits?: Limits;
}

let catalogCache: { expiresAt: number; value: Promise<Catalog> } | undefined;

function catalog(): Promise<Catalog> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.value;
  const value = withCodexServer(paths.home, AbortSignal.timeout(10_000), async ({ request }) => {
    const models = await readModels(request);
    const limits = await request<{ rateLimits?: Limits; rateLimitsByLimitId?: Record<string, Limits> }>(
      'account/rateLimits/read',
    ).then((result) => result.rateLimitsByLimitId?.codex ?? result.rateLimits).catch(() => undefined);
    return { models, limits };
  });
  catalogCache = { expiresAt: Date.now() + CATALOG_TTL_MS, value };
  void value.catch(() => {
    if (catalogCache?.value === value) catalogCache = undefined;
  });
  return value;
}

function effortsFor(model: CatalogModel): Effort[] {
  return EFFORTS.filter((effort) => model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort));
}

function quotaLabel(limits: Limits | undefined): string {
  const windows = [limits?.primary, limits?.secondary].filter((window): window is LimitWindow => !!window);
  return windows.map(({ usedPercent, windowDurationMins }) => {
    const minutes = windowDurationMins ?? 0;
    const window = minutes && minutes % 1440 === 0 ? `${minutes / 1440}d`
      : minutes && minutes % 60 === 0 ? `${minutes / 60}h` : minutes ? `${minutes}m` : 'Quota';
    return `${window} ${Math.max(0, Math.min(100, Math.round(100 - usedPercent)))}% left`;
  }).join(' · ');
}

export async function withCodex(models: ModelInfo[], owner: boolean, supportsUltra = true): Promise<ModelInfo[]> {
  if (!owner) return models;
  const discovered = await catalog().catch(() => undefined);
  if (!discovered?.models.length) return models;
  const { models: available, limits } = discovered;
  const defaultModel = available.find((model) => model.isDefault) ?? available[0]!;
  const levels = (model: CatalogModel) => effortsFor(model).filter((level) => supportsUltra || level !== 'ultra');
  const quota = quotaLabel(limits);
  return [
    ...models,
    { value: CODEX_AUTO, displayName: 'Codex Auto', description: [defaultModel.displayName, quota].filter(Boolean).join(' · '), efforts: levels(defaultModel) },
    ...available.map((model) => ({
      value: CODEX_PREFIX + model.model,
      displayName: model.displayName,
      description: 'Codex · ChatGPT plan',
      efforts: levels(model),
    })),
  ];
}

interface WireMessage {
  id?: number | string;
  method?: string;
  error?: { message: string };
  result?: unknown;
  params?: {
    threadId?: string;
    itemId?: string;
    delta?: string;
    item?: { type: string; id: string; text?: string };
    turn?: { status: string; error?: { message: string } };
  };
}

interface CodexTurn {
  cwd: string;
  threadId?: string;
  instructions?: string;
  model?: string;
  effort?: Effort;
  text: string;
  signal: AbortSignal;
  onThread: (id: string) => void;
  onDelta: (text: string) => void;
}

type Request = <T>(method: string, params?: object) => Promise<T>;

async function readModels(request: Request): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: CatalogModel[]; nextCursor: string | null } = await request('model/list', {
      cursor, includeHidden: false,
    });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}

async function withCodexServer<T>(
  cwd: string,
  signal: AbortSignal,
  operation: (rpc: {
    request: Request;
    receive: () => Promise<void>;
    subscribe: (listener: (message: WireMessage) => void) => void;
  }) => Promise<T>,
): Promise<T> {
  const localBin = join(CODEX_HOME, 'bin', 'codex');
  const binary = process.env.POCKET_CODEX_PATH || (existsSync(localBin) ? localBin : 'codex');
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { CODEX_HOME };
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) {
    env[name] = process.env[name];
  }

  const child = spawn(binary, [
    'app-server', '--listen', 'stdio://',
    '-c', 'model_provider="openai"',
    '-c', 'mcp_servers={}',
    '-c', 'web_search="disabled"',
    '--disable', 'shell_tool',
    '--disable', 'plugins',
    '--disable', 'remote_plugin',
    '--disable', 'hooks',
    '--disable', 'multi_agent',
  ], { cwd, env, signal, stdio: ['pipe', 'pipe', 'ignore'] });
  let processError: Error | undefined;
  child.on('error', (error) => { processError = error; });
  child.stdin.on('error', (error) => { processError = error; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const reader = lines[Symbol.asyncIterator]();
  let nextId = 0;

  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
  const read = async (): Promise<WireMessage> => {
    const line = await reader.next();
    if (!line.done) return JSON.parse(line.value) as WireMessage;
    signal.throwIfAborted();
    if ((processError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error('Codex CLI was not found on the host. Install it or set POCKET_CODEX_PATH.');
    }
    throw new Error('Codex app-server exited unexpectedly. Check the CLI installation on the host.');
  };

  const rejectServerRequest = (message: WireMessage): boolean => {
    if (message.method === undefined || message.id === undefined) return false;
    send({ id: message.id, error: { code: -32601, message: 'Pocket does not support this request.' } });
    return true;
  };

  let onNotification: (message: WireMessage) => void = () => {};
  const request: Request = async <T>(method: string, params?: object): Promise<T> => {
    const id = ++nextId;
    send({ method, id, params });
    for (;;) {
      const message = await read();
      if (rejectServerRequest(message)) continue;
      if (message.id === id) {
        if (message.error) throw new Error(message.error.message);
        return message.result as T;
      }
      onNotification(message);
    }
  };

  try {
    await request('initialize', { clientInfo: { name: 'pocket', title: 'Pocket', version: '0.1.0' } });
    send({ method: 'initialized' });
    const { account, requiresOpenaiAuth } = await request<{
      account: { type: string } | null;
      requiresOpenaiAuth: boolean;
    }>('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt' || !requiresOpenaiAuth) throw new Error(SIGN_IN);
    return await operation({
      request,
      receive: async () => {
        const message = await read();
        if (!rejectServerRequest(message)) onNotification(message);
      },
      subscribe: (listener) => { onNotification = listener; },
    });
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export async function runCodexTurn(turn: CodexTurn): Promise<void> {
  const signal = AbortSignal.any([turn.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
  await withCodexServer(turn.cwd, signal, async ({ request, receive, subscribe }) => {
    const selected = turn.model?.startsWith(CODEX_PREFIX) && turn.model !== CODEX_AUTO
      ? turn.model.slice(CODEX_PREFIX.length) : undefined;
    const models = await readModels(request);
    const model = selected ? models.find((entry) => entry.model === selected)
      : models.find((entry) => entry.isDefault) ?? models[0];
    if (!model) throw new Error('This model is unavailable for the current Codex account. Choose another model.');
    if (turn.effort && !effortsFor(model).includes(turn.effort)) {
      throw new Error(`The ${turn.effort} reasoning level is unavailable for ${model.displayName}. Choose another level.`);
    }
    const modelId = model.model;
    const threadOptions = {
      cwd: turn.cwd,
      modelProvider: 'openai',
      model: modelId,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      developerInstructions: turn.instructions ?? '',
    };
    const { thread } = await request<{ thread: { id: string } }>(
      turn.threadId ? 'thread/resume' : 'thread/start',
      turn.threadId ? { ...threadOptions, threadId: turn.threadId } : threadOptions,
    );
    const messageIds = new Set<string>();
    let completed: NonNullable<NonNullable<WireMessage['params']>['turn']> | undefined;
    const emitText = (id: string, text: string) => {
      if (!text) return;
      if (!messageIds.has(id)) {
        if (messageIds.size) turn.onDelta('\n\n');
        messageIds.add(id);
      }
      turn.onDelta(text);
    };
    subscribe(({ method, params }) => {
      if (params?.threadId !== thread.id) return;
      if (method === 'item/agentMessage/delta' && params.itemId && params.delta) {
        emitText(params.itemId, params.delta);
      } else if (method === 'item/completed' && params.item?.type === 'agentMessage' && !messageIds.has(params.item.id)) {
        emitText(params.item.id, params.item.text ?? '');
      } else if (method === 'turn/completed') {
        completed = params.turn;
      }
    });

    await request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: turn.text, text_elements: [] }],
      model: modelId,
      effort: turn.effort,
    });
    while (!completed) await receive();
    if (completed.status !== 'completed') {
      throw new Error(completed.error?.message ?? `Codex turn ${completed.status}.`);
    }
    turn.onThread(thread.id);
  });
}
