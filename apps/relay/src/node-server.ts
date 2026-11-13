import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PairingBundle } from '@pocket/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { CAMERA_PAGE } from './camera-page.js';
import { AccountRoom, MAX_FRAME_BYTES, type Conn, type ConnState, type Storage } from './core.js';

class MapStorage implements Storage {
  private readonly data: Map<string, unknown>;

  constructor(private readonly file?: string) {
    let initial: Record<string, unknown> = {};
    if (file) {
      try {
        initial = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        initial = {};
      }
    }
    this.data = new Map(Object.entries(initial));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
    this.flush();
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
    this.flush();
  }

  private flush(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)));
  }
}

class WsConn implements Conn {
  private state: ConnState = { kind: 'device', authed: false, tokens: 0, refill: 0 };
  constructor(readonly ws: WebSocket) {}
  send(text: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(text);
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
  getState(): ConnState {
    return this.state;
  }
  setState(state: ConnState): void {
    this.state = state;
  }
}

export interface NodeRelay {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
};

/** Expo's web export: the app lives in `apps/mobile/dist` once `pnpm --filter @pocket/mobile export:web` has run. */
export function defaultStaticDir(): string | undefined {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../mobile/dist');
  return existsSync(join(dir, 'index.html')) ? dir : undefined;
}

/**
 * Serves the exported web app (the Telegram Mini App) next to the relay API. Unknown paths without an
 * extension get `index.html` so the app's own router handles them; hashed bundles are cached for a year.
 */
function serveStatic(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const rootAbs = resolve(root);
  let file = resolve(rootAbs, `.${rel}`);
  if (file !== rootAbs && !file.startsWith(rootAbs + sep)) return false;
  const isFile = (f: string) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (!isFile(file)) {
    if (extname(rel) !== '') return false;
    file = join(rootAbs, 'index.html');
    if (!isFile(file)) return false;
  }
  const hashed = rel.startsWith('/_expo/static/') || rel.startsWith('/assets/');
  const stat = statSync(file);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}

/** Self-hosted relay for development, tests, or running on your own box behind a tunnel. */
/** What the relay needs from the Mac to show a camera: the link it was given and the frame behind it. */
export interface CameraBridge {
  frame(token: string): Promise<{ image?: { mime: string; dataBase64: string; width: number; height: number }; error?: string; expired?: boolean }>;
  close(token: string): void;
}

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** Where the brain's control socket lives when the relay was not told: the same place the brain puts it. */
function defaultControlSocket(): string {
  if (process.env.POCKET_CONTROL_SOCKET) return process.env.POCKET_CONTROL_SOCKET;
  return join(process.env.POCKET_HOME ?? join(homedir(), '.pocket-claude'), 'control.sock');
}

/**
 * The camera bridge through the brain's control socket. The relay runs as its own process, so it asks the brain; every
 * frame is one short request over the socket, and the brain is the only one that can reach the camera.
 */
function socketBridge(socketPath: string): CameraBridge {
  const ask = (req: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const s = createConnection(socketPath);
      let out = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      // The brain answers some requests later than the next tick (a frame waits for the computer). Half-closing with
      // end() after the write makes Node tear the socket down before that answer is written, so only write and wait
      // for the brain to close its side.
      const timer = setTimeout(() => finish(() => { s.destroy(); reject(new Error('The Mac did not answer in time')); }), 40_000);
      s.on('connect', () => s.write(`${JSON.stringify(req)}\n`));
      s.on('data', (d) => (out += d.toString()));
      s.on('end', () =>
        finish(() => {
          try {
            const r = JSON.parse(out) as { ok: boolean; data?: Record<string, unknown>; error?: string };
            // A refusal still carries what the Mac knew, such as an expired link or a camera that is busy.
            if (r.data) resolve(r.data);
            else reject(new Error(r.error ?? 'The Mac refused'));
          } catch {
            reject(new Error(out ? `The Mac answered nonsense: ${out.slice(0, 80)}` : 'The Mac closed the socket without an answer'));
          }
        }),
      );
      s.on('error', (e) => finish(() => reject(e)));
    });
  const frameRequests = new Map<string, Promise<{ image?: { mime: string; dataBase64: string; width: number; height: number }; error?: string; expired?: boolean }>>();
  return {
    frame: (token) => {
      // One request per token at a time: a page reload must not stack frames on the camera.
      const running = frameRequests.get(token);
      if (running) return running;
      const p = ask({ cmd: 'camera.frame', token }).then(
        (d) => d as { image?: { mime: string; dataBase64: string; width: number; height: number }; error?: string; expired?: boolean },
        (e: Error) => ({ error: e.message }),
      );
      frameRequests.set(token, p);
      void p.finally(() => frameRequests.delete(token));
      return p;
    },
    close: (token) => void ask({ cmd: 'camera.stop', token }).catch(() => {}),
  };
}

