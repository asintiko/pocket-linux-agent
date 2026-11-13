import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, type ClientConnection, type ContentBlock, type LoadSessionResponse, type McpServer, type NewSessionResponse, type PromptResponse, type SessionConfigOption, type SessionNotification, type SetSessionConfigOptionResponse } from '@agentclientprotocol/sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '@pocket/protocol';
import { kimiModelsFromConfig } from './kimi-models.js';
import { startPocketMcp, type PocketMcpHandle } from './kimi-mcp.js';

export interface KimiEvents {
  text(delta: string): void;
  tool(id: string, name: string, input: unknown): void;
  toolResult(id: string, content: string, isError: boolean): void;
  error(message: string): void;
  log(message: string): void;
}

interface Options {
  cwd: string;
  home: string;
  prompt: string;
  model?: string;
  effort?: string;
  resumeId?: string;
  executable?: string;
  tools: SdkMcpToolDefinition<any>[];
  events: KimiEvents;
}

/** Per-chat sessions stay separate, while the subscription OAuth and provider config remain shared. */
function linkSharedKimiConfig(home: string): void {
  const shared = join(homedir(), '.kimi-code');
  if (home === shared) return;
  for (const name of ['config.toml', 'credentials', 'region']) {
    const source = join(shared, name);
    const target = join(home, name);
    if (!existsSync(source) || existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue;
    symlinkSync(source, target, statSync(source).isDirectory() ? 'dir' : 'file');
  }
}

/** One long-lived Kimi Code ACP process, with Pocket tools and the same streaming events as the Claude engine. */
export class KimiEngine {
  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: ClientConnection,
    private readonly mcp: PocketMcpHandle | undefined,
    public sessionId: string,
    private configOptions: SessionConfigOption[],
    private readonly events: KimiEvents,
  ) {}

  static async start(options: Options): Promise<KimiEngine> {
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    // Project files are not touched: the per-chat Kimi home carries the Pocket instructions.
    writeFileSync(join(options.home, 'AGENTS.md'), options.prompt, { mode: 0o600 });
    linkSharedKimiConfig(options.home);
    const executable = options.executable ?? process.env.POCKET_KIMI_PATH ?? join(homedir(), '.kimi-code', 'bin', 'kimi');
    const child = spawn(executable, ['acp'], {
      cwd: options.cwd,
      env: { ...process.env, KIMI_CODE_HOME: options.home, KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = options.events;
    child.stderr.on('data', (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) events.log(`kimi: ${line}`);
    });
    const app = client({ name: 'Pocket Claude' });
    app.onNotification(methods.client.session.update, ({ params }) => {
      if (params.sessionId === engine?.sessionId) engine?.onUpdate(params);
    });
    app.onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const option = params.options.find((item) => item.kind === 'allow_once') ?? params.options.find((item) => item.kind === 'allow_always');
      if (!option) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    });
    const connection = app.connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    let engine: KimiEngine | undefined;
    let mcp: PocketMcpHandle | undefined;
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
        clientInfo: { name: 'Pocket Claude', version: '0.1.0' },
      });
      if (options.tools.length) mcp = await startPocketMcp(options.tools);
      const mcpServers: McpServer[] = mcp ? [{ type: 'http', name: 'pocket', url: mcp.url, headers: [] }] : [];
      let sessionId: string;
      let configOptions: SessionConfigOption[];
      if (options.resumeId) {
        try {
          const loaded = await connection.agent.request(methods.agent.session.load, { sessionId: options.resumeId, cwd: options.cwd, mcpServers }) as LoadSessionResponse;
          sessionId = options.resumeId;
          configOptions = loaded.configOptions ?? [];
        } catch (error) {
          // A stale or deleted ACP id is not an authentication failure: create a fresh session instead.
          events.log(`Kimi session ${options.resumeId} could not be resumed; starting a new one: ${String(error)}`);
          const created = await connection.agent.request(methods.agent.session.new, { cwd: options.cwd, mcpServers }) as NewSessionResponse;
          sessionId = created.sessionId;
          configOptions = created.configOptions ?? [];
        }
      } else {
        const created = await connection.agent.request(methods.agent.session.new, { cwd: options.cwd, mcpServers }) as NewSessionResponse;
        sessionId = created.sessionId;
        configOptions = created.configOptions ?? [];
      }
      engine = new KimiEngine(child, connection, mcp, sessionId, configOptions, events);
      await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: 'auto' });
      if (options.model) await engine.setConfig('model', options.model);
      if (options.effort) await engine.setConfig('thinking', options.effort);
      return engine;
    } catch (error) {
      await mcp?.close().catch(() => undefined);
      connection.close();
      child.kill();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Kimi Code could not start: ${message}${/authentication|login/i.test(message) ? ' Check that "kimi login" is configured.' : ''}`);
    }
  }

  models(): ModelInfo[] {
    return kimiModelsFromConfig(this.configOptions);
  }

  async configure(model: string | undefined, effort: string | undefined): Promise<void> {
    if (model) await this.setConfig('model', model);
    if (effort) await this.setConfig('thinking', effort);
  }

  private async setConfig(configId: string, value: string): Promise<void> {
    const result = await this.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId, type: 'select', value }) as SetSessionConfigOptionResponse;
    this.configOptions = result.configOptions ?? this.configOptions;
  }

  async prompt(prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.connection.agent.request(methods.agent.session.prompt, { sessionId: this.sessionId, prompt });
  }

  async cancel(): Promise<void> {
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  close(): void {
    this.connection.close();
    this.mcp?.close().catch(() => undefined);
    this.child.kill();
  }

  private onUpdate(notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') this.events.text(update.content.text);
        return;
      case 'tool_call':
        this.events.tool(update.toolCallId, update.name ?? update.title, update.rawInput ?? {});
        if (update.status === 'completed' || update.status === 'failed') this.events.toolResult(update.toolCallId, outputText(update.rawOutput), update.status === 'failed');
        return;
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') this.events.toolResult(update.toolCallId, outputText(update.rawOutput), update.status === 'failed');
        return;
      case 'config_option_update':
        this.configOptions = update.configOptions;
        return;
      default:
        return;
    }
  }
}

function outputText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
