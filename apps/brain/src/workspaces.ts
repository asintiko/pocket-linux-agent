import { createHash } from 'node:crypto';
import type { Desktop, WorkspaceBinding, WorkspaceInfo } from '@pocket/protocol';

/**
 * Which Linux desktop belongs to which chat. The brain is the only place that decides this: a desktop's name is
 * derived here from who the chat belongs to, the paired computer and the chat itself (and, for a subagent's desktop,
 * the subagent's task). Tools and models never see or pass a name, a display number or a path.
 */

/** The key of a chat's own desktop; a subagent's is its task id. */
export const MAIN_DESKTOP = 'main';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const digest = (label: string, parts: readonly string[]): Buffer => {
  const hash = createHash('sha256').update(label);
  // Length-prefixed, so no two different lists of parts read the same.
  for (const part of parts) hash.update(`\n${Buffer.byteLength(part)}:`).update(part);
  return hash.digest();
};

/**
 * The stable name of the desktop of one chat on one computer: the same chat on the same computer always gets the
 * same one, and no other owner, computer, chat or subagent can come out at it.
 */
export function workspaceId(of: { accountId: string; userId: string; deviceId: string; sessionId: string; child?: string }): string {
  return `ws_${base32(digest('pocket-workspace-v1', [of.accountId, of.userId, of.deviceId, of.sessionId, of.child ?? '']).subarray(0, 16))}`;
}

/** Names a chat towards an executor, which keeps background jobs apart by it without learning which chat it is. */
export function jobScope(of: { accountId: string; userId: string; sessionId: string }): string {
  return `job_${digest('pocket-job-scope-v1', [of.accountId, of.userId, of.sessionId]).subarray(0, 12).toString('hex')}`;
}

export interface DesktopRecord {
  key: string;
  id: string;
  /** The computer it is on: a chat that moves to another computer gets another desktop there. */
  deviceId: string;
  label: string;
  parent?: string;
  /** What the computer last said about it. */
  info?: WorkspaceInfo;
  /** When it was last seen running, for commands that must not ask before every call. */
  checkedAt?: number;
}

/** The desktops the brain has addressed, per chat. Nothing here is persisted: names are derived, state is asked for. */
export class DesktopDirectory {
  private readonly bySession = new Map<string, Map<string, DesktopRecord>>();

  get(sessionId: string, key: string): DesktopRecord | undefined {
    return this.bySession.get(sessionId)?.get(key);
  }

  list(sessionId: string): DesktopRecord[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  sessions(): string[] {
    return [...this.bySession.keys()];
  }

  /**
   * The record for a desktop about to be addressed. Returns the record it replaces when the chat's computer changed:
   * that desktop is on another machine and the caller closes it there.
   */
  open(sessionId: string, record: Pick<DesktopRecord, 'key' | 'id' | 'deviceId' | 'label' | 'parent'>): { record: DesktopRecord; replaced?: DesktopRecord } {
    let records = this.bySession.get(sessionId);
    if (!records) this.bySession.set(sessionId, (records = new Map()));
    const known = records.get(record.key);
    if (known && known.id === record.id && known.deviceId === record.deviceId) {
      known.label = record.label;
      return { record: known };
    }
    const fresh: DesktopRecord = { ...record };
    records.set(record.key, fresh);
    return { record: fresh, ...(known ? { replaced: known } : {}) };
  }

  note(sessionId: string, key: string, info: WorkspaceInfo, now: number): void {
    const record = this.get(sessionId, key);
    if (!record || record.id !== info.id) return;
    record.info = info;
    if (info.state === 'running') record.checkedAt = now;
    else delete record.checkedAt;
  }

  /** What was known is no longer trusted: the next command asks the computer again. */
  invalidate(sessionId: string, key: string): void {
    const record = this.get(sessionId, key);
    if (record) delete record.checkedAt;
  }

  remove(sessionId: string, key: string): DesktopRecord | undefined {
    const records = this.bySession.get(sessionId);
    const record = records?.get(key);
    records?.delete(key);
    if (records && records.size === 0) this.bySession.delete(sessionId);
    return record;
  }

  removeSession(sessionId: string): DesktopRecord[] {
    const records = this.list(sessionId);
    this.bySession.delete(sessionId);
    return records;
  }
}

export const bindingOf = (record: DesktopRecord, generation?: number): WorkspaceBinding => ({
  id: record.id,
  ...(generation !== undefined ? { generation } : {}),
  label: record.label.slice(0, 120),
  ...(record.parent ? { parent: record.parent } : {}),
});

/** A desktop as the phone lists it. */
export function desktopOf(record: Pick<DesktopRecord, 'key' | 'label'>, info: WorkspaceInfo | undefined): Desktop {
  return {
    key: record.key,
    label: record.label.slice(0, 160),
    // Generation 0 means it was never started: nothing to show yet.
    state: !info || (info.generation === 0 && info.state === 'stopped') ? 'none' : info.state,
    ...(info && info.generation > 0 ? { generation: info.generation } : {}),
    ...(info?.display ? { display: info.display } : {}),
    ...(info?.width && info.height ? { width: info.width, height: info.height } : {}),
    ...(info?.lastUsedAt ? { lastUsedAt: info.lastUsedAt } : {}),
    ...(info?.error ? { error: info.error } : {}),
  };
}