export async function startNodeRelay(opts: {
  port?: number;
  host?: string;
  dataDir?: string;
  staticDir?: string;
  /** Served by the Mac without a WebSocket: the viewer asks it, the relay only lends the address. */
  camera?: () => CameraBridge | undefined;
} = {}): Promise<NodeRelay> {
  const rooms = new Map<string, { room: AccountRoom; conns: Set<WsConn> }>();
  const pairings = new Map<string, { accountId: string; bundle: PairingBundle }>();
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });

  const roomFor = (accountId: string) => {
    let entry = rooms.get(accountId);
    if (!entry) {
      const conns = new Set<WsConn>();
      const storage = new MapStorage(opts.dataDir ? join(opts.dataDir, `${accountId}.json`) : undefined);
      const room = new AccountRoom(accountId, {
        storage,
        connections: () => [...conns],
        publishPairing: async (pairingId, bundle) => {
          if (bundle) pairings.set(pairingId, { accountId, bundle });
          else pairings.delete(pairingId);
        },
      });
      entry = { room, conns };
      rooms.set(accountId, entry);
    }
    return entry;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    const pairing = url.pathname.match(/^\/v1\/pairings\/([0-9a-f]{24})$/);
    if (req.method === 'GET' && pairing) {
      const p = pairings.get(pairing[1]!);
      if (!p || p.bundle.expiresAt < Date.now()) {
        res.writeHead(404, { 'access-control-allow-origin': '*' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(p.bundle));
      return;
    }
    const camera = url.pathname.match(/^\/camera\/([A-Za-z0-9_-]+)(\/frame|\/stop)?$/);
    if (camera && TOKEN.test(camera[1]!)) {
      const token = camera[1]!;
      const bridge = opts.camera?.() ?? socketBridge(defaultControlSocket());
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
      };
      if (!camera[2] && req.method === 'GET') {
        // The page itself carries no secret beyond the token in its address.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(CAMERA_PAGE);
        return;
      }
      if (!bridge) {
        json(503, { error: 'The Mac is not running' });
        return;
      }
      if (camera[2] === '/frame' && req.method === 'GET') {
        // The Mac is the one that knows whether the link is still alive: a token means nothing to the relay itself.
        void bridge.frame(token).then(
          (r) => json(r.image ? 200 : r.expired ? 404 : 502, r.image ? { image: r.image } : { error: r.error || 'The camera returned no picture', expired: r.expired === true }),
          (e: Error) => json(502, { error: e.message }),
        );
        return;
      }
      if (camera[2] === '/stop' && (req.method === 'POST' || req.method === 'GET')) {
        bridge.close(token);
        json(200, { ok: true });
        return;
      }
      json(405, { error: 'Not allowed' });
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (opts.staticDir && !url.pathname.startsWith('/v1/') && serveStatic(opts.staticDir, url.pathname, req, res)) return;
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    const account = url.pathname.match(/^\/v1\/accounts\/([0-9a-f]{32})\/ws$/);
    const pairing = url.pathname.match(/^\/v1\/pairings\/([0-9a-f]{24})\/ws$/);
    let accountId: string | undefined;
    let pairingId: string | undefined;
    if (account) accountId = account[1];
    else if (pairing) {
      pairingId = pairing[1];
      accountId = pairings.get(pairingId!)?.accountId;
      if (!accountId) {
        ws.send(JSON.stringify({ t: 'error', code: 'pairing_expired', message: 'Pairing code not found or expired' }));
        ws.close(4404, 'pairing expired');
        return;
      }
    }
    if (!accountId) {
      ws.close(4404, 'not found');
      return;
    }
    const { room, conns } = roomFor(accountId);
    const conn = new WsConn(ws);
    conns.add(conn);
    const opened = room.onOpen(conn, pairingId);
    ws.on('message', (data) => void opened.then(() => room.onMessage(conn, data.toString())));
    ws.on('close', () => {
      conns.delete(conn);
      void room.onClose(conn);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port ?? 8787;
  return {
    server,
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '0.0.0.0';
  // STATIC_DIR= (empty) turns the web app off; unset picks up apps/mobile/dist when it has been exported.
  const staticDir = process.env.STATIC_DIR === undefined ? defaultStaticDir() : process.env.STATIC_DIR || undefined;
  const relay = await startNodeRelay({ port, host, dataDir: process.env.DATA_DIR ?? '.relay-data', staticDir });
  console.log(`pocket relay listening on ${relay.url}${staticDir ? `, serving the web app from ${staticDir}` : ''}`);
}
