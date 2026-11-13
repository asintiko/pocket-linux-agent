import { JsonWindow } from '../window-host.js';
import type { OverlayTheme, WindowOp } from './model.js';

export type WindowEvent =
  | { ev: 'ready' }
  | { ev: 'visible'; visible: boolean }
  | { ev: 'copied'; what: string }
  | { ev: 'theme'; theme: OverlayTheme }
  /** A chat was picked in the window's side list. */
  | { ev: 'open'; id: string }
  /** The user wrote a message to the chat on screen. */
  | { ev: 'send'; chatId: string; text: string }
  /** The user picked a model ('default' for the default) or a thinking level ('auto' for the model's own). */
  | { ev: 'configure'; chatId: string; model?: string; effort?: string }
  | { ev: 'error'; message: string };

export interface OverlayWindowOptions {
  /** PowerShell script to run; the caller writes it to disk. */
  script: string;
  /** Full redraw sent to every fresh window process. */
  snapshot: () => WindowOp;
  log: (m: string) => void;
  onEvent?: (e: WindowEvent) => void;
  spawn?: typeof import('node:child_process').spawn;
  /** Interpreter and its leading arguments; the script path is appended. Defaults to Windows PowerShell 5.1. */
  shell?: { command: string; args: string[] };
}

/** The chat window: ops in as JSON lines on stdin, events back on stdout, restarted with backoff when it dies. */
export class OverlayWindow extends JsonWindow<WindowOp, WindowEvent> {
  constructor(opts: OverlayWindowOptions) {
    super({ label: 'overlay', ...opts });
  }
}
