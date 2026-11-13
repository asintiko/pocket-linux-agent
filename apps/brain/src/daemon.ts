import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  b64,
  deriveAccountId,
  deriveDeviceId,
  newPairingCode,
  openPairRequest,
  PAIRING_TTL_MS,
  pairingUri,
  safetyNumber,
  sealPairReply,
  type ClipboardItem,
  type ComputerAction,
  type ComputerResult,
  type Identity,
  TOOL_NAMES,
  type InnerMessageBody,
  type MessageType,
  type ModelInfo,
  type PairingBundle,
  MAC_DEVICE_ID,
  NO_WAYLAND,
  PEER_FEATURES,
  type PairingCode,
  type Project,
  type PayloadOf,
  type PushHint,
  type RelayToDevice,
  type ScreenImage,
  type SessionEvent,
  type SessionMeta,
  type ToolName,
  type ToolResult,
  type WorkspaceBinding,
  type WorkspaceErrorCode,
  type WorkspaceInfo,
} from '@pocket/protocol';
import { DeviceLink, type IncomingMessage, type WebSocketCtor } from '@pocket/transport';
import { WebSocket as NodeWebSocket } from 'ws';
import { isAllowedByRules, validateRule } from './allowlist.js';
import { FALLBACK_MODELS } from './chat-tools.js';
import { withKimi } from './kimi-models.js';
import { resolveKimi } from './kimi-cli.js';
import { withOrca } from './orca.js';
import { withCodex } from './codex.js';
import { withMarket } from './marketllm.js';
import { macWorkspaceFor, personRoot } from './sandbox.js';
import { COMPUTER_TOOL, computerConsent } from './computer-tools.js';
import { toDisplayCall } from './claude-tools.js';
import { CameraViews } from './camera-views.js';
import { ExecutorBridge, type CallOptions, type ExecutorHandle } from './executor.js';
import { bindingOf, desktopOf, DesktopDirectory, jobScope, MAIN_DESKTOP, workspaceId, type DesktopRecord } from './workspaces.js';
import { log } from './log.js';
import type { PcHandle } from './pc-tools.js';
import { PermissionBroker, SANDBOX_NETWORK_TOOL } from './permissions.js';
import { Session, type UserTurn } from './session.js';
import { migrateState, OWNER_ID, saveState, type BrainState, type PairedDevice, type UsageTotals, type User } from './store.js';

const MAX_LIVE_SESSIONS = 2;

const DELTA_FLUSH_MS = 60;
const CLIPBOARD_TIMEOUT_MS = 60_000;

/** A computer-use step may first wait for PocketClipboard to start its helper; typing and holding take longer still. */
function computerTimeout(action: ComputerAction): number {
  if (action.action === 'type') return 90_000 + action.text.length * 25;
  if (action.action === 'key') return 90_000 + (action.holdMs ?? 0);
  return 90_000;
}

type PcRequest = Extract<InnerMessageBody, { type: 'clipboard.read' | 'clipboard.write' | 'screen.capture' | 'computer.act' | 'camera.capture' | 'workspace.control' }>;
type PcReply = Extract<InnerMessageBody, { type: 'clipboard.data' | 'clipboard.done' | 'screen.image' | 'computer.done' | 'camera.frame' | 'workspace.state' }>;
type PcAnswer = ComputerResult & { items?: ClipboardItem[]; image?: ScreenImage; error?: string; code?: WorkspaceErrorCode; workspace?: WorkspaceInfo; workspaces?: WorkspaceInfo[] };

/** What this brain understands beyond the first protocol; clients ask for these things only when they see them here. */
const FEATURES = [PEER_FEATURES.subagents, PEER_FEATURES.workspaces];

/** For this long a desktop seen running is taken to be running: commands in a row do not each ask the computer first. */
const DESKTOP_FRESH_MS = 20_000;
const DESKTOP_KEEPALIVE_MS = 5 * 60_000;

/** How an executor marks a call it refused because the chat's desktop was not there; see workspace-env.ts in the extension. */
const WORKSPACE_MARK = /^\[workspace_(?:stale|unavailable)\]\s*/;

/**
 * For a VS Code extension on Linux from before per-chat desktops, which runs commands with the person's own display:
 * the command drops it itself, so a graphical program started from it fails instead of opening on their screen.
 */
function withoutDisplay(args: unknown): unknown {
  const call = args as { command?: unknown } | null;
  if (!call || typeof call.command !== 'string') return args;
  return { ...call, command: `unset DISPLAY XAUTHORITY WAYLAND_SOCKET; export WAYLAND_DISPLAY=${NO_WAYLAND} GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb\n${call.command}` };
}
/** The only client traffic a computer with the 'overlay' capability gets to see: the chat itself, nothing it could act on. */
const OVERLAY_MIRRORED = new Set<MessageType>(['session.event', 'session.created', 'session.updated', 'session.deleted']);

export interface PairingTicket {
  code: string;
  uri: string;
  safetyNumber: string;
  expiresAt: number;
  /** The code registers a new person instead of adding a device to an existing one. */
  invite?: boolean;
}

export interface UserSummary extends User {
  devices: (Pick<PairedDevice, 'deviceId' | 'role' | 'name'> & { online: boolean })[];
  sessions: number;
}

export interface BrainStatus {
  accountId: string;
  deviceId: string;
  relayUrl: string;
  relayConnected: boolean;
  claudeVersion: string | null;
  kimiVersion: string | null;
  executorOnline: boolean;
  workspaces: string[];
  devices: (Pick<PairedDevice, 'deviceId' | 'role' | 'name'> & { online: boolean; user: string })[];
  sessions: SessionMeta[];
}

/** An open pairing code. `userId` is set once the code belongs to a person; invites get one when the first device joins. */
interface OpenPairing {
  code: PairingCode;
  expiresAt: number;
  onPaired?: (d: PairedDevice) => void;
  userId?: string;
  invite?: { name?: string };
}

export class Brain {
  readonly deviceId: string;
  readonly accountId: string;
  private readonly link: DeviceLink;
  private readonly executor: ExecutorBridge;
  private readonly permissions: PermissionBroker;
  private readonly sessions = new Map<string, Session>();
  private readonly pairings = new Map<string, OpenPairing>();
  private readonly pendingDeltas = new Map<string, { text: string; at?: number; timer: ReturnType<typeof setTimeout> }>();
  private claudeVersion: string | null = null;
  private kimiVersion: string | null = null;
  /** Clipboard and screen requests waiting for a computer's answer. */
  private readonly pcRequests = new Map<string, { deviceId: string; timer: ReturnType<typeof setTimeout>; resolve: (r: PcReply) => void }>();
  private models: ModelInfo[] | null = null;
  /** The live camera links: one viewer each, a few minutes at a time. */
  private readonly cameraViews = new CameraViews();
  /** Where `camera.watch` points the viewer: the relay that serves it, without a trailing slash. */
  private cameraBaseUrl: string | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** The Linux desktops of the chats: which one is whose, and how each last stood. */
  private readonly desktops = new DesktopDirectory();
  private readonly desktopKeepalive: ReturnType<typeof setInterval>;

  constructor(
    private readonly identity: Identity,
    private readonly state: BrainState,
    private readonly opts: { WebSocket?: WebSocketCtor; claudeOptions?: Partial<Options>; persist?: boolean } = {},
  ) {
    migrateState(state);
    this.deviceId = deriveDeviceId(identity.signPub);
    this.accountId = deriveAccountId(identity.signPub);
    this.link = new DeviceLink({
      relayUrl: state.relayUrl,
      accountId: this.accountId,
      deviceId: this.deviceId,
      role: 'brain',
      identity,
      peers: Object.fromEntries(state.devices.map((d) => [d.deviceId, d.encPub])),
      replayState: state.replay,
      WebSocket: opts.WebSocket ?? (NodeWebSocket as unknown as WebSocketCtor),
      log: (m) => log(`link: ${m}`),
    });
    this.executor = new ExecutorBridge({
      executorIds: () => this.executorDevices().map((d) => d.deviceId),
      isOnline: (id) => this.link.isOnline(id),
      send: (to, body) => this.link.send(to, body),
    });
    this.permissions = new PermissionBroker({
      isAllowedAlways: (tool, input) => isAllowedByRules(this.state.allowlist, tool, input),
      request: (p) => this.toClients(this.userOfSession(p.sessionId), { type: 'permission.request', payload: p }, 'permission'),
      resolved: (requestId, sessionId, decision, by) => this.toClients(this.userOfSession(sessionId), { type: 'permission.resolved', payload: { requestId, decision, by } }),
      waiting: (sessionId, waiting) => this.sessions.get(sessionId)?.setWaiting(waiting),
    });
    for (const meta of state.sessions) {
      const restored = { ...meta, state: meta.state === 'ended' ? 'ended' : 'idle' } as SessionMeta;
      this.sessions.set(meta.sessionId, new Session(restored, this.sessionHost(), true));
    }

    this.desktopKeepalive = setInterval(() => this.keepDesktopsAlive(), DESKTOP_KEEPALIVE_MS);
    this.desktopKeepalive.unref();

    this.link.on('message', (m) => void this.onMessage(m).catch((e) => log(`message handler failed: ${String(e)}`)));
    this.link.on('control', (f) => this.onControl(f));
    this.link.on('ready', (_roster, online) => {
      log(`relay ready; online: ${online.join(', ') || 'nobody'}`);
      this.broadcastStatus();
      // Subagents that were running when the daemon last went away are over; their cards are closed now that phones can hear it.
      for (const s of this.sessions.values()) s.reconcile();
    });
    this.link.on('presence', (deviceId, online) => {
      const device = this.state.devices.find((d) => d.deviceId === deviceId);
      if (!device) return;
      log(`${device.role} ${device.name} is ${online ? 'online' : 'offline'}`);
      if (online && this.state.publicRelayUrl) this.link.send(deviceId, { type: 'relay.moved', payload: { url: this.state.publicRelayUrl } });
      if (device.role === 'executor') {
        if (!online) this.executor.failAll('The computer went offline.', deviceId);
        this.broadcastStatus(online ? undefined : 'executor_offline');
        this.broadcastComputers();
      } else if (online) {
        this.sendStatus(deviceId);
        for (const p of this.permissions.outstanding()) {
          if (this.userOfSession(p.sessionId) === device.userId) this.link.send(deviceId, { type: 'permission.request', payload: p });
        }
      }
    });
  }

