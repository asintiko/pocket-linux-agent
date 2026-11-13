import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CameraHost } from '../src/camera-host.js';
import { CAMERA_PS, CAMERA_PS_FILE } from '../src/camera.js';

class StubChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines: string[] = [];
  kill = vi.fn(() => {
    this.emit('exit', null);
    return true;
  });
  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      this.lines.push(...parts);
    });
  }
  ops() {
    return this.lines.map((l) => JSON.parse(l) as { op: string; maxWidth?: number });
  }
  say(obj: unknown) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
}

function setup() {
  const children: StubChild[] = [];
  const logs: string[] = [];
  const host = new CameraHost({
    script: 'C:\\camera.ps1',
    log: (m) => logs.push(m),
    spawn: (() => {
      const child = new StubChild();
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
    timeoutMs: 500,
  });
  return { host, children, logs };
}

describe('the camera host', () => {
  it('starts a helper for a frame, asks for it, and shuts the helper down as soon as the frame is in', async () => {
    const { host, children } = setup();
    const frame = host.capture(800);
    await new Promise((r) => setTimeout(r, 5));
    expect(children).toHaveLength(1);
    // The state goes first, then the request for a frame.
    expect(children[0]!.ops().map((o) => o.op)).toEqual(['idle', 'capture']);
    expect(children[0]!.ops()[1]).toEqual({ op: 'capture', maxWidth: 800 });
    children[0]!.say({ ev: 'frame', data: 'AAAA', width: 640, height: 480, mime: 'image/jpeg' });
    expect(await frame).toEqual({ mime: 'image/jpeg', dataBase64: 'AAAA', width: 640, height: 480 });
    // The camera must not stay open between looks: the helper is told to quit, and the next frame starts a fresh one.
    await new Promise((r) => setTimeout(r, 5));
    expect(children[0]!.ops().map((o) => o.op)).toContain('quit');
  });

  it('passes the camera error on, without leaving the helper running', async () => {
    const { host, children } = setup();
    const frame = host.capture();
    await new Promise((r) => setTimeout(r, 5));
    children[0]!.say({ ev: 'error', message: 'The camera is in use by another program' });
    await expect(frame).rejects.toThrow('in use by another program');
    await new Promise((r) => setTimeout(r, 5));
    expect(children[0]!.ops().map((o) => o.op)).toContain('quit');
  });

  it('gives up on a helper that never answers, so the camera is not held open', async () => {
    const { host, children } = setup();
    await expect(host.capture()).rejects.toThrow(/did not answer/);
    // The stuck helper is told to quit; if it does not, the window host kills it after a moment.
    expect(children[0]!.ops().map((o) => o.op)).toContain('quit');
  });

  it('does not take the helper\'s own ready line for a frame', async () => {
    const { host, children } = setup();
    const frame = host.capture();
    await new Promise((r) => setTimeout(r, 5));
    // The script says it is up before it has read a request; settling the capture on that line was why every frame
    // came back pictureless.
    children[0]!.say({ ev: 'ready' });
    await new Promise((r) => setTimeout(r, 5));
    expect(children[0]!.ops().map((o) => o.op)).toContain('capture');
    children[0]!.say({ ev: 'frame', data: 'AAAA', width: 2, height: 1, mime: 'image/jpeg' });
    await expect(frame).resolves.toMatchObject({ dataBase64: 'AAAA', width: 2 });
  });

  it('passes on the reason a helper refused, never an empty message', async () => {
    const { host, children } = setup();
    const frame = host.capture();
    await new Promise((r) => setTimeout(r, 5));
    children[0]!.say({ ev: 'error', message: '' });
    await expect(frame).rejects.toThrow(/failed without saying why/);
  });

  it('takes only one frame at a time', async () => {
    const { host, children } = setup();
    const first = host.capture();
    await new Promise((r) => setTimeout(r, 5));
    await expect(host.capture()).rejects.toThrow(/already/);
    children[0]!.say({ ev: 'frame', data: 'AA', width: 1, height: 1, mime: 'image/jpeg' });
    await first;
  });
});

describe('the camera script', () => {
  it('opens the camera, takes one JPEG and lets go: nothing is left streaming', () => {
    expect(CAMERA_PS).toContain('MediaCapture');
    expect(CAMERA_PS).toContain('CapturePhotoToStreamAsync');
    expect(CAMERA_PS).toMatch(/finally\s*\{\s*try \{ \$camera\.Dispose\(\) \}/);
    expect(CAMERA_PS_FILE.charCodeAt(0)).toBe(0xfeff);
  });

  it('awaits an action and an operation with their own AsTask overloads, and LoadAsync by its result type', () => {
    // InitializeAsync and CapturePhotoToStreamAsync are IAsyncAction: the typed AsTask<T> does not take them.
    expect(CAMERA_PS).toContain("AwaitAction $camera.InitializeAsync()");
    expect(CAMERA_PS).toContain('AwaitAction $camera.CapturePhotoToStreamAsync');
    expect(CAMERA_PS).not.toContain('Await $camera.InitializeAsync() ([Windows.Foundation.IAsyncAction])');
    // LoadAsync's result is the byte count, not the reader the old code asked for.
    expect(CAMERA_PS).toContain('Await $reader.LoadAsync([uint32]$size) ([uint32])');
    expect(CAMERA_PS).not.toContain('[Windows.Storage.Streams.DataReader]) | Out-Null');
  });
});
