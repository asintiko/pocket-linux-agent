import { randomBytes } from 'node:crypto';

/** How long one link lets someone watch, and how often a frame may be asked for. */
export const VIEW_TTL_MS = 3 * 60_000;
export const MIN_FRAME_GAP_MS = 1200;
export const TOKEN_BYTES = 18;

export interface CameraView {
  token: string;
  deviceId: string;
  /** Who asked for it: only this device may end it early. */
  userId: string;
  expiresAt: number;
  /** When the last frame was taken, so a watcher cannot keep the camera busy. */
  lastFrameAt: number;
}

export const newToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/**
 * The live camera links. One link is one viewer for a few minutes; a frame may be asked for no more often than
 * `gapMs`, so a forgotten tab cannot keep a laptop camera open. Nothing is stored on disk: a link dies with the agent.
 */
export class CameraViews {
  private readonly views = new Map<string, CameraView>();

  constructor(private readonly now: () => number = Date.now, private readonly gapMs = MIN_FRAME_GAP_MS) {}

  open(opts: { deviceId: string; userId: string; ttlMs?: number }): CameraView {
    this.sweep();
    const view: CameraView = {
      token: newToken(),
      deviceId: opts.deviceId,
      userId: opts.userId,
      expiresAt: this.now() + (opts.ttlMs ?? VIEW_TTL_MS),
      lastFrameAt: 0,
    };
    this.views.set(view.token, view);
    return view;
  }

  get(token: string): CameraView | undefined {
    const view = this.views.get(token);
    if (!view) return undefined;
    if (view.expiresAt <= this.now()) {
      this.views.delete(token);
      return undefined;
    }
    return view;
  }

  /** A frame was just taken; false when the last one is too recent to take another yet. */
  takeFrame(view: CameraView): boolean {
    if (this.now() - view.lastFrameAt < this.gapMs) return false;
    view.lastFrameAt = this.now();
    return true;
  }

  close(token: string): void {
    this.views.delete(token);
  }

  /** Every link that belongs to a person, for when they ask to stop. */
  closeFor(userId: string): number {
    let n = 0;
    for (const [token, view] of this.views) {
      if (view.userId !== userId) continue;
      this.views.delete(token);
      n++;
    }
    return n;
  }

  get size(): number {
    return this.views.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, view] of this.views) if (view.expiresAt <= now) this.views.delete(token);
  }
}
