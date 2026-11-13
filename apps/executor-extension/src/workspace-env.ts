import { lstatSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  chatCommandEnvironment,
  WORKSPACE_HOST_FILE,
  WORKSPACE_ID_PATTERN,
  WORKSPACE_LIVE_FILE,
  WORKSPACE_ROOT_SEGMENTS,
  workspaceLiveSchema,
  type ToolContext as CallContext,
  type WorkspaceErrorCode,
  type WorkspaceLive,
} from '@pocket/protocol';

/**
 * Where a chat's commands run on Linux. PocketClipboard on the same login owns the chats' desktops and keeps a record
 * of each in a folder only this user can write; the brain only names the desktop. The display, cookie and session bus
 * are read from that record here, never from a message, so a command can only land in a desktop that really exists on
 * this machine for this user. Without a desktop a command gets no display at all: the person's own screen is never
 * the fallback.
 */

export class WorkspaceEnvError extends Error {
  constructor(
    readonly code: Extract<WorkspaceErrorCode, 'workspace_stale' | 'workspace_unavailable'>,
    message: string,
  ) {
    // The code leads the text so the brain can tell a desktop that has to be started again from a failed command.
    super(`[${code}] ${message}`);
  }
}

export const workspaceRegistryRoot = (home: string = os.homedir()): string => path.join(home, ...WORKSPACE_ROOT_SEGMENTS);

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/** True for a file or folder that is this user's and that nobody else can change. */
function ownedPrivately(target: string, kind: 'dir' | 'file'): boolean {
  try {
    const st = lstatSync(target);
    if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) return false;
    const me = uid();
    return (me === undefined || st.uid === me) && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** When the process started, as the kernel counts it: a pid alone may by now be another program. */
function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined;
  } catch {
    return undefined;
  }
}

/** The name of this login as PocketClipboard wrote it down, when it is installed here. */
export function readWorkspaceHost(root: string = workspaceRegistryRoot()): string | undefined {
  if (process.platform !== 'linux' || !ownedPrivately(root, 'dir')) return undefined;
  const file = path.join(root, WORKSPACE_HOST_FILE);
  if (!ownedPrivately(file, 'file')) return undefined;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return /^[a-z0-9]{16,64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The running desktop a call names, or the reason it cannot be used. Never guesses and never falls back. */
export function resolveWorkspace(binding: { id: string; generation: number }, root: string = workspaceRegistryRoot()): WorkspaceLive {
  const gone = (why: string) => new WorkspaceEnvError('workspace_unavailable', `${why} The command was not run.`);
  if (!WORKSPACE_ID_PATTERN.test(binding.id)) throw gone('That is not the name of a desktop.');
  const dir = path.join(root, binding.id);
  // A record anybody else could have written might name any display, so it is not believed.
  if (!ownedPrivately(root, 'dir') || !ownedPrivately(dir, 'dir')) throw gone("This chat's desktop is not running on this computer (PocketClipboard keeps no record of it here).");
  const file = path.join(dir, WORKSPACE_LIVE_FILE);
  if (!ownedPrivately(file, 'file')) throw gone("This chat's desktop is not running on this computer.");
  let live: WorkspaceLive;
  try {
    live = workspaceLiveSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw gone("The record of this chat's desktop cannot be read.");
  }
  if (live.id !== binding.id) throw gone("The record of this chat's desktop belongs to another one.");
  if (live.generation !== binding.generation) {
    throw new WorkspaceEnvError('workspace_stale', `This chat's desktop was started again (it is generation ${live.generation}, the command was meant for ${binding.generation}). The command was not run.`);
  }
  if (processStart(live.xserver.pid) !== live.xserver.start) throw gone("This chat's desktop has stopped.");
  return live;
}

/**
 * What a chat's command runs with on Linux: this process's environment without the person's session, and inside the
 * desktop the call names. Returns undefined on other systems, where commands keep the environment they always had.
 */
export function commandEnvironment(workspace: { id: string; generation: number } | undefined, base: NodeJS.ProcessEnv = process.env, root?: string): Record<string, string> | undefined {
  if (process.platform !== 'linux') return undefined;
  return chatCommandEnvironment(base, workspace ? resolveWorkspace(workspace, root) : undefined);
}

/**
 * Where one call belongs, from what the brain sent with it: the environment its programs run with, the chat that owns
 * the background jobs it starts, and the desktop they are in. Throws, before anything is run, when the call names a
 * desktop that is not running here.
 */
export function callPlacement(context: CallContext | undefined, base?: NodeJS.ProcessEnv, root?: string): { env?: Record<string, string>; scope?: string; workspace?: string } {
  const env = commandEnvironment(context?.workspace, base, root);
  return { ...(env ? { env } : {}), ...(context ? { scope: context.scope } : {}), ...(context?.workspace ? { workspace: context.workspace.id } : {}) };
}
