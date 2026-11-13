import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';

/** The touchpad settings that open Windows UI above everything: Task View, the app switcher, show desktop. */
export const GESTURE_VALUES = ['ThreeFingerSlideEnabled', 'FourFingerSlideEnabled', 'ThreeFingerTapEnabled', 'FourFingerTapEnabled'] as const;

export const BACKUP_NAME = 'gestures.bak';
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PrecisionTouchPad';

export interface SavedGesture {
  name: string;
  /** What the person had; null when the value did not exist at all (Windows' default then applies again). */
  value: number | null;
}

/** The backup the lock screen window writes before it turns the gestures off: one `name=value` per line, `-` for absent. */
export function parseBackup(text: string): SavedGesture[] {
  const saved: SavedGesture[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+)=(-|\d+)$/.exec(line.trim());
    if (!m) continue;
    if (!(GESTURE_VALUES as readonly string[]).includes(m[1]!)) continue;
    saved.push({ name: m[1]!, value: m[2] === '-' ? null : Number(m[2]) });
  }
  return saved;
}

/** The reg.exe calls that put every saved value back; a value that was absent is deleted again. */
export function restoreCommands(saved: readonly SavedGesture[]): string[][] {
  return saved.map((s) =>
    s.value === null
      ? ['delete', REG_KEY, '/v', s.name, '/f']
      : ['add', REG_KEY, '/v', s.name, '/t', 'REG_DWORD', '/d', String(s.value), '/f'],
  );
}

/**
 * Puts the person's touchpad gestures back after the agent died with the lock screen up. The window restores them
 * itself on the way out; this only runs on start, for the case where it never got the chance. Explorer is not told
 * about it here: it reads these values when it starts, and the window's own notification covers the same session.
 */
export function restoreGestures(opts: {
  home: string;
  log: (m: string) => void;
  run?: (args: string[]) => boolean;
}): number {
  const file = path.join(opts.home, BACKUP_NAME);
  if (!existsSync(file)) return 0;
  let saved: SavedGesture[];
  try {
    saved = parseBackup(readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
  const run = opts.run ?? defaultRun;
  let done = 0;
  for (const args of restoreCommands(saved)) if (run(args)) done++;
  // The backup goes even if a value failed: leaving it would make every later start try again.
  try {
    rmSync(file, { force: true });
  } catch {}
  if (saved.length) opts.log(`gestures: put back ${done} of ${saved.length} touchpad settings left off by the lock screen`);
  return done;
}

function defaultRun(args: string[]): boolean {
  try {
    return spawnSync('reg', args, { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}
