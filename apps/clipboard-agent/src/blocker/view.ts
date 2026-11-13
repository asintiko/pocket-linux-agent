import { JsonWindow } from '../window-host.js';
import { writeFileSync, rmSync } from 'node:fs';
import { BACKUP_NAME } from './gestures.js';
import { DEFAULT_ESCAPE, LockScreen, type LockView } from './lock.js';
import { stateOp, type BlockerEvent, type BlockerOp } from './window.js';

export interface BlockerViewOptions {
  /** PowerShell script to run; the caller writes it to disk. */
  script: string;
  /** The password the lock screen accepts. */
  pin: string;
  log: (m: string) => void;
  /** On the owner's own laptop only the password, the escape word and the CLI lift the picture. */
  ownerMode?: boolean;
  /** The letters that lift it without a password; `pocket` by default. */
  escape?: string;
  /** Start with the picture up; the agent keeps the window resident either way, so Alt+Shift+Space always works. */
  locked?: boolean;
  /** Locked or unlocked: the chat overlay only shows while the desktop is in plain sight. */
  onLock?: (locked: boolean) => void;
  spawn?: typeof import('node:child_process').spawn;
  shell?: { command: string; args: string[] };
  /** How many times the window may die before giving up; killing it in Task Manager must not uncover the desktop. */
  maxCrashes?: number;
  /** Where the copy of the person's touchpad settings goes while the picture has them switched off. */
  gestureBackup?: string;
}

/** The stub lock screen as the agent sees it: the password stays here, the window only gets locked or not. */
export class BlockerView {
  private pin: string;
  private readonly screen: LockScreen;
  private readonly window: JsonWindow<BlockerOp, BlockerEvent>;

  constructor(private readonly opts: BlockerViewOptions) {
    this.pin = opts.pin;
    this.screen = new LockScreen(() => this.pin, opts.log, opts.ownerMode !== false, opts.locked === true, opts.escape ?? DEFAULT_ESCAPE);
    this.window = new JsonWindow<BlockerOp, BlockerEvent>({
      script: opts.script,
      label: 'blocker',
      snapshot: () => stateOp(this.screen.view()),
      log: opts.log,
      onEvent: (e) => this.onEvent(e),
      spawn: opts.spawn,
      shell: opts.shell,
      maxCrashes: opts.maxCrashes,
    });
  }

  start(): void {
    this.window.start();
    // The window gets the state as its snapshot; the agent hears it here, so the chat overlay follows at once.
    this.opts.onLock?.(this.screen.view().locked);
  }

  close(): void {
    this.window.close();
  }

  locked(): boolean {
    return this.screen.view().locked;
  }

  /** A password taken from the phone or the command line; it applies from the next Enter onwards. */
  setPin(pin: string): void {
    this.pin = pin;
  }

  /** Back to the lock screen, the desktop gone again. */
  lock(): void {
    this.emit(this.screen.lock());
  }

  /** Letters the picture takes as the escape word; the agent reads them, the window only collects them. */
  release(how = 'cli'): void {
    this.emit(this.screen.unlock(how, true));
  }

  setOwnerMode(on: boolean): void {
    this.screen.setOwnerMode(on);
  }

  /** Claude's click is about to land: the window steps aside for a moment so it reaches the desktop underneath. */
  through(ms: number): void {
    if (!this.locked()) return;
    this.window.send({ op: 'through', ms });
  }

  private emit(view: LockView): void {
    this.window.send(stateOp(view));
    this.opts.onLock?.(view.locked);
  }

  private onEvent(e: BlockerEvent): void {
    if (e.ev === 'pin') {
      this.emit(this.screen.submit(e.text));
      return;
    }
    if (e.ev === 'word') {
      this.emit(this.screen.submitWord(e.text));
      return;
    }
    if (e.ev === 'unlock') {
      // Shift+Space+Q is the owner at his own keyboard (no field to click, the picture in the way), so it always
      // counts; anything else the window reports is judged by owner mode.
      this.emit(this.screen.unlock(e.how, e.how === 'spaceq'));
      return;
    }
    if (e.ev === 'hotkey') {
      // Alt+Shift+Space: the desktop is in plain sight, so the picture goes up now.
      if (!this.locked()) this.lock();
      return;
    }
    if (e.ev === 'gestures') {
      // The window keeps its own copy to put back on the way out; this one covers a window that never got there.
      const file = this.opts.gestureBackup;
      try {
        if (!file) return;
        if (e.state === 'off') writeFileSync(file, e.values ?? '');
        else rmSync(file, { force: true });
      } catch {}
      this.opts.log(`blocker: touchpad gestures ${e.state === 'off' ? 'off' : 'back'}`);
      return;
    }
    if (e.ev === 'error' || e.ev === 'log') this.opts.log(`blocker: ${e.message}`);
  }
}