  start(): void {
    this.link.connect();
    void this.detectClaudeVersion();
    void this.detectKimiVersion();
  }

  stop(): void {
    clearInterval(this.desktopKeepalive);
    for (const s of this.sessions.values()) s.stop();
    this.persistNow();
    this.link.close();
  }

  status(): BrainStatus {
    return {
      accountId: this.accountId,
      deviceId: this.deviceId,
      relayUrl: this.publicRelayUrl,
      relayConnected: this.link.isReady,
      claudeVersion: this.claudeVersion,
      kimiVersion: this.kimiVersion,
      executorOnline: this.executor.online(this.defaultExecutor(OWNER_ID)),
      workspaces: this.executor.info(this.defaultExecutor(OWNER_ID))?.workspaces ?? [],
      devices: this.state.devices.map((d) => ({ deviceId: d.deviceId, role: d.role, name: d.name, online: this.link.isOnline(d.deviceId), user: this.userName(d.userId) })),
      sessions: [...this.sessions.values()].map((s) => s.meta),
    };
  }

  users(): UserSummary[] {
    return this.state.users.map((u) => ({
      ...u,
      devices: this.state.devices.filter((d) => d.userId === u.id).map((d) => ({ deviceId: d.deviceId, role: d.role, name: d.name, online: this.link.isOnline(d.deviceId) })),
      sessions: this.sortedSessions(u.id).length,
    }));
  }

  /** Removes a person with all their devices and chats. The owner cannot be removed. */
  /**
   * A chat made on the Mac for a person (by id or name; the owner with 'owner'), with its own folder ready so files can
   * be put in before they open it. Their phones see it at once.
   */
  createChatFor(idOrName: string, title: string): { sessionId: string; folder: string; user: string } {
    const needle = idOrName.trim().toLowerCase();
    const user = this.state.users.find((u) => u.id === needle || u.name.toLowerCase() === needle || (needle === 'owner' && u.owner));
    if (!user) throw new Error(`No such person: ${idOrName}`);
    const now = Date.now();
    const meta: SessionMeta = {
      sessionId: randomUUID(),
      title: title.trim() || `Chat ${new Date(now).toLocaleString('ru-RU')}`,
      state: 'idle',
      createdAt: now,
      updatedAt: now,
      userId: user.id,
      ...(user.owner ? {} : { executorId: MAC_DEVICE_ID }),
    };
    const session = new Session(meta, this.sessionHost(), false);
    this.sessions.set(meta.sessionId, session);
    const folder = macWorkspaceFor(meta).cwd;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.schedulePersist();
    this.toClients(user.id, { type: 'session.created', payload: { session: meta } });
    return { sessionId: meta.sessionId, folder, user: user.name };
  }

  /** Sends a message into a chat on the Mac's behalf, e.g. to have Claude read a prepared folder before the person comes. */
  async sayInChat(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('No such chat');
    this.enforceLiveLimit(s.id);
    await s.send({ text, from: MAC_DEVICE_ID });
  }

  removeUser(idOrName: string): boolean {
    const needle = idOrName.trim().toLowerCase();
    const user = this.state.users.find((u) => !u.owner && (u.id === needle || u.name.toLowerCase() === needle));
    if (!user) return false;
    for (const d of this.state.devices.filter((d) => d.userId === user.id)) this.removeDevice(d.deviceId);
    for (const s of [...this.sessions.values()].filter((s) => (s.meta.userId ?? OWNER_ID) === user.id)) {
      for (const p of this.permissions.outstanding()) if (p.sessionId === s.id) this.permissions.respond(p.requestId, 'deny', 'removed');
      this.releaseSession(s);
      s.destroy();
      this.sessions.delete(s.id);
    }
    if (this.state.activeExecutors) delete this.state.activeExecutors[user.id];
    this.state.users = this.state.users.filter((u) => u.id !== user.id);
    this.persistNow();
    log(`removed user "${user.name}" (${user.id})`);
    return true;
  }

  private isOwner(userId: string): boolean {
    return this.state.users.find((u) => u.id === userId)?.owner === true;
  }

  private userName(userId: string): string {
    return this.state.users.find((u) => u.id === userId)?.name ?? userId;
  }

  private userOf(deviceId: string): string | undefined {
    return this.state.devices.find((d) => d.deviceId === deviceId)?.userId;
  }

  private userOfSession(sessionId: string): string {
    return this.sessions.get(sessionId)?.meta.userId ?? OWNER_ID;
  }

  private permissionSession(requestId: string): string | undefined {
    return this.permissions.outstanding().find((p) => p.requestId === requestId)?.sessionId;
  }

  /**
   * Issues a one-time code. The phone scans `uri`; the Windows executor types `code` and checks `safetyNumber`.
   * Devices join the person in `userId` (the owner by default); an `invite` registers a new person with the first device.
   */
  startPairing(onPaired?: (d: PairedDevice) => void, opts: { userId?: string; invite?: { name?: string } } = {}): PairingTicket {
    if (!this.link.isReady) throw new Error('Not connected to the relay yet');
    const code = newPairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const bundle: PairingBundle = {
      v: 1,
      accountId: this.accountId,
      brainDeviceId: this.deviceId,
      brainSignPub: b64.encode(this.identity.signPub),
      brainEncPub: b64.encode(this.identity.encPub),
      expiresAt,
    };
    const invite = opts.invite !== undefined;
    this.pairings.set(code.pairingId, { code, expiresAt, onPaired, ...(invite ? { invite: opts.invite } : { userId: opts.userId ?? OWNER_ID }) });
    this.link.sendControl({ t: 'pairing.publish', pairingId: code.pairingId, bundle });
    setTimeout(() => this.pairings.delete(code.pairingId), PAIRING_TTL_MS + 5_000);
    return { code: code.display, uri: pairingUri(code, this.publicRelayUrl, { invite }), safetyNumber: safetyNumber(bundle), expiresAt, ...(invite ? { invite } : {}) };
  }

  get publicRelayUrl(): string {
    return this.state.publicRelayUrl ?? this.state.relayUrl;
  }

  /** Tells every device the relay's new public address. Offline devices hear it when they next come online through the old one. */
  movePublicRelay(url: string): string {
    const next = new URL(url).toString().replace(/\/$/, '');
    this.state.publicRelayUrl = next;
    this.persistNow();
    for (const d of this.state.devices) this.link.send(d.deviceId, { type: 'relay.moved', payload: { url: next } });
    log(`public relay is now ${next}`);
    return next;
  }

  /** Turns the Telegram bot on (token + username from getMe) or off; phones learn about it through the status. */
  configureTelegram(config: { token: string; username: string } | null): void {
    if (config) this.state.telegram = { ...config, ...(this.state.telegram?.appUrl ? { appUrl: this.state.telegram.appUrl } : {}) };
    else delete this.state.telegram;
    this.persistNow();
    this.broadcastStatus();
  }

  /** Where the bot sends people for the Mini App (`null` removes the menu button); needs a configured bot. */
  configureTelegramApp(url: string | null): string | null {
    if (!this.state.telegram) throw new Error('Set up the bot first: pocket-claude telegram <token>');
    if (url) this.state.telegram.appUrl = url;
    else delete this.state.telegram.appUrl;
    this.persistNow();
    return this.state.telegram.appUrl ?? null;
  }

  get telegram(): { token: string; username: string; appUrl?: string } | undefined {
    return this.state.telegram;
  }

  removeDevice(deviceId: string): boolean {
    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    if (!device) return false;
    this.state.devices = this.state.devices.filter((d) => d.deviceId !== deviceId);
    this.link.removePeer(deviceId);
    this.link.sendControl({ t: 'roster.remove', deviceId });
    if (device.role === 'executor') {
      this.executor.forget(deviceId);
      for (const [userId, active] of Object.entries(this.state.activeExecutors ?? {})) if (active === deviceId) delete this.state.activeExecutors![userId];
      this.broadcastComputers();
      this.broadcastStatus();
    }
    this.persistNow();
    return true;
  }

  /** Paired computers, optionally only one person's. */
  private executorDevices(userId?: string): PairedDevice[] {
    return this.state.devices.filter((d) => d.role === 'executor' && (userId === undefined || d.userId === userId));
  }

  /** A person's default computer for the clipboard: the one picked last, else the first online one, else any. */
  private defaultExecutor(userId: string): string | undefined {
    const all = this.executorDevices(userId);
    const active = this.state.activeExecutors?.[userId];
    if (all.some((d) => d.deviceId === active)) return active;
    const clip = all.filter((d) => this.executor.info(d.deviceId)?.capabilities?.includes('clipboard'));
    const pool = clip.length ? clip : all;
    return (pool.find((d) => this.link.isOnline(d.deviceId)) ?? pool[0])?.deviceId;
  }

