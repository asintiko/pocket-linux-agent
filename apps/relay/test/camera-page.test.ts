import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNodeRelay, type NodeRelay } from '../src/node-server.js';

let relay: NodeRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe('the camera viewer', () => {
  it('serves the page for a token, without the Mac behind it', async () => {
    relay = await startNodeRelay({ port: 0 });
    const res = await fetch(`${relay.url}/camera/${'a'.repeat(24)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toContain('/frame');
  });

  it('asks the Mac for frames, and passes on what it says', async () => {
    const asked: string[] = [];
    relay = await startNodeRelay({
      port: 0,
      camera: () => ({
        frame: async (token: string) => {
          asked.push(token);
          if (token === 'expired-token-aaaaaaaa') return { error: 'This link has expired', expired: true };
          return { image: { mime: 'image/jpeg', dataBase64: 'AAAA', width: 2, height: 1 } };
        },
        close: () => {},
      }),
    });
    const good = await fetch(`${relay.url}/camera/${'b'.repeat(24)}/frame`);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ image: { mime: 'image/jpeg', dataBase64: 'AAAA', width: 2, height: 1 } });

    const expired = await fetch(`${relay.url}/camera/expired-token-aaaaaaaa/frame`);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toMatchObject({ expired: true });

    expect(asked).toHaveLength(2);
  });

  it('refuses a token that does not look like one, and takes only GET and POST', async () => {
    relay = await startNodeRelay({ port: 0, camera: () => ({ frame: async () => ({}), close: () => {} }) });
    expect((await fetch(`${relay.url}/camera/short/frame`)).status).toBe(404);
    expect((await fetch(`${relay.url}/camera/${'c'.repeat(24)}`, { method: 'DELETE' })).status).toBe(405);
  });

  it('stops a link when the viewer asks', async () => {
    const closed: string[] = [];
    relay = await startNodeRelay({ port: 0, camera: () => ({ frame: async () => ({}), close: (t: string) => closed.push(t) }) });
    const res = await fetch(`${relay.url}/camera/${'d'.repeat(24)}/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(closed).toEqual(['d'.repeat(24)]);
  });

  it('says so when the Mac is not running', async () => {
    process.env.POCKET_CONTROL_SOCKET = join(tmpdir(), `no-brain-${process.pid}.sock`);
    try {
      relay = await startNodeRelay({ port: 0 });
      const res = await fetch(`${relay.url}/camera/${'e'.repeat(24)}/frame`);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error?: string }).error).toBeTruthy();
    } finally {
      delete process.env.POCKET_CONTROL_SOCKET;
    }
  });
});
