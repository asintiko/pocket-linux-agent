import { JsonWindow } from './window-host.js';
import type { ScreenImage } from '@pocket/protocol';

/** What the camera helper answers: one JPEG frame, base64, or what went wrong. */
export type CameraEvent =
  /** The helper is up: it says so before any picture, and that line is not an answer to a request. */
  | { ev: 'ready' }
  | { ev: 'frame'; data: string; width: number; height: number; mime: string }
  | { ev: 'error'; message: string };

export interface CameraHostOptions {
  /** PowerShell script to run; the caller writes it to disk. */
  script: string;
  log: (m: string) => void;
  spawn?: typeof import('node:child_process').spawn;
  shell?: { command: string; args: string[] };
  /** How long one frame may take before the helper is presumed stuck and killed (a camera left open keeps its LED lit). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

/** What the agent needs from a camera: one frame whenever it is asked. */
export interface CameraBackend {
  capture(maxWidth?: number): Promise<ScreenImage>;
  close(): void;
}

type CameraOp = { op: 'idle' } | { op: 'capture'; maxWidth: number };

/**
 * The webcam, one frame at a time. A helper process is started for a frame and killed after it, so the camera is never
 * left streaming between looks: on a laptop the indicator LED is wired to the sensor's power, and nothing in software
 * can keep it off while the sensor is up.
 */
export class CameraHost implements CameraBackend {
  private window: JsonWindow<CameraOp, CameraEvent> | undefined;
  private pending: { resolve: (v: ScreenImage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(private readonly opts: CameraHostOptions) {}

  capture(maxWidth = 1280): Promise<ScreenImage> {
    if (this.pending) return Promise.reject(new Error('The camera is already taking a frame'));
    return new Promise<ScreenImage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.stop();
        reject(new Error('The camera did not answer in time; another program may be holding it'));
      }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      this.ensure().then(
        (win) => win.send({ op: 'capture', maxWidth }),
        (e: Error) => {
          clearTimeout(timer);
          this.pending = undefined;
          reject(e);
        },
      );
    });
  }

  close(): void {
    this.stop();
    this.window?.close();
    this.window = undefined;
  }

  private ensure(): Promise<JsonWindow<CameraOp, CameraEvent>> {
    if (!this.window) {
      this.window = new JsonWindow<CameraOp, CameraEvent>({
        script: this.opts.script,
        label: 'camera',
        snapshot: () => ({ op: 'idle' }) as CameraOp,
        log: this.opts.log,
        onEvent: (e) => this.onEvent(e),
        spawn: this.opts.spawn,
        shell: this.opts.shell,
        // One failed frame must not make the agent give up on the camera for good.
        maxCrashes: 1000,
      });
      this.window.start();
    }
    return Promise.resolve(this.window);
  }

  private onEvent(e: CameraEvent): void {
    // The helper announces itself before it has read a single request: that line belongs to no frame and must not
    // settle the request that is waiting for one.
    if (e.ev === 'ready') return;
    const p = this.pending;
    this.pending = undefined;
    if (!p) return;
    clearTimeout(p.timer);
    if (e.ev === 'frame') p.resolve({ mime: e.mime, dataBase64: e.data, width: e.width, height: e.height });
    else p.reject(new Error(e.message || 'The camera failed without saying why'));
    // The camera is shut down right after every frame, so the next look starts a fresh helper.
    this.stop();
  }

  private stop(): void {
    this.window?.close();
    this.window = undefined;
  }
}