  private setActiveExecutor(userId: string, deviceId: string): void {
    this.state.activeExecutors = { ...this.state.activeExecutors, [userId]: deviceId };
  }

  /** Old extensions don't report capabilities; they are tool executors. */
  private hasTools(deviceId: string): boolean {
    const caps = this.executor.info(deviceId)?.capabilities;
    return !caps || caps.includes('tools');
  }

  /** PocketClipboard with the overlay window: it mirrors the chat on screen, reads sessions, writes text into them and sets their model. */
  private isOverlay(deviceId: string): boolean {
    return !!this.executor.info(deviceId)?.capabilities?.includes('overlay');
  }

  /** Chats of people other than the owner that have no tools computer work on the Mac inside that person's own folder. */
  private guestRoot(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const userId = s.meta.userId ?? OWNER_ID;
    return !this.isOwner(userId) && this.executorForSession(sessionId) === undefined ? personRoot(userId) : undefined;
  }

  /** The PocketClipboard computer a chat's pc_* tools talk to: the chat's computer if it has one, else the person's default. */
  private pcForSession(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const userId = s.meta.userId ?? OWNER_ID;
    const hasClipboard = (id: string | undefined) => !!id && this.executorDevices(userId).some((d) => d.deviceId === id) && !!this.executor.info(id)?.capabilities?.includes('clipboard');
    if (hasClipboard(s.meta.executorId)) return s.meta.executorId;
    const fallback = this.defaultExecutor(userId);
    return hasClipboard(fallback) ? fallback : undefined;
  }

  /** Where a chat runs: the Mac, a tools computer, or chat-only on the Mac without files (people with just PocketClipboard). */
  sessionMode(sessionId: string): { mode: 'mac' | 'remote' | 'chat'; executorId?: string; pcId?: string } | undefined {
    if (!this.sessions.has(sessionId)) return undefined;
    const executorId = this.executorForSession(sessionId);
    const pcId = this.pcForSession(sessionId);
    return { mode: executorId ? 'remote' : 'mac', ...(executorId ? { executorId } : {}), ...(pcId ? { pcId } : {}) };
  }

  /** Sends a clipboard or screen request to a computer and waits for its answer. */
  private askPc(deviceId: string, body: PcRequest, timeoutMs = CLIPBOARD_TIMEOUT_MS): Promise<PcAnswer> {
    return new Promise((resolve) => {
      const { requestId } = body.payload;
      if (!this.link.isOnline(deviceId) || !this.link.send(deviceId, body)) return resolve({ error: 'The computer is offline' });
      const timer = setTimeout(() => {
        if (this.pcRequests.delete(requestId)) resolve({ error: 'The computer did not answer' });
      }, timeoutMs);
      this.pcRequests.set(requestId, { deviceId, timer, resolve: (r) => resolve(r.payload) });
    });
  }

  /**
   * A watch link for the CLI and the bot, without a client to send `camera.view` to. The same rules apply: one viewer,
   * a few minutes, a frame every second or so.
   */
  openCameraView(deviceId?: string): { url?: string; expiresAt?: number; deviceId?: string; error?: string } {
    const id = deviceId && this.executorDevices().some((d) => d.deviceId === deviceId) ? deviceId : this.defaultExecutor(OWNER_ID);
    if (!id) return { error: 'No computer is paired' };
    const caps = this.executor.info(id)?.capabilities ?? [];
    if (!caps.includes('camera')) return { error: 'That computer has no camera to look through' };
    if (!this.cameraBaseUrl) return { error: 'The relay that serves the camera viewer is not known yet' };
    const view = this.cameraViews.open({ deviceId: id, userId: OWNER_ID });
    return { url: `${this.cameraBaseUrl}/camera/${view.token}`, expiresAt: view.expiresAt, deviceId: id };
  }

  /** Where `camera.watch` sends people to watch; the relay that serves the exported app sets this on start. */
  setCameraBaseUrl(url: string | undefined): void {
    this.cameraBaseUrl = url?.replace(/\/+$/, '') || undefined;
  }

  /** The live camera links, for the relay's viewer routes: one frame at a time, a few minutes per link. */
  get camera(): {
    frame: (token: string) => Promise<{ image?: ScreenImage; error?: string; expired?: boolean }>;
    close: (token: string) => void;
  } {
    const views = this.cameraViews;
    return {
      /**
       * A frame must be taken, not merely asked for again: `takeFrame` keeps a reloading page from stacking requests on
       * the camera, and the frame that is refused is a moment old anyway.
       */
      frame: async (token) => {
        const v = views.get(token);
        if (!v) return { error: 'This link has expired', expired: true };
        const caps = this.executor.info(v.deviceId)?.capabilities ?? [];
        if (!caps.includes('camera')) return { error: 'That computer has no camera' };
        if (!views.takeFrame(v)) return { error: 'Waiting for the next frame' };
        const r = await this.askPc(v.deviceId, { type: 'camera.capture', payload: { requestId: randomUUID(), maxWidth: 1280 } }, 25_000);
        // A helper that failed with an empty message would otherwise look like a frame without a picture.
        return r.image ? { image: r.image } : { error: r.error || 'The camera did not return a picture' };
      },
      close: (token) => views.close(token),
    };
  }

  /**
   * How a chat's own requests reach a PocketClipboard computer: in a desktop of the chat's own, on the person's real
   * screen, or not at all. Linux computers give chats desktops of their own. One that does not say so would have the
   * chat act on the person's own screen, which is only done where its owner switched per-chat desktops off there
   * ('host-desktop'); from a PocketClipboard too old to say either, the chat gets an error, not the real screen.
   */
  private desktopMode(deviceId: string): 'desktop' | 'own' | 'refuse' {
    const info = this.executor.info(deviceId);
    const caps = info?.capabilities ?? [];
    if (caps.includes('workspaces')) return 'desktop';
    if (/^linux/i.test(info?.os ?? '') && !caps.includes('host-desktop')) return 'refuse';
    return 'own';
  }

  private oldLinux(deviceId: string): string {
    const name = this.state.devices.find((d) => d.deviceId === deviceId)?.name ?? 'the Linux computer';
    return `PocketClipboard on "${name}" cannot give this chat a desktop of its own, and chats do not act on that computer's real screen instead. Its owner has to update it there (bash apps/clipboard-agent/scripts/install-linux.sh) and check with "PocketClipboard status" that chat desktops are on.`;
  }

  /** Whether a PocketClipboard computer and a VS Code computer are the same Linux login of the same person. */
  private sameLogin(pcId: string, executorId: string): boolean {
    const host = this.executor.info(pcId)?.workspaceHost;
    return !!host && host === this.executor.info(executorId)?.workspaceHost && this.userOf(pcId) !== undefined && this.userOf(pcId) === this.userOf(executorId);
  }

  /** Asks the computer a desktop is on to start, report, picture, close or delete it. */
  private controlDesktop(record: DesktopRecord, op: PayloadOf<'workspace.control'>['op'], opts: { children?: boolean; generation?: number } = {}): Promise<PcAnswer> {
    return this.askPc(
      record.deviceId,
      { type: 'workspace.control', payload: { requestId: randomUUID(), op, workspace: bindingOf(record, opts.generation), ...(opts.children ? { children: true } : {}) } },
      op === 'ensure' ? 60_000 : 30_000,
    );
  }

  /** Desktops a chat left behind on a computer it no longer uses are closed there; their browser profiles stay. */
  private dropStaleDesktops(sessionId: string, deviceId: string | undefined): void {
    for (const record of this.desktops.list(sessionId)) {
      if (deviceId !== undefined && record.deviceId === deviceId) continue;
      this.desktops.remove(sessionId, record.key);
      this.sessions.get(sessionId)?.resetDesktop(record.key);
      void this.controlDesktop(record, 'reset');
    }
  }

  /**
   * The desktop of a chat, or of one of its subagents (`key`: the task id), on the computer its pc tools use. This is
   * the one place a desktop gets its name: from the account, the person the chat belongs to, that computer and the
   * chat. Undefined when that computer has no per-chat desktops.
   */
  private desktopRecord(sessionId: string, key: string): DesktopRecord | undefined {
    const session = this.sessions.get(sessionId);
    const deviceId = this.pcForSession(sessionId);
    if (!session || !deviceId || this.desktopMode(deviceId) !== 'desktop') {
      this.dropStaleDesktops(sessionId, undefined);
      return undefined;
    }
    this.dropStaleDesktops(sessionId, deviceId);
    const of = { accountId: this.accountId, userId: session.meta.userId ?? OWNER_ID, deviceId, sessionId };
    const main = workspaceId(of);
    const title = session.meta.title || 'Chat';
    return this.desktops.open(
      sessionId,
      key === MAIN_DESKTOP
        ? { key, id: main, deviceId, label: title }
        : { key, id: workspaceId({ ...of, child: key }), deviceId, label: `${title} · ${session.subagentLabel(key) ?? 'subagent'}`, parent: main },
    ).record;
  }

