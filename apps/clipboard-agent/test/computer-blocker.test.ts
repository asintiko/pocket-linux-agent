import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ComputerHost, throughMsFor } from '../src/computer.js';
import { linuxThroughMsFor } from '../src/linux/computer.js';

class StubChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: { id: number; cmd: { op: string } }[] = [];
  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const p of parts) this.requests.push(JSON.parse(p));
    });
  }
  say(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  kill(): boolean {
    setImmediate(() => this.emit('exit', null));
    return true;
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function stubHost(locked: boolean, throughFor?: ConstructorParameters<typeof ComputerHost>[0]['throughFor']) {
  const children: StubChild[] = [];
  const through: number[] = [];
  const blocker = { locked: () => locked, through: (ms: number) => through.push(ms) };
  const host = new ComputerHost({
    script: 'C:\\computer.ps1',
    log: () => {},
    blocker: () => blocker,
    throughFor,
    spawn: (() => {
      const c = new StubChild();
      children.push(c);
      return c;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { host, children, through };
}

describe('the lock screen and computer use', () => {
  it('steps aside for clicks, held buttons, scrolling and drags, and not for screenshots or typing', () => {
    expect(throughMsFor({ op: 'click', x: 1, y: 2, at: true, button: 'left', count: 1, mods: [], modNames: [] })).toBe(410);
    // A triple click, a long scroll and a drag through several points take longer than one click.
    expect(throughMsFor({ op: 'click', x: 1, y: 2, at: true, button: 'left', count: 3, mods: [], modNames: [] })).toBe(630);
    expect(throughMsFor({ op: 'scroll', x: 0, y: 0, at: false, dx: 0, dy: -30, mods: [], modNames: [] })).toBe(1150);
    expect(throughMsFor({ op: 'drag', path: [1, 2, 3, 4, 5, 6], button: 'left' })).toBe(2100);
    expect(throughMsFor({ op: 'button', button: 'left', down: true })).toBe(15_000);
    expect(throughMsFor({ op: 'button', button: 'left', down: false })).toBe(400);
    expect(throughMsFor({ op: 'scroll', x: 0, y: 0, at: false, dx: 0, dy: 3, mods: [], modNames: [] })).toBe(475);
    expect(throughMsFor({ op: 'drag', path: [1, 2, 3, 4], button: 'left' })).toBe(1500);
    // Letting go of a held button puts the picture back at once.
    expect(throughMsFor({ op: 'release' })).toBe(0);
    // A screenshot must not catch the window while it is stepped aside.
    expect(throughMsFor({ op: 'screenshot', display: -1, maxWidth: 1280, maxHeight: 800, settleMs: 1500 })).toBe(0);
    expect(throughMsFor({ op: 'zoom', x: 0, y: 0, width: 200, height: 200, maxWidth: 1600, maxHeight: 1200 })).toBe(0);
    expect(throughMsFor({ op: 'type', text: 'hi' })).toBeUndefined();
    expect(throughMsFor({ op: 'keys', combos: [[13]], holdMs: 0, names: [['Return']] })).toBeUndefined();
    expect(throughMsFor({ op: 'open', target: 'notepad', args: '' })).toBeUndefined();
  });

  it('on Linux puts the lock back as soon as the picture is taken, not when the longest wait would have ended', async () => {
    const { host, children, through } = stubHost(true, linuxThroughMsFor);
    const shot = host.act({ action: 'screenshot', settleMs: 2500 });
    await tick(120);
    expect(through).toEqual([3500]);
    children[0]!.say({ ready: true });
    await tick();
    children[0]!.say({ id: children[0]!.requests[0]!.id, ok: true, result: { settled: true } });
    await shot;
    expect(through).toEqual([3500, 0]);
    // A click keeps its moment: the input may still be on its way to the window when the step returns.
    const click = host.act({ action: 'click', x: 1, y: 2, button: 'left', count: 1 });
    await tick(120);
    children[0]!.say({ id: children[0]!.requests[1]!.id, ok: true, result: {} });
    await click;
    expect(through).toEqual([3500, 0, 560]);
  });

  it('makes the lock screen click-through before the click goes in, and only while it is up', async () => {
    const { host, children, through } = stubHost(true);
    const click = host.act({ action: 'click', x: 30, y: 40, button: 'left', count: 1 });
    await tick(120);
    expect(through).toEqual([410]);
    children[0]!.say({ ready: true });
    await tick();
    expect(children[0]!.requests.map((r) => r.cmd.op)).toEqual(['click']);
    children[0]!.say({ id: children[0]!.requests[0]!.id, ok: true, result: {} });
    await click;
    host.close();
  });

  it('leaves the lock screen alone when it is not up', async () => {
    const { host, children, through } = stubHost(false);
    const click = host.act({ action: 'click', x: 30, y: 40, button: 'left', count: 1 });
    await tick();
    children[0]!.say({ ready: true });
    await tick();
    children[0]!.say({ id: children[0]!.requests[0]!.id, ok: true, result: {} });
    await click;
    expect(through).toEqual([]);
    host.close();
  });

  it('makes sure the picture is opaque before a screenshot, and does not wait for typing', async () => {
    const { host, children, through } = stubHost(true);
    const shot = host.act({ action: 'screenshot' });
    const typing = host.act({ action: 'type', text: 'hi' });
    await tick(120);
    children[0]!.say({ ready: true });
    await tick();
    expect(children[0]!.requests.map((r) => r.cmd.op)).toEqual(['screenshot']);
    children[0]!.say({ id: children[0]!.requests[0]!.id, ok: true, result: {} });
    await shot;
    await tick();
    children[0]!.say({ id: children[0]!.requests[1]!.id, ok: true, result: {} });
    await typing;
    // Screenshot: back to opaque; typing needs nothing.
    expect(through).toEqual([0]);
    host.close();
  });

  it('brings the picture back immediately on the kill switch', () => {
    const { host, children, through } = stubHost(true);
    host.release();
    expect(through).toEqual([0]);
    expect(children).toHaveLength(0);
    host.close();
  });
});
