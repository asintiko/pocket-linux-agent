import { isToolName, type InnerMessageBody, type ToolContext as CallContext, type ToolResult } from '@pocket/protocol';
import type { IncomingMessage } from '@pocket/transport';
import { killAllBackground, killBackground, tools, type ToolContext, type ToolFn } from './tools/index.js';

const FLUSH_INTERVAL_MS = 50;

export interface DispatcherOptions {
  brainDeviceId: string;
  send(body: InnerMessageBody): void;
  /**
   * Throws if `root` is not a project this computer allows, or if `context` names a desktop that is not running here:
   * the call then fails without anything having been run.
   */
  createContext(signal: AbortSignal, onOutput: ToolContext['onOutput'], root?: string, context?: CallContext): ToolContext;
  toolImpls?: Record<string, ToolFn>;
}

type Stream = 'stdout' | 'stderr';

class OutputBatcher {
  private parts: { stream: Stream; chunk: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly emit: (chunk: string, stream: Stream) => void) {}

  push(chunk: string, stream: Stream): void {
    const last = this.parts[this.parts.length - 1];
    if (last && last.stream === stream) last.chunk += chunk;
    else this.parts.push({ stream, chunk });
    this.timer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const parts = this.parts;
    this.parts = [];
    for (const p of parts) this.emit(p.chunk, p.stream);
  }
}

export class ToolDispatcher {
  private readonly running = new Map<string, { abort: AbortController; scope: string | undefined; workspace: string | undefined }>();

  constructor(private readonly opts: DispatcherOptions) {}

  get activeCalls(): number {
    return this.running.size;
  }

  handle({ from, message }: IncomingMessage): void {
    if (from !== this.opts.brainDeviceId) return;
    switch (message.type) {
      case 'tool.call':
        void this.run(message.payload.callId, message.payload.name, message.payload.args, message.payload.root, message.payload.context);
        return;
      case 'tool.cancel':
        this.running.get(message.payload.callId)?.abort.abort();
        return;
      case 'jobs.kill':
        this.killScope(message.payload.scope, message.payload.workspace);
        return;
      case 'control.kill':
        this.killAll();
        killAllBackground();
        return;
      default:
        return;
    }
  }

  killAll(): void {
    for (const call of this.running.values()) call.abort.abort();
  }

  /** Stops what one chat has going here, calls in flight and background jobs; with `workspace` only what runs in that desktop. Other chats are not touched. */
  killScope(scope: string, workspace?: string): void {
    for (const call of this.running.values()) {
      if (call.scope === scope && (workspace === undefined || call.workspace === workspace)) call.abort.abort();
    }
    killBackground({ scope, ...(workspace !== undefined ? { workspace } : {}) });
  }

  private async run(callId: string, name: string, args: unknown, root?: string, context?: CallContext): Promise<void> {
    if (this.running.has(callId)) return;
    const ac = new AbortController();
    this.running.set(callId, { abort: ac, scope: context?.scope, workspace: context?.workspace?.id });
    const batcher = new OutputBatcher((chunk, stream) =>
      this.opts.send({ type: 'tool.output', payload: { callId, chunk, stream } }),
    );

    let result: ToolResult;
    try {
      const impl = this.opts.toolImpls?.[name] ?? (isToolName(name) ? tools[name] : undefined);
      if (!impl) {
        result = { content: `Unknown tool: ${name}`, isError: true };
      } else {
        result = await impl(args, this.opts.createContext(ac.signal, (chunk, stream) => batcher.push(chunk, stream), root, context));
      }
    } catch (e) {
      result = { content: e instanceof Error ? e.message : String(e), isError: true };
    }
    batcher.flush();
    this.running.delete(callId);
    this.opts.send({ type: 'tool.result', payload: { callId, content: result.content, isError: result.isError ?? false } });
  }
}