  /** The chat's handle on its PocketClipboard computer; with `agent`, the handle of that subagent of the chat. */
  private pcHandle(sessionId: string, agent?: string): PcHandle {
    const id = () => this.pcForSession(sessionId);
    const key = agent ?? MAIN_DESKTOP;
    /**
     * Sends a request of the chat to its computer. Where the computer has per-chat desktops the request carries the
     * chat's own, so nothing the chat does can land on the person's screen or in another chat's desktop.
     */
    const ask = async (build: (workspace: WorkspaceBinding | undefined) => PcRequest, timeoutMs?: number, generation?: number): Promise<PcAnswer> => {
      const deviceId = id();
      if (!deviceId) return { error: 'No computer' };
      const mode = this.desktopMode(deviceId);
      if (mode === 'refuse') return { error: this.oldLinux(deviceId), code: 'workspace_unavailable' };
      if (mode === 'own') {
        this.dropStaleDesktops(sessionId, undefined);
        return this.askPc(deviceId, build(undefined), timeoutMs);
      }
      const record = this.desktopRecord(sessionId, key);
      if (!record) return { error: 'No computer' };
      const answer = await this.askPc(deviceId, build(bindingOf(record, generation)), timeoutMs);
      if (answer.workspace) this.desktops.note(sessionId, key, answer.workspace, Date.now());
      if (answer.code) this.desktops.invalidate(sessionId, key);
      return answer;
    };
    const self = this;
    return {
      get id() {
        return id();
      },
      get name() {
        const deviceId = id();
        return deviceId ? self.state.devices.find((d) => d.deviceId === deviceId)?.name : undefined;
      },
      get online() {
        return self.link.isOnline(id() ?? '');
      },
      get capabilities() {
        return self.executor.info(id())?.capabilities ?? [];
      },
      get os() {
        return self.executor.info(id())?.os;
      },
      get desktop() {
        const deviceId = id();
        return deviceId && self.desktopMode(deviceId) === 'desktop' ? { key } : undefined;
      },
      get blocked() {
        const deviceId = id();
        return deviceId && self.desktopMode(deviceId) === 'refuse' ? self.oldLinux(deviceId) : undefined;
      },
      clipboardRead: () => ask((workspace) => ({ type: 'clipboard.read', payload: { requestId: randomUUID(), ...(workspace ? { workspace } : {}) } })),
      clipboardWrite: (item) => ask((workspace) => ({ type: 'clipboard.write', payload: { requestId: randomUUID(), item, ...(workspace ? { workspace } : {}) } })),
      screenshot: () => ask((workspace) => ({ type: 'screen.capture', payload: { requestId: randomUUID(), ...(workspace ? { workspace } : {}) } })),
      computer: (action, opts) => ask((workspace) => ({ type: 'computer.act', payload: { requestId: randomUUID(), action, ...(workspace ? { workspace } : {}) } }), computerTimeout(action), opts?.generation),
    };
  }

  /** Whether the chat's shell commands run in the Linux login its desktop is in, so that what they start shows up there. */
  private commandsInDesktop(sessionId: string): boolean {
    const executorId = this.executorForSession(sessionId);
    const pcId = this.pcForSession(sessionId);
    return !!executorId && !!pcId && this.desktopMode(pcId) === 'desktop' && !!this.executor.info(executorId)?.capabilities?.includes('workspace-env') && this.sameLogin(pcId, executorId);
  }

  /**
   * Where a command of the chat runs: in the chat's desktop (a subagent's: in its own, once it has one), which is
   * started for it if need be. Without one the command still runs, with no display at all and a note saying why.
   */
  private async placeCommand(sessionId: string, executorId: string, key: string): Promise<{ workspace?: { id: string; generation: number }; note?: string }> {
    const pcId = this.pcForSession(sessionId);
    if (!pcId || this.desktopMode(pcId) !== 'desktop' || !this.sameLogin(pcId, executorId)) return {};
    // A subagent gets a desktop when it first uses the computer tool. Until then its commands have no display:
    // never the main agent's, which it would then share.
    if (key !== MAIN_DESKTOP && !this.desktops.get(sessionId, key)) return {};
    const record = this.desktopRecord(sessionId, key);
    if (!record) return {};
    const known = record.info;
    if (known?.state === 'running' && known.generation > 0 && record.checkedAt !== undefined && Date.now() - record.checkedAt < DESKTOP_FRESH_MS) {
      return { workspace: { id: record.id, generation: known.generation } };
    }
    const answer = await this.controlDesktop(record, 'ensure');
    if (answer.workspace) this.desktops.note(sessionId, key, answer.workspace, Date.now());
    if (answer.workspace?.state === 'running' && answer.workspace.generation > 0) return { workspace: { id: record.id, generation: answer.workspace.generation } };
    return { note: `[No desktop for this command: ${answer.error ?? "the chat's desktop could not be started."} It ran without a display, so a graphical program could not open a window.]` };
  }

  /** A call of a chat on its VS Code computer, placed for that chat: its own background jobs, its own desktop. */
  private async callForChat(sessionId: string, base: ExecutorHandle, name: ToolName, args: unknown, opts: CallOptions): Promise<ToolResult> {
    const executorId = base.id;
    const info = base.info;
    if (!executorId || !info?.capabilities?.includes('workspace-env')) {
      // Windows, macOS, and extensions from before per-chat desktops: calls go as they always did. Such an extension
      // on Linux would let a command open windows on the person's own screen, so there the command itself loses the display.
      return base.call(name, name === 'run_command' && /^linux/i.test(info?.os ?? '') ? withoutDisplay(args) : args, opts);
    }
    const session = this.sessions.get(sessionId);
    const scope = jobScope({ accountId: this.accountId, userId: session?.meta.userId ?? OWNER_ID, sessionId });
    const key = opts.agent ?? MAIN_DESKTOP;
    // Only commands start programs; every other tool needs no desktop, just the chat's own list of background jobs.
    const placed = name === 'run_command' ? await this.placeCommand(sessionId, executorId, key) : {};
    let result = await base.call(name, args, { ...opts, context: { scope, ...(placed.workspace ? { workspace: placed.workspace } : {}) } });
    if (placed.workspace && result.isError && WORKSPACE_MARK.test(result.content)) {
      // The desktop went away between asking and running (closed for being unused, started again). Nothing was run:
      // once more, in the desktop as it is now.
      this.desktops.invalidate(sessionId, key);
      const again = await this.placeCommand(sessionId, executorId, key);
      result = again.workspace ? await base.call(name, args, { ...opts, context: { scope, workspace: again.workspace } }) : { content: `${result.content}${again.note ? `\n${again.note}` : ''}`, isError: true };
    }
    const content = result.content.replace(WORKSPACE_MARK, '');
    return { ...result, content: placed.note ? `${content}\n${placed.note}` : content };
  }

  private executorHandle(sessionId: string): ExecutorHandle {
    const base = this.executor.handle(
      () => this.executorForSession(sessionId),
      () => {
        const s = this.sessions.get(sessionId);
        return s?.meta.project && s.meta.executorId === this.executorForSession(sessionId) ? s.meta.project : undefined;
      },
    );
    const brain = this;
    return {
      get root() {
        return base.root;
      },
      get id() {
        return base.id;
      },
      get online() {
        return base.online;
      },
      get info() {
        return base.info;
      },
      call: (name, args, opts = {}) => brain.callForChat(sessionId, base, name, args, opts),
    };
  }

  /** Stops what a chat has going on its VS Code computer; with `workspace` only what runs inside that desktop. */
  private killJobs(sessionId: string, workspace?: string): void {
    const executorId = this.executorForSession(sessionId);
    if (!executorId || !this.executor.info(executorId)?.capabilities?.includes('workspace-env')) return;
    const userId = this.sessions.get(sessionId)?.meta.userId ?? OWNER_ID;
    this.executor.killJobs(executorId, jobScope({ accountId: this.accountId, userId, sessionId }), workspace);
  }

  /** A subagent is over: its desktop was its alone and goes with it, files and all. */
  private closeDesktop(sessionId: string, agent: string): void {
    const record = this.desktops.remove(sessionId, agent);
    if (!record) return;
    this.killJobs(sessionId, record.id);
    void this.controlDesktop(record, 'delete');
  }

  /** A chat is being deleted: its desktops go with what they stored, wherever they are, and its jobs on the executor are stopped. */
  private releaseSession(s: Session): void {
    this.killJobs(s.id);
    // What this run addressed, on whichever computers, and the chat's own desktop on the computer it uses now: an
    // earlier run of the daemon may have started that one, and its browser profile is there either way.
    const known = this.desktops.removeSession(s.id);
    const current = this.desktopRecord(s.id, MAIN_DESKTOP);
    this.desktops.removeSession(s.id);
    for (const record of [...known, ...(current && !known.some((r) => r.id === current.id && r.deviceId === current.deviceId) ? [current] : [])]) {
      void this.controlDesktop(record, 'delete', record.key === MAIN_DESKTOP ? { children: true } : {});
    }
  }

