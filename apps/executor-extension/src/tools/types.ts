import type { ToolResult } from '@pocket/protocol';
import type { PathGuard } from '../path-guard.js';

export interface ToolContext {
  guard: PathGuard;
  roots: string[];
  signal: AbortSignal;
  onOutput(chunk: string, stream: 'stdout' | 'stderr'): void;
  rgPath?: string;
  platform: NodeJS.Platform;
  /** What the call's programs run with; absent means this process's own environment. */
  env?: NodeJS.ProcessEnv;
  /** The chat the call belongs to: background jobs it starts are that chat's, and it sees no others. */
  scope?: string;
  /** The desktop the call's programs appear on, when the chat has one here. */
  workspace?: string;
}

export type ToolFn = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

export const errorResult = (e: unknown): ToolResult => ({
  content: e instanceof Error ? e.message : String(e),
  isError: true,
});

export function guarded(fn: ToolFn): ToolFn {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx);
    } catch (e) {
      return errorResult(e);
    }
  };
}
