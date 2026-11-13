import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Finds the explicitly configured CLI, the official per-user binary, then PATH. */
export function resolveKimi(): string {
  if (process.env.POCKET_KIMI_PATH) return process.env.POCKET_KIMI_PATH;
  const official = join(homedir(), '.kimi-code', 'bin', 'kimi');
  if (existsSync(official)) return official;
  try {
    return execFileSync('/bin/zsh', ['-lc', 'command -v kimi'], { encoding: 'utf8' }).trim() || 'kimi';
  } catch {
    return 'kimi';
  }
}