  /** What the phone shows about a chat's desktops: whether it has any, and how each one stands on its computer. */
  private async workspaceStatus(session: Session, requestId: string, error?: string): Promise<PayloadOf<'workspace.result'>> {
    const sessionId = session.id;
    const base = { requestId, sessionId, ...(error ? { error: error.slice(0, 500) } : {}) };
    const deviceId = this.pcForSession(sessionId);
    if (!deviceId) return { ...base, supported: false, desktops: [], reason: 'This chat has no computer with PocketClipboard.' };
    const computer = { deviceId, name: this.state.devices.find((d) => d.deviceId === deviceId)?.name ?? deviceId, online: this.link.isOnline(deviceId) };
    const mode = this.desktopMode(deviceId);
    if (mode !== 'desktop') {
      const reason =
        mode === 'refuse'
          ? this.oldLinux(deviceId)
          : /^linux/i.test(this.executor.info(deviceId)?.os ?? '')
            ? "Per-chat desktops are switched off on this computer: chats use its real screen and clipboard."
            : 'Chats use the real screen of this computer. Desktops of their own exist on Linux computers.';
      return { ...base, supported: false, computer, desktops: [], reason: reason.slice(0, 500) };
    }
    const main = this.desktopRecord(sessionId, MAIN_DESKTOP);
    if (!main) return { ...base, supported: false, computer, desktops: [] };
    const records = [main, ...this.desktops.list(sessionId).filter((r) => r.key !== MAIN_DESKTOP)];
    if (computer.online) {
      await Promise.all(
        records.map(async (record) => {
          const answer = await this.controlDesktop(record, 'status');
          if (answer.workspace) this.desktops.note(sessionId, record.key, answer.workspace, Date.now());
        }),
      );
    }
    return { ...base, supported: true, computer, desktops: records.slice(0, 50).map((r) => desktopOf(r, r.info)) };
  }

  /** Closes a chat's desktop (or one subagent's) because its person asked; `wipe` also removes what it stored. */
  private async resetWorkspace(session: Session, key: string | undefined, wipe: boolean): Promise<string | undefined> {
    const sessionId = session.id;
    if (key !== undefined && key !== MAIN_DESKTOP) {
      const record = this.desktops.get(sessionId, key);
      if (!record) return 'That desktop is gone already.';
      // A subagent's desktop is never kept: closing it removes it.
      this.desktops.remove(sessionId, key);
      session.resetDesktop(key, 'deleted');
      this.killJobs(sessionId, record.id);
      return (await this.controlDesktop(record, 'delete')).error;
    }
    const main = this.desktopRecord(sessionId, MAIN_DESKTOP);
    if (!main) return 'This chat has no desktop of its own.';
    const records = this.desktops.list(sessionId);
    // Deleting asks nothing of the programs on a desktop: what the chat left running there can go at once.
    if (wipe) for (const record of records) this.killJobs(sessionId, record.id);
    for (const record of records) if (record.key !== MAIN_DESKTOP) this.desktops.remove(sessionId, record.key);
    // The screenshots the agents hold show a desktop that is about to be gone: their next step starts from a new one.
    session.resetDesktop(undefined, wipe ? 'deleted' : 'reset');
    const answer = await this.controlDesktop(main, wipe ? 'delete' : 'reset', { children: true });
    // A desktop that keeps its files closes in order: its programs are asked to close first, and a browser one of
    // the chat's commands started is a program like any other. What is left of the chat's jobs there is stopped
    // after that; stopped before, such a browser was ended without having been asked.
    if (!wipe) for (const record of records) this.killJobs(sessionId, record.id);
    if (answer.workspace) this.desktops.note(sessionId, MAIN_DESKTOP, answer.workspace, Date.now());
    return answer.error;
  }

  /** A chat that is working keeps its desktops from being closed as unused; one that was closed is not started for this. */
  private keepDesktopsAlive(): void {
    for (const sessionId of this.desktops.sessions()) {
      const s = this.sessions.get(sessionId);
      if (!s || (s.meta.state === 'idle' && !s.busy)) continue;
      for (const record of this.desktops.list(sessionId)) {
        const generation = record.info?.state === 'running' ? record.info.generation : 0;
        if (!generation || !this.link.isOnline(record.deviceId)) continue;
        void this.controlDesktop(record, 'ensure', { generation }).then((answer) => {
          if (answer.workspace) this.desktops.note(sessionId, record.key, answer.workspace, Date.now());
        });
      }
    }
  }

  /**
   * The computer a chat works on, or undefined for the Mac itself. Only the owner's chats work on the Mac:
   * other people's chats fall back to their default computer; without one they run on the Mac in chat-only mode.
   */
  private executorForSession(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const userId = s.meta.userId ?? OWNER_ID;
    const mine = this.executorDevices(userId);
    const chosen = s.meta.executorId;
    // An invited person's chat marked for the Mac works in their own folder there, even with a tools computer of their own.
    if (chosen === MAC_DEVICE_ID) return undefined;
    if (chosen && mine.some((d) => d.deviceId === chosen) && this.hasTools(chosen)) return chosen;
    if (this.isOwner(userId)) return undefined;
    const tools = mine.filter((d) => this.hasTools(d.deviceId)).sort((a, b) => a.pairedAt - b.pairedAt);
    const active = this.state.activeExecutors?.[userId];
    return (tools.find((d) => d.deviceId === active) ?? tools[0])?.deviceId;
  }

