import type { LockView } from './lock.js';

export type BlockerEvent =
  /** The window is up and drawing. */
  | { ev: 'ready' }
  /** The person finished typing: what the password box held. */
  | { ev: 'pin'; text: string }
  /** Letters typed at the picture and submitted: the owner's escape word, if it is one. */
  | { ev: 'word'; text: string }
  /** The person asked to be let through without the password, by a route the agent has to judge. */
  | { ev: 'unlock'; how: string }
  /** Alt+Shift+Space was pressed while the desktop was in plain sight: put the picture back up. */
  | { ev: 'hotkey'; keys: string }
  /**
   * The touchpad gestures went off with the picture (`state: 'off'`, `values` are what was there before) or came
   * back (`state: 'on'`).
   */
  | { ev: 'gestures'; state: 'off' | 'on'; values?: string }
  | { ev: 'log'; message: string }
  | { ev: 'error'; message: string };

/** The stub lock screen's own state; the password itself never leaves the agent. */
export interface BlockerState {
  locked: boolean;
  error: string;
}

export type BlockerOp = { op: 'state'; locked: boolean; error: string } | { op: 'through'; ms: number } | { op: 'quit' };

export const stateOp = (v: LockView): BlockerOp => ({ op: 'state', locked: v.locked, error: v.error });