  private macProjects(): Project[] {
    const used = new Map<string, number>();
    for (const s of this.sessions.values()) {
      if (s.meta.project && !this.executorForSession(s.id)) used.set(s.meta.project, Math.max(used.get(s.meta.project) ?? 0, s.meta.updatedAt));
    }
    const out = new Map<string, Project>();
    const add = (path: string, lastOpened?: number) => {
      if (out.has(path)) return;
      try {
        if (!statSync(path).isDirectory()) return;
      } catch {
        return;
      }
      out.set(path, { path, name: basename(path), open: false, ...(lastOpened ? { lastOpened } : {}) });
    };
    for (const [path, at] of [...used.entries()].sort((a, b) => b[1] - a[1])) add(path, at);
    const docs = join(homedir(), 'Documents');
    try {
      const repos = readdirSync(docs, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(docs, e.name, '.git')))
        .map((e) => ({ path: join(docs, e.name), at: statSync(join(docs, e.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const r of repos) add(r.path, Math.round(r.at));
    } catch {}
    return [...out.values()].slice(0, 30);
  }

  private computers(userId: string): PayloadOf<'computers.result'> {
    return {
      computers: this.executorDevices(userId).map((d) => {
        const info = this.executor.info(d.deviceId);
        return {
          deviceId: d.deviceId,
          name: d.name,
          online: this.link.isOnline(d.deviceId),
          ...(info?.os ? { os: info.os } : {}),
          workspaces: info?.workspaces ?? [],
          ...(info?.projects ? { projects: info.projects } : {}),
          ...(info?.capabilities ? { capabilities: info.capabilities } : {}),
          pairedAt: d.pairedAt,
        };
      }),
      activeId: this.defaultExecutor(userId) ?? null,
      // Invited people see the Mac too (their chats work in their own folder there), never the owner's projects.
      mac: { name: hostname().replace(/\.local$/, ''), projects: this.isOwner(userId) ? this.macProjects() : [] },
    };
  }

  private broadcastComputers(): void {
    for (const u of this.state.users) {
      if (this.state.devices.some((d) => d.userId === u.id && d.role === 'client' && this.link.isOnline(d.deviceId))) {
        this.toClients(u.id, { type: 'computers.result', payload: this.computers(u.id) }, undefined, true);
      }
    }
  }

  allowlist(): string[] {
    return [...this.state.allowlist];
  }

  addAllowRule(rule: string): string | null {
    const error = validateRule(rule, [...TOOL_NAMES, COMPUTER_TOOL]);
    if (error) return error;
    if (!this.state.allowlist.includes(rule)) this.state.allowlist = [...this.state.allowlist, rule];
    this.persistNow();
    return null;
  }

  removeAllowRule(rule: string): boolean {
    const before = this.state.allowlist.length;
    this.state.allowlist = this.state.allowlist.filter((r) => r !== rule);
    this.persistNow();
    return this.state.allowlist.length !== before;
  }

  /** Stops everything, or everything of one person. */
  kill(userId?: string): void {
    log(userId ? `kill switch for ${this.userName(userId)}` : 'kill switch');
    const mine = (sessionId: string) => userId === undefined || this.userOfSession(sessionId) === userId;
    for (const p of this.permissions.outstanding()) if (mine(p.sessionId)) this.permissions.respond(p.requestId, 'deny', 'kill-switch');
    this.executor.killAll(userId === undefined ? undefined : this.executorDevices(userId).map((d) => d.deviceId));
    for (const s of this.sessions.values()) if (mine(s.id)) s.stop();
  }

  private onControl(frame: RelayToDevice): void {
    if (frame.t === 'pair.incoming') {
      this.onPairIncoming(frame.pairingId, frame.deviceId, frame.blob);
      return;
    }
    if (frame.t === 'error') log(`relay error ${frame.code}: ${frame.message}`);
  }

  private onPairIncoming(pairingId: string, deviceId: string, blob: string): void {
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.expiresAt < Date.now()) {
      log(`pairing ${pairingId} unknown or expired`);
      return;
    }
    let request;
    try {
      request = openPairRequest({ brain: this.identity, code: pairing.code, blob });
    } catch (e) {
      log(`rejected pairing request: ${String(e)}`);
      return;
    }
    if (request.deviceId !== deviceId) return;
    if (pairing.userId === undefined) {
      // First device through an invite: register the person. Later devices with the same code join them.
      const name = (request.userName?.trim() || pairing.invite?.name?.trim() || request.name).slice(0, 64);
      const user: User = { id: randomUUID().slice(0, 8), name, createdAt: Date.now() };
      this.state.users.push(user);
      pairing.userId = user.id;
      log(`registered "${user.name}" (${user.id})`);
    }
    const userId = pairing.userId;
    for (const old of this.state.devices.filter((d) => d.userId === userId && d.role === request.role && d.name === request.name && d.deviceId !== request.deviceId)) {
      this.removeDevice(old.deviceId);
    }
    const device: PairedDevice = {
      deviceId: request.deviceId,
      role: request.role as PairedDevice['role'],
      name: request.name,
      signPub: request.signPub,
      encPub: request.encPub,
      pairedAt: Date.now(),
      userId,
    };
    this.state.devices = [...this.state.devices.filter((d) => d.deviceId !== device.deviceId), device];
    this.persistNow();
    this.link.addPeer(device.deviceId, device.encPub);
    this.link.sendControl({ t: 'roster.add', entry: { deviceId: device.deviceId, role: device.role, name: device.name, signPub: device.signPub } });
    const reply = sealPairReply({ ok: true, accountId: this.accountId, brainDeviceId: this.deviceId, roster: [] }, device.encPub);
    this.link.sendControl({ t: 'pair.reply', pairingId, deviceId, blob: reply });
    log(`paired ${device.role} "${device.name}" (${device.deviceId}) for ${this.userName(userId)}`);
    if (device.role === 'executor') this.broadcastComputers();
    pairing.onPaired?.(device);
  }

  private async onMessage({ from, message }: IncomingMessage): Promise<void> {
    const device = this.state.devices.find((d) => d.deviceId === from);
    if (!device) return;

    if (device.role === 'executor') {
      switch (message.type) {
        case 'tool.result':
          return this.executor.handleResult(from, message.payload);
        case 'tool.output':
          return this.executor.handleOutput(from, message.payload);
        case 'clipboard.data':
        case 'clipboard.done':
        case 'screen.image':
        case 'computer.done':
        case 'workspace.state':
        case 'camera.frame': {
          const req = this.pcRequests.get(message.payload.requestId);
          if (!req || req.deviceId !== from) return;
          clearTimeout(req.timer);
          this.pcRequests.delete(message.payload.requestId);
          req.resolve(message);
          return;
        }
        case 'executor.status':
          this.executor.setInfo(from, message.payload);
          this.broadcastComputers();
          return this.broadcastStatus();
        case 'session.list':
          if (this.isOverlay(from)) this.link.send(from, { type: 'session.list.result', payload: { sessions: this.sortedSessions(device.userId) } });
          return;
        case 'session.history': {
          const s = this.isOverlay(from) ? this.sessions.get(message.payload.sessionId) : undefined;
          if (s && this.userOfSession(s.id) === device.userId) this.link.send(from, { type: 'session.history.result', payload: { sessionId: s.id, events: this.historyFor(from, s) } });
          return;
        }
        case 'message.send': {
          // The overlay window writes into its person's chats: text only. Tool approvals stay on the phone.
          if (!this.isOverlay(from)) return;
          const s = this.sessions.get(message.payload.sessionId);
          if (!s || this.userOfSession(s.id) !== device.userId) return this.sendError(from, 'unknown_session', 'Session not found');
          return this.sendTurn(s, { text: message.payload.text, from }, from);
        }
        case 'models.get':
          if (this.isOverlay(from)) this.link.send(from, { type: 'models.result', payload: { models: await this.listModels(this.isOwner(device.userId), message.payload.supportsUltra === true) } });
          return;
        case 'session.configure': {
          // The window's model and thinking pickers, for its person's chats.
          if (!this.isOverlay(from)) return;
          const s = this.sessions.get(message.payload.sessionId);
          if (!s || this.userOfSession(s.id) !== device.userId) return this.sendError(from, 'unknown_session', 'Session not found', message.payload.sessionId);
          return this.configureSession(s, message.payload, from);
        }
        default:
          return;
      }
    }

    // Everything below is scoped to the person this client belongs to.
    const userId = device.userId;
    const owner = this.isOwner(userId);
    const mySession = (sessionId: string): Session | undefined => {
      const s = this.sessions.get(sessionId);
      return s && this.userOfSession(s.id) === userId ? s : undefined;
    };
    const myComputer = (deviceId: string) => this.executorDevices(userId).some((d) => d.deviceId === deviceId);

    switch (message.type) {
      case 'status.get': {
        // What the client says it understands is remembered with the device, also while it is offline: events of a
        // kind an older build cannot read are never sent to it.
        const features = message.payload.features ?? [];
        if (features.join('\n') !== (device.features ?? []).join('\n')) {
          if (features.length) device.features = [...features];
          else delete device.features;
          this.schedulePersist();
        }
        this.sendStatus(from);
        // A client that connects while children are at work gets their cards as they stand, not as history left them.
        if (this.supports(from, PEER_FEATURES.subagents)) {
          for (const s of this.sessions.values()) {
            if (this.userOfSession(s.id) !== userId) continue;
            for (const event of s.liveSubagentEvents()) this.link.send(from, { type: 'session.event', payload: { sessionId: s.id, event } });
          }
        }
        return;
      }
      case 'session.list':
        this.link.send(from, { type: 'session.list.result', payload: { sessions: this.sortedSessions(userId) } });
        return;
      case 'session.create': {
        const now = Date.now();
        const meta: SessionMeta = {
          sessionId: randomUUID(),
          title: message.payload.title?.trim() || `Chat ${new Date(now).toLocaleString('ru-RU')}`,
          state: 'idle',
          createdAt: now,
          updatedAt: now,
          userId,
          ...(message.payload.systemPrompt ? { systemPrompt: message.payload.systemPrompt } : {}),
          // Invited people start on the Mac, in their own folder; they can move a chat to their own computer.
          ...(owner ? {} : { executorId: MAC_DEVICE_ID }),
        };
        this.sessions.set(meta.sessionId, new Session(meta, this.sessionHost(), false));
        this.schedulePersist();
        this.toClients(userId, { type: 'session.created', payload: { session: meta } });
        return;
      }
      case 'session.history': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        this.link.send(from, { type: 'session.history.result', payload: { sessionId: s.id, events: this.historyFor(from, s) } });
        return;
      }
      case 'workspace.get': {
        const { requestId, sessionId } = message.payload;
        const s = mySession(sessionId);
        this.link.send(from, { type: 'workspace.result', payload: s ? await this.workspaceStatus(s, requestId) : { requestId, sessionId, supported: false, desktops: [], error: 'Session not found' } });
        return;
      }
      case 'workspace.preview': {
        const { requestId, sessionId } = message.payload;
        const key = message.payload.key ?? MAIN_DESKTOP;
        const s = mySession(sessionId);
        // Only a desktop of a chat of this person is ever looked into, and looking does not start or touch it.
        const record = s ? (key === MAIN_DESKTOP ? this.desktopRecord(s.id, MAIN_DESKTOP) : this.desktops.get(s.id, key)) : undefined;
        if (!record) {
          this.link.send(from, { type: 'workspace.preview.result', payload: { requestId, sessionId, key, error: s ? 'This chat has no such desktop right now.' : 'Session not found' } });
          return;
        }
        const answer = await this.controlDesktop(record, 'capture');
        if (answer.workspace) this.desktops.note(sessionId, key, answer.workspace, Date.now());
        this.link.send(from, {
          type: 'workspace.preview.result',
          payload: { requestId, sessionId, key, ...(answer.image ? { image: answer.image } : { error: answer.error ?? 'The computer sent no picture' }), ...(answer.workspace ? { generation: answer.workspace.generation } : {}) },
        });
        return;
      }
      case 'workspace.reset': {
        const { requestId, sessionId, key, wipe } = message.payload;
        const s = mySession(sessionId);
        if (!s) {
          this.link.send(from, { type: 'workspace.result', payload: { requestId, sessionId, supported: false, desktops: [], error: 'Session not found' } });
          return;
        }
        const failed = await this.resetWorkspace(s, key, wipe === true);
        log(`desktop of chat ${s.id.slice(0, 8)}${key && key !== MAIN_DESKTOP ? ` (subagent ${key.slice(0, 12)})` : ''} ${wipe ? 'deleted' : 'closed'} by ${this.userName(userId)}${failed ? `: ${failed}` : ''}`);
        this.link.send(from, { type: 'workspace.result', payload: await this.workspaceStatus(s, requestId, failed) });
        return;
      }
      case 'subagent.cancel': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        // Only that child is stopped: its siblings, the chat's own reply and every other chat go on.
        await s.cancelSubagent(message.payload.id).catch((e: unknown) => this.sendError(from, 'subagent_cancel_failed', e instanceof Error ? e.message : String(e), s.id));
        return;
      }
      case 'message.send': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        return this.sendTurn(s, { text: message.payload.text, attachments: message.payload.attachments, from, ...(message.payload.voice ? { voice: true } : {}) }, from);
      }
      case 'session.interrupt':
        return mySession(message.payload.sessionId)?.interrupt();
      case 'permission.respond': {
        const sessionId = this.permissionSession(message.payload.requestId);
        if (sessionId && this.userOfSession(sessionId) === userId) this.permissions.respond(message.payload.requestId, message.payload.decision, from);
        return;
      }
      case 'control.kill':
        return this.kill(userId);
      case 'session.configure': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found', message.payload.sessionId);
        return this.configureSession(s, message.payload, from);
      }
      case 'session.hide':
        mySession(message.payload.sessionId)?.setHidden(message.payload.hidden);
        return;
      case 'session.delete': {
        const s = mySession(message.payload.sessionId);
        if (!s) return;
        for (const p of this.permissions.outstanding()) if (p.sessionId === s.id) this.permissions.respond(p.requestId, 'deny', 'deleted');
        this.releaseSession(s);
        s.destroy();
        this.sessions.delete(s.id);
        this.persistNow();
        this.toClients(userId, { type: 'session.deleted', payload: { sessionId: s.id } });
        return;
      }
      case 'session.rename': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        s.rename(message.payload.title.trim());
        return;
      }
      case 'models.get':
        this.link.send(from, { type: 'models.result', payload: { models: await this.listModels(owner, message.payload.supportsUltra === true) } });
        return;
      case 'activity.get':
        this.link.send(from, { type: 'activity.result', payload: this.activity(userId) });
        return;
      case 'computers.get':
        this.link.send(from, { type: 'computers.result', payload: this.computers(userId) });
        return;
      case 'computer.select': {
        const { deviceId, sessionId, project } = message.payload;
        if (deviceId === MAC_DEVICE_ID) {
          // Invited people work on the Mac too, but only inside their own folder; a project elsewhere is ignored.
          if (sessionId) mySession(sessionId)?.setExecutor(owner ? undefined : MAC_DEVICE_ID, owner ? project : undefined);
        } else {
          if (!myComputer(deviceId)) return this.sendError(from, 'unknown_computer', 'That computer is not paired');
          if (sessionId && this.hasTools(deviceId)) mySession(sessionId)?.setExecutor(deviceId, project);
          else this.setActiveExecutor(userId, deviceId);
        }
        this.schedulePersist();
        this.broadcastComputers();
        this.broadcastStatus();
        return;
      }
      case 'computer.open': {
        const { deviceId, path } = message.payload;
        if (!myComputer(deviceId)) return this.sendError(from, 'unknown_computer', 'That computer is not paired');
        if (!this.link.send(deviceId, { type: 'workspace.open', payload: { path } })) this.sendError(from, 'computer_offline', 'The computer is offline');
        return;
      }
      case 'clipboard.get':
      case 'clipboard.set':
      case 'screen.get': {
        const { requestId, deviceId } = message.payload;
        if (!myComputer(deviceId)) {
          const error = 'That computer is not paired';
          if (message.type === 'clipboard.get') this.link.send(from, { type: 'clipboard.result', payload: { requestId, deviceId, error } });
          else if (message.type === 'clipboard.set') this.link.send(from, { type: 'clipboard.written', payload: { requestId, deviceId, error } });
          else this.link.send(from, { type: 'screen.result', payload: { requestId, deviceId, error } });
          return;
        }
        this.setActiveExecutor(userId, deviceId);
        // Asked for by the person from their phone, not by a chat: this is about the computer's real clipboard and
        // screen, and says so, wherever the chats on that computer work.
        if (message.type === 'clipboard.get') {
          const r = await this.askPc(deviceId, { type: 'clipboard.read', payload: { requestId, scope: 'host' } });
          this.link.send(from, { type: 'clipboard.result', payload: { requestId, deviceId, ...(r.items ? { items: r.items } : {}), ...(r.error ? { error: r.error } : {}) } });
        } else if (message.type === 'clipboard.set') {
          const r = await this.askPc(deviceId, { type: 'clipboard.write', payload: { requestId, item: message.payload.item, scope: 'host' } });
          this.link.send(from, { type: 'clipboard.written', payload: { requestId, deviceId, ...(r.error ? { error: r.error } : {}) } });
        } else {
          const r = await this.askPc(deviceId, { type: 'screen.capture', payload: { requestId, scope: 'host' } });
          this.link.send(from, { type: 'screen.result', payload: { requestId, deviceId, ...(r.image ? { image: r.image } : {}), ...(r.error ? { error: r.error } : {}) } });
        }
        return;
      }
      case 'camera.watch': {
        const wanted = message.payload.deviceId;
        const deviceId = wanted && this.executorDevices(userId).some((d) => d.deviceId === wanted) ? wanted : this.defaultExecutor(userId);
        if (!deviceId) return this.sendError(from, 'no_computer', 'No computer is paired');
        const caps = this.executor.info(deviceId)?.capabilities ?? [];
        if (!caps.includes('camera')) return this.sendError(from, 'no_camera', 'That computer has no camera to look through');
        if (!this.cameraBaseUrl) return this.sendError(from, 'no_viewer', 'The relay that serves the camera viewer is not known yet');
        const view = this.cameraViews.open({ deviceId, userId });
        const url = `${this.cameraBaseUrl}/camera/${view.token}`;
        log(`camera: watch link for ${this.userName(userId)} on ${deviceId}, ${Math.round((view.expiresAt - Date.now()) / 1000)} s`);
        this.link.send(from, { type: 'camera.view', payload: { requestId: message.payload.requestId, url, expiresAt: view.expiresAt, deviceId } });
        return;
      }
      case 'computer.pair': {
        try {
          const ticket = this.startPairing(undefined, { userId });
          this.link.send(from, { type: 'computer.pairing', payload: { code: ticket.code, safetyNumber: ticket.safetyNumber, expiresAt: ticket.expiresAt, uri: ticket.uri } });
        } catch (e) {
          this.sendError(from, 'pairing_failed', e instanceof Error ? e.message : String(e));
        }
        return;
      }
      case 'computer.remove': {
        const target = this.executorDevices(userId).find((d) => d.deviceId === message.payload.deviceId);
        if (!target) return;
        this.removeDevice(target.deviceId);
        const panel = this.state.devices.find((d) => d.userId === userId && d.role === 'client' && d.name === `${target.name} (VS Code)`);
        if (panel) this.removeDevice(panel.deviceId);
        return;
      }
      case 'telegram.link': {
        const bot = this.state.telegram?.username;
        if (!bot) return this.sendError(from, 'no_telegram', 'No Telegram bot is set up on the Mac (pocket-claude telegram <token>)');
        try {
          const t = this.startPairing(undefined, { userId });
          this.link.send(from, { type: 'telegram.linking', payload: { url: `https://t.me/${bot}?start=${t.code}`, code: t.code, expiresAt: t.expiresAt } });
        } catch (e) {
          this.sendError(from, 'pairing_failed', e instanceof Error ? e.message : String(e));
        }
        return;
      }
      case 'device.unpair':
        this.removeDevice(from);
        return;
      case 'user.invite': {
        if (!owner) return this.sendError(from, 'not_owner', "Only the Mac's owner can invite people");
        try {
          const t = this.startPairing(undefined, { invite: {} });
          this.link.send(from, { type: 'user.invitation', payload: { uri: t.uri, code: t.code, safetyNumber: t.safetyNumber, expiresAt: t.expiresAt } });
        } catch (e) {
          this.sendError(from, 'pairing_failed', e instanceof Error ? e.message : String(e));
        }
        return;
      }
      default:
        return;
    }
  }

  async listModels(owner = true, supportsUltra = true): Promise<ModelInfo[]> {
    for (const s of this.sessions.values()) {
      if (!s.live) continue;
      try {
        const models = await s.supportedModels();
        if (models?.length) {
          this.models = models;
          break;
        }
      } catch (e) {
        log(`supportedModels failed: ${String(e)}`);
      }
    }
    const models = await withCodex(withOrca(withKimi(this.models ?? FALLBACK_MODELS)), owner, supportsUltra);
    return withMarket(models, owner, supportsUltra);
  }

  private activity(userId: string): PayloadOf<'activity.result'> {
    const pending = this.permissions.outstanding();
    const executor = this.defaultExecutor(userId);
    return {
      at: Date.now(),
      sessions: [...this.sessions.values()]
        .filter((s) => this.userOfSession(s.id) === userId && (s.live || s.meta.state !== 'idle' || s.busy))
        .map((s) => ({
          sessionId: s.id,
          title: s.meta.title,
          state: s.meta.state,
          live: s.live,
          ...(this.executorForSession(s.id) ? { executorId: this.executorForSession(s.id) } : {}),
          ...(s.meta.project ? { project: s.meta.project } : {}),
          ...(s.meta.model ? { model: s.meta.model } : {}),
          ...(s.meta.effort ? { effort: s.meta.effort } : {}),
          ...(s.meta.codexEffort ? { codexEffort: s.meta.codexEffort } : {}),
          runningTools: s.runningTools(),
          background: s.backgroundTasks(),
          agents: s.subagents(),
          pendingPermissions: pending.filter((p) => p.sessionId === s.id).length,
          ...(s.turnStarted ? { turnStartedAt: s.turnStarted } : {}),
        })),
      executor: {
        online: this.executor.online(executor),
        workspaces: this.executor.info(executor)?.workspaces ?? [],
        ...(this.executor.info(executor)?.os ? { os: this.executor.info(executor)!.os } : {}),
      },
      ...(this.claudeVersion ? { claudeVersion: this.claudeVersion } : {}),
      ...(this.kimiVersion ? { kimiVersion: this.kimiVersion } : {}),
    };
  }

  /** 'default' is the model list's name for no particular model. */
  private async configureSession(s: Session, p: PayloadOf<'session.configure'>, from: string): Promise<void> {
    try {
      await s.configure({ model: p.model === 'default' ? null : p.model, effort: p.effort, systemPrompt: p.systemPrompt });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`configure failed for ${s.id}: ${message}`);
      this.sendError(from, 'configure_failed', message, s.id, p.requestId);
    }
  }

  /** Starts a turn; if Claude cannot start, the device that wrote hears about it. */
  private async sendTurn(s: Session, turn: UserTurn, from: string): Promise<void> {
    this.enforceLiveLimit(s.id);
    try {
      await s.send(turn);
    } catch (e) {
      log(`send failed: ${String(e)}`);
      this.sendError(from, 'claude_failed', e instanceof Error ? e.message : String(e), s.id);
    }
  }

  private enforceLiveLimit(keepId: string): void {
    const live = [...this.sessions.values()].filter((s) => s.live && s.id !== keepId);
    while (live.length >= MAX_LIVE_SESSIONS) {
      const idle = live.filter((s) => s.meta.state === 'idle' && !s.busy).sort((a, b) => a.meta.updatedAt - b.meta.updatedAt)[0];
      if (!idle) break;
      idle.stop();
      live.splice(live.indexOf(idle), 1);
    }
  }

  private sessionHost() {
    return {
      executorFor: (sessionId: string) => this.executorHandle(sessionId),
      pcFor: (sessionId: string, agent?: string) => this.pcHandle(sessionId, agent),
      commandsInDesktop: (sessionId: string) => this.commandsInDesktop(sessionId),
      closeDesktop: (sessionId: string, agent: string) => this.closeDesktop(sessionId, agent),
      guestRoot: (sessionId: string) => this.guestRoot(sessionId),
      ownerChat: (sessionId: string) => this.isOwner(this.userOfSession(sessionId)),
      userName: (sessionId: string) => this.userName(this.userOfSession(sessionId)),
      emit: (sessionId: string, event: SessionEvent, durable: boolean) => this.emitEvent(sessionId, event, durable),
      metaChanged: (meta: SessionMeta) => {
        this.toClients(meta.userId ?? OWNER_ID, { type: 'session.updated', payload: { session: meta } }, undefined, true);
        this.schedulePersist();
      },
      canUseTool: async (sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal) => {
        const shown = toDisplayCall(tool.replace(/^mcp__pocket__/, ''), input);
        // Computer use is asked about once per chat, so the question is about the chat, not this one click.
        const asked =
          shown.name === COMPUTER_TOOL
            ? { description: computerConsent(this.pcHandle(sessionId).name, this.pcHandle(sessionId).desktop !== undefined), action: input.action }
            : shown.name === SANDBOX_NETWORK_TOOL
              ? { host: input.host, description: `Let a command in the Mac sandbox reach ${String(input.host)}` }
              : shown.input;
        const result = await this.permissions.decide(sessionId, shown.name, asked as Record<string, unknown>, signal);
        return result.behavior === 'allow' ? { ...result, updatedInput: input } : result;
      },
      claudeOptions: (): Partial<Options> => ({
        ...(this.state.model ? { model: this.state.model } : {}),
        ...(this.state.effort ? { effort: this.state.effort } : {}),
        ...this.opts.claudeOptions,
      }),
      onClaudeVersion: (v: string) => {
        if (v !== this.claudeVersion) {
          this.claudeVersion = v;
          this.broadcastStatus();
        }
      },
    };
  }

  /** Text deltas are coalesced and only sent to clients that are online; everything else is durable and buffered by the relay. */
  private emitEvent(sessionId: string, event: SessionEvent, durable: boolean): void {
    if (event.kind === 'text_delta') {
      const pending = this.pendingDeltas.get(sessionId);
      if (pending) {
        pending.text += event.text;
        return;
      }
      this.pendingDeltas.set(sessionId, {
        text: event.text,
        ...(event.at !== undefined ? { at: event.at } : {}),
        timer: setTimeout(() => this.flushDeltas(sessionId), DELTA_FLUSH_MS),
      });
      return;
    }
    this.flushDeltas(sessionId);
    if (event.kind === 'result') this.recordUsage(sessionId, event);
    const hint: PushHint | undefined = event.kind === 'result' ? 'completed' : undefined;
    this.toClients(this.userOfSession(sessionId), { type: 'session.event', payload: { sessionId, event } }, hint, !durable);
  }

  private recordUsage(sessionId: string, e: Extract<SessionEvent, { kind: 'result' }>): void {
    const day = new Date().toISOString().slice(0, 10);
    const add = (u: UsageTotals | undefined): UsageTotals => ({
      turns: (u?.turns ?? 0) + 1,
      costUsd: (u?.costUsd ?? 0) + (e.costUsd ?? 0),
      inputTokens: (u?.inputTokens ?? 0) + (e.inputTokens ?? 0),
      outputTokens: (u?.outputTokens ?? 0) + (e.outputTokens ?? 0),
      durationMs: (u?.durationMs ?? 0) + (e.durationMs ?? 0),
    });
    const usage = this.state.usage ?? { days: {}, sessions: {} };
    usage.days[day] = add(usage.days[day]);
    usage.sessions[sessionId] = add(usage.sessions[sessionId]);
    this.state.usage = usage;
    this.schedulePersist();
  }

  private flushDeltas(sessionId: string): void {
    const pending = this.pendingDeltas.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeltas.delete(sessionId);
    this.toClients(this.userOfSession(sessionId), { type: 'session.event', payload: { sessionId, event: { kind: 'text_delta', text: pending.text, ...(pending.at !== undefined ? { at: pending.at } : {}) } } }, undefined, true);
  }

  /** Whether a device said it understands something newer builds added: a client in its status request, a computer in its capabilities. */
  private supports(deviceId: string, feature: string): boolean {
    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    if (!device) return false;
    return device.role === 'client' ? device.features?.includes(feature) === true : this.executor.info(deviceId)?.capabilities?.includes(feature) === true;
  }

  /**
   * A chat's history as one device can read it: with the cards of its running children as they stand right now, and
   * without subagent cards altogether for a build from before them, which would reject the whole history otherwise.
   */
  private historyFor(deviceId: string, s: Session): SessionEvent[] {
    if (!this.supports(deviceId, PEER_FEATURES.subagents)) return s.history().filter((e) => e.kind !== 'subagent');
    return [...s.history(), ...s.liveSubagentEvents()];
  }

  /** Sends to one person's clients (and mirrors chat traffic to their overlay computers). */
  private toClients(userId: string, body: InnerMessageBody, pushHint?: PushHint, onlineOnly = false): void {
    // An older build drops a message it cannot parse, so it is simply not sent what it does not know.
    const needs = body.type === 'session.event' && body.payload.event.kind === 'subagent' ? PEER_FEATURES.subagents : undefined;
    for (const d of this.state.devices) {
      if (d.role !== 'client' || d.userId !== userId) continue;
      if (onlineOnly && !this.link.isOnline(d.deviceId)) continue;
      if (needs && !d.features?.includes(needs)) continue;
      this.link.send(d.deviceId, body, pushHint);
    }
    if (!OVERLAY_MIRRORED.has(body.type)) return;
    // The relay never queues for executors, so only online overlays matter; they fetch history when they come back.
    for (const d of this.executorDevices(userId)) {
      if (needs && !this.supports(d.deviceId, needs)) continue;
      if (this.isOverlay(d.deviceId) && this.link.isOnline(d.deviceId)) this.link.send(d.deviceId, body);
    }
  }

  private hostStatus(userId: string): InnerMessageBody {
    const executor = this.defaultExecutor(userId);
    const user = this.state.users.find((u) => u.id === userId);
    return {
      type: 'host.status',
      payload: {
        ready: !!this.claudeVersion,
        ...(this.claudeVersion ? {} : { reason: 'Claude Code was not found on the Mac' }),
        ...(this.claudeVersion ? { claudeVersion: this.claudeVersion } : {}),
        ...(this.kimiVersion ? { kimiVersion: this.kimiVersion } : {}),
        executorOnline: this.executor.online(executor),
        workspaces: this.executor.info(executor)?.workspaces ?? [],
        ...(user ? { user: { id: user.id, name: user.name, owner: user.owner === true } } : {}),
        ...(this.state.telegram ? { telegramBot: this.state.telegram.username } : {}),
        features: FEATURES,
      },
    };
  }

  private sendStatus(to: string): void {
    const userId = this.userOf(to);
    if (!userId) return;
    this.link.send(to, this.hostStatus(userId));
    this.link.send(to, { type: 'computers.result', payload: this.computers(userId) });
    this.link.send(to, { type: 'session.list.result', payload: { sessions: this.sortedSessions(userId) } });
  }

  private broadcastStatus(pushHint?: PushHint): void {
    for (const u of this.state.users) this.toClients(u.id, this.hostStatus(u.id), pushHint, !pushHint);
  }

  private sendError(to: string, code: string, message: string, sessionId?: string, requestId?: string): void {
    this.link.send(to, { type: 'error', payload: { code, message, ...(sessionId ? { sessionId } : {}), ...(requestId !== undefined ? { requestId } : {}) } });
  }

  private sortedSessions(userId: string): SessionMeta[] {
    return [...this.sessions.values()]
      .filter((s) => this.userOfSession(s.id) === userId)
      .map((s) => s.meta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async detectClaudeVersion(): Promise<void> {
    const executable = this.opts.claudeOptions?.pathToClaudeCodeExecutable ?? 'claude';
    try {
      const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 15_000 });
      this.claudeVersion = stdout.trim().split(' ')[0] ?? stdout.trim();
    } catch (e) {
      log(`claude --version failed: ${String(e)}`);
    }
    this.broadcastStatus();
  }

  private async detectKimiVersion(): Promise<void> {
    try {
      const { stdout } = await promisify(execFile)(resolveKimi(), ['--version'], { timeout: 15_000 });
      this.kimiVersion = stdout.trim().split(' ')[0] ?? stdout.trim();
    } catch (e) {
      log(`kimi --version failed: ${String(e)}`);
    }
    this.broadcastStatus();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persistNow(), 1_000);
  }

  private persistNow(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.state.sessions = [...this.sessions.values()].map((s) => s.meta);
    this.state.replay = this.link.replayState();
    if (this.opts.persist !== false) saveState(this.state);
  }
}
