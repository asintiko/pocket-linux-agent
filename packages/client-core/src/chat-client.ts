import { newMessageId, normalizeSystemPrompt, PEER_FEATURES, type ClipboardItem, type Computer, type Project, type Effort, type Identity, type InnerMessageBody, type ModelInfo, type PayloadOf, type PermissionDecision, type ScreenImage, type SessionEvent, type SessionMeta } from '@pocket/protocol';
import { DeviceLink, type IncomingMessage, type WebSocketCtor } from '@pocket/transport';
import { applyEvent, buildThread, subagentEnded, type ChatItem } from './thread.js';

const DELTA_INTERVAL_MS = 120;

export type HostStatus = PayloadOf<'host.status'>;
export type PermissionRequest = PayloadOf<'permission.request'>;
export type Activity = PayloadOf<'activity.result'>;
export type PairingTicket = PayloadOf<'computer.pairing'>;
export type Invitation = PayloadOf<'user.invitation'>;
export type TelegramLink = PayloadOf<'telegram.linking'>;
/** The desktops of one chat on its Linux computer, as the Mac reports them. */
export type WorkspaceStatus = PayloadOf<'workspace.result'>;

/** What this build understands beyond the first protocol; the Mac only sends such things to devices that say so. */
const FEATURES = [PEER_FEATURES.subagents, PEER_FEATURES.workspaces];

export interface ChatState {
  connection: 'connecting' | 'online' | 'offline';
  brainOnline: boolean;
  host: HostStatus | null;
  sessions: SessionMeta[];
  threads: Record<string, ChatItem[]>;
  /** Sessions whose full history has been loaded from the brain. */
  loaded: Record<string, boolean>;
  /** Most recent configuration error for each session. */
  configureErrors: Record<string, string>;
  permissions: PermissionRequest[];
  models: ModelInfo[];
  activity: Activity | null;
  computers: Computer[];
  /** Default computer for the clipboard. */
  activeComputer: string | null;
  /** The Mac itself as a place to work, with its projects. */
  mac: { name: string; projects: Project[] } | null;
  /** Code to type into VS Code on a new computer, while a pairing is open. */
  pairing: PairingTicket | null;
  /** Link that registers a new person, after `invite()`; owners only. */
  invitation: Invitation | null;
  /** Link that connects the Mac's Telegram bot to this person, after `linkTelegram()`. */
  telegramLink: TelegramLink | null;
  /** Per chat, its desktops on a Linux computer as last reported; see `loadWorkspace()`. */
  workspaces: Record<string, WorkspaceStatus>;
  lastError: string | null;
}

export interface ClientCredentials {
  relayUrl: string;
  accountId: string;
  deviceId: string;
  identity: Identity;
  brainDeviceId: string;
  brainEncPub: string;
}

export interface ChatClientOptions extends ClientCredentials {
  WebSocket?: WebSocketCtor;
  replayState?: Record<string, number>;
  log?: (m: string) => void;
  /** The brain announced a new relay address; persist it so the next start uses it. */
  onRelayMoved?: (url: string) => void;
  /** False for clients on the relay's own machine: they keep the local address the brain advertises around. */
  followRelayMoves?: boolean;
  /** How long streamed text is batched before listeners see it (default 120 ms). */
  deltaIntervalMs?: number;
}

/** Only http(s) relay addresses are followed. */
export function isRelayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

const INITIAL: ChatState = {
  connection: 'connecting',
  brainOnline: false,
  host: null,
  sessions: [],
  threads: {},
  loaded: {},
  configureErrors: {},
  permissions: [],
  models: [],
  activity: null,
  computers: [],
  activeComputer: null,
  mac: null,
  pairing: null,
  invitation: null,
  telegramLink: null,
  workspaces: {},
  lastError: null,
};

/**
 * Client-side model of the account: sessions, chat threads and pending permission prompts.
 * Shared by the Android app and the VS Code chat panel. Framework-agnostic: subscribe and render `getState()`.
 */
export class ChatClient {
  private readonly link: DeviceLink;
  private state: ChatState = INITIAL;
  private readonly listeners = new Set<(s: ChatState) => void>();
  /** Streamed text waiting to be applied: deltas are batched so the UI re-renders a few times a second, not on every word. */
  private pendingDelta: { sessionId: string; text: string; at?: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly latestConfigureRequest = new Map<string, string>();
  private readonly pendingCreate: ((id: string) => void)[] = [];
  private readonly clipboardWaiters = new Map<string, { resolve: (items: ClipboardItem[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly screenWaiters = new Map<string, { resolve: (image: ScreenImage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private cameraWaiters = new Map<string, { resolve: (view: { url: string; expiresAt: number }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly workspaceWaiters = new Map<string, { resolve: (status: WorkspaceStatus) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly previewWaiters = new Map<string, { resolve: (preview: { image: ScreenImage; generation?: number }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly opts: ChatClientOptions) {
    this.link = new DeviceLink({
      relayUrl: opts.relayUrl,
      accountId: opts.accountId,
      deviceId: opts.deviceId,
      role: 'client',
      identity: opts.identity,
      peers: { [opts.brainDeviceId]: opts.brainEncPub },
      WebSocket: opts.WebSocket,
      replayState: opts.replayState,
      log: opts.log,
    });
    this.link.on('ready', (_roster, online) => {
      this.patch({ connection: 'online', brainOnline: online.includes(opts.brainDeviceId) });
      this.requestStatus();
      if (online.includes(opts.brainDeviceId)) this.reloadLiveSubagents();
    });
    this.link.on('disconnected', () => this.patch({ connection: 'offline', brainOnline: false }));
    this.link.on('presence', (deviceId, online) => {
      if (deviceId !== opts.brainDeviceId) return;
      this.patch({ brainOnline: online });
      if (!online) return;
      this.requestStatus();
      this.reloadLiveSubagents();
    });
    this.link.on('control', (f) => {
      if (f.t === 'error') this.patch({ lastError: f.message });
    });
    this.link.on('message', (m) => this.onMessage(m));
  }

  get deviceId(): string {
    return this.opts.deviceId;
  }

  connect(): void {
    this.link.connect();
  }

  close(): void {
    this.flushDelta();
    for (const w of this.clipboardWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Disconnected'));
    }
    this.clipboardWaiters.clear();
    for (const w of this.cameraWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Disconnected'));
    }
    this.cameraWaiters.clear();
    for (const w of [...this.workspaceWaiters.values(), ...this.previewWaiters.values()]) {
      clearTimeout(w.timer);
      w.reject(new Error('Disconnected'));
    }
    this.workspaceWaiters.clear();
    this.previewWaiters.clear();
    this.link.close();
  }

  replayState(): Record<string, number> {
    return this.link.replayState();
  }

  getState(): ChatState {
    return this.state;
  }

  subscribe(listener: (s: ChatState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Seeds the model from a cached snapshot so the UI has something to show before the brain answers. */
  hydrate(snapshot: Pick<ChatState, 'sessions' | 'threads'>): void {
    this.patch({ sessions: snapshot.sessions, threads: snapshot.threads });
  }

  snapshot(): Pick<ChatState, 'sessions' | 'threads'> {
    return { sessions: this.state.sessions, threads: this.state.threads };
  }

  refresh(): void {
    this.link.wake();
    this.requestStatus();
  }

  private requestStatus(): boolean {
    return this.request({ type: 'status.get', payload: { features: FEATURES } });
  }

  /**
   * Back in touch with the Mac: a card that says a child is still at work may have missed how it ended while this
   * device was away, so the chats that show one are read again. History holds every card as it stands now.
   */
  private reloadLiveSubagents(): void {
    for (const [sessionId, items] of Object.entries(this.state.threads)) {
      if (this.state.loaded[sessionId] && items.some((it) => it.type === 'subagent' && !subagentEnded(it.status))) this.loadHistory(sessionId);
    }
  }

  /** Whether the Mac's Pocket is new enough for per-chat desktops; older ones do not answer the workspace requests. */
  get supportsWorkspaces(): boolean {
    return this.state.host?.features?.includes(PEER_FEATURES.workspaces) === true;
  }

  /** Asks which desktops a chat has on its Linux computer; the answer also lands in `state.workspaces`. */
  loadWorkspace(sessionId: string): Promise<WorkspaceStatus> {
    const requestId = newMessageId();
    return this.awaitWorkspace(requestId, { type: 'workspace.get', payload: { requestId, sessionId } });
  }

  /** Closes a chat's desktop (or one subagent's with `key`); `wipe` also removes its browser profile and saved state. */
  resetWorkspace(sessionId: string, opts: { key?: string; wipe?: boolean } = {}): Promise<WorkspaceStatus> {
    const requestId = newMessageId();
    return this.awaitWorkspace(requestId, { type: 'workspace.reset', payload: { requestId, sessionId, ...(opts.key ? { key: opts.key } : {}), ...(opts.wipe ? { wipe: true } : {}) } });
  }

  /** A picture of a chat's desktop as it is right now; looking does not touch what the agent is doing there. */
  previewWorkspace(sessionId: string, key?: string): Promise<{ image: ScreenImage; generation?: number }> {
    const requestId = newMessageId();
    return new Promise((resolve, reject) => {
      if (!this.supportsWorkspaces) return reject(new Error('Pocket on the Mac is too old to show desktops'));
      if (!this.link.send(this.opts.brainDeviceId, { type: 'workspace.preview', payload: { requestId, sessionId, ...(key ? { key } : {}) } })) return reject(new Error('Not connected to the Mac'));
      const timer = setTimeout(() => {
        this.previewWaiters.delete(requestId);
        reject(new Error('The computer did not answer'));
      }, 45_000);
      this.previewWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  /** Stops one child agent of a chat; the others and the chat itself go on. Its card shows the outcome. */
  cancelSubagent(sessionId: string, id: string): boolean {
    return this.request({ type: 'subagent.cancel', payload: { sessionId, id } });
  }

  private awaitWorkspace(requestId: string, body: InnerMessageBody): Promise<WorkspaceStatus> {
    return new Promise((resolve, reject) => {
      if (!this.supportsWorkspaces) return reject(new Error('Pocket on the Mac is too old for per-chat desktops'));
      if (!this.link.send(this.opts.brainDeviceId, body)) return reject(new Error('Not connected to the Mac'));
      const timer = setTimeout(() => {
        this.workspaceWaiters.delete(requestId);
        reject(new Error('The Mac did not answer'));
      }, 45_000);
      this.workspaceWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  /** Resolves with the new session id once the brain confirms. */
  createSession(title?: string, systemPrompt?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let normalizedSystemPrompt: string | undefined;
      try {
        normalizedSystemPrompt = normalizeSystemPrompt(systemPrompt);
      } catch (e) {
        reject(e);
        return;
      }
      if (!this.request({ type: 'session.create', payload: { ...(title ? { title } : {}), ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}) } })) {
        reject(new Error('Not connected'));
        return;
      }
      this.pendingCreate.push(resolve);
    });
  }

  loadHistory(sessionId: string): void {
    this.request({ type: 'session.history', payload: { sessionId } });
  }

  send(sessionId: string, text: string, attachments?: { mime: string; dataBase64: string; name?: string }[], opts: { voice?: boolean } = {}): boolean {
    return this.request({ type: 'message.send', payload: { sessionId, text, ...(attachments?.length ? { attachments } : {}), ...(opts.voice ? { voice: true } : {}) } });
  }

  interrupt(sessionId: string): boolean {
    return this.request({ type: 'session.interrupt', payload: { sessionId } });
  }

  respondPermission(requestId: string, decision: PermissionDecision): boolean {
    const ok = this.request({ type: 'permission.respond', payload: { requestId, decision } });
    if (ok) this.patch({ permissions: this.state.permissions.filter((p) => p.requestId !== requestId) });
    return ok;
  }

  /** Blank clears; omission is unchanged. Return means sent; session.updated confirms success and configureErrors reports failures. */
  configure(sessionId: string, patch: { model?: string | null; effort?: Effort | null; systemPrompt?: string }): boolean {
    let normalizedSystemPrompt: string | undefined;
    try {
      if (patch.systemPrompt !== undefined) normalizedSystemPrompt = normalizeSystemPrompt(patch.systemPrompt);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.patch({ lastError: message, configureErrors: { ...this.state.configureErrors, [sessionId]: message } });
      return false;
    }

    const { systemPrompt, ...rest } = patch;
    const requestId = newMessageId();
    this.latestConfigureRequest.set(sessionId, requestId);
    const ok = this.request({
      type: 'session.configure',
      payload: { sessionId, requestId, ...rest, ...(systemPrompt !== undefined ? { systemPrompt: normalizedSystemPrompt ?? '' } : {}) },
    });
    const configureErrors = { ...this.state.configureErrors };
    delete configureErrors[sessionId];
    if (!ok) configureErrors[sessionId] = this.state.lastError ?? 'Not connected to the Mac';
    if (ok) {
      this.patch({
        configureErrors,
        sessions: this.state.sessions.map((s) =>
          s.sessionId !== sessionId
            ? s
            : {
                ...s,
                ...(patch.model !== undefined ? { model: patch.model && patch.model !== 'default' ? patch.model : undefined } : {}),
                ...(patch.effort !== undefined ? {
                  effort: patch.effort === 'ultra' ? undefined : patch.effort ?? undefined,
                  codexEffort: patch.effort === 'ultra' ? 'ultra' : undefined,
                } : {}),
              },
        ),
      });
    } else {
      this.patch({ configureErrors });
    }
    return ok;
  }

  rename(sessionId: string, title: string): boolean {
    return this.request({ type: 'session.rename', payload: { sessionId, title } });
  }

  loadModels(): boolean {
    return this.request({ type: 'models.get', payload: { supportsUltra: true } });
  }

  loadActivity(): boolean {
    return this.request({ type: 'activity.get', payload: {} });
  }

  loadComputers(): boolean {
    return this.request({ type: 'computers.get', payload: {} });
  }

  /** Moves a chat to a computer and makes it the default for new chats. */
  selectComputer(deviceId: string, sessionId?: string, project?: string | null): boolean {
    const ok = this.request({
      type: 'computer.select',
      payload: { deviceId, ...(sessionId ? { sessionId } : {}), ...(project !== undefined ? { project } : {}) },
    });
    if (ok) {
      this.patch({
        activeComputer: deviceId,
        sessions: sessionId
          ? this.state.sessions.map((s) =>
              s.sessionId !== sessionId
                ? s
                : { ...s, executorId: deviceId, project: project !== undefined ? (project ?? undefined) : s.executorId === deviceId ? s.project : undefined },
            )
          : this.state.sessions,
      });
    }
    return ok;
  }

  /** Computers whose clipboard the phone can use, the default one first. */
  clipboardComputers(): Computer[] {
    const list = this.state.computers.filter((c) => c.capabilities?.includes('clipboard'));
    return [...list].sort((a, b) => Number(b.deviceId === this.state.activeComputer) - Number(a.deviceId === this.state.activeComputer) || Number(b.online) - Number(a.online));
  }

  /** What is on that computer's clipboard right now. */
  readClipboard(deviceId: string): Promise<ClipboardItem[]> {
    const requestId = newMessageId();
    return this.awaitClipboard(requestId, { type: 'clipboard.get', payload: { requestId, deviceId } });
  }

  async writeClipboard(deviceId: string, item: ClipboardItem): Promise<void> {
    const requestId = newMessageId();
    await this.awaitClipboard(requestId, { type: 'clipboard.set', payload: { requestId, deviceId, item } });
  }

  /** A picture of that computer's screens right now (PocketClipboard with the 'screenshot' capability). */
  screenshot(deviceId: string): Promise<ScreenImage> {
    const requestId = newMessageId();
    return new Promise((resolve, reject) => {
      if (!this.link.send(this.opts.brainDeviceId, { type: 'screen.get', payload: { requestId, deviceId } })) return reject(new Error('Not connected to the Mac'));
      const timer = setTimeout(() => {
        this.screenWaiters.delete(requestId);
        reject(new Error('The computer did not answer'));
      }, 75_000);
      this.screenWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Asks the Mac for a link that shows that computer's camera for a few minutes. One viewer per link: opening another
   * makes a new one, and only the frames asked for are taken, so the camera is not held open between looks.
   */
  async watchCamera(deviceId?: string): Promise<{ url: string; expiresAt: number }> {
    const requestId = newMessageId();
    return new Promise((resolve, reject) => {
      const body = { type: 'camera.watch', payload: { requestId, ...(deviceId ? { deviceId } : {}) } } as unknown as InnerMessageBody;
      if (!this.link.send(this.opts.brainDeviceId, body)) return reject(new Error('Not connected to the Mac'));
      const timer = setTimeout(() => {
        this.cameraWaiters.delete(requestId);
        reject(new Error('The Mac did not answer'));
      }, 20_000);
      this.cameraWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  private awaitClipboard(requestId: string, body: InnerMessageBody): Promise<ClipboardItem[]> {
    return new Promise((resolve, reject) => {
      if (!this.link.send(this.opts.brainDeviceId, body)) return reject(new Error('Not connected to the Mac'));
      const timer = setTimeout(() => {
        this.clipboardWaiters.delete(requestId);
        reject(new Error('The computer did not answer'));
      }, 75_000);
      this.clipboardWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  private settleClipboard(requestId: string, items: ClipboardItem[] | undefined, error: string | undefined): void {
    const w = this.clipboardWaiters.get(requestId);
    if (!w) return;
    clearTimeout(w.timer);
    this.clipboardWaiters.delete(requestId);
    if (error) w.reject(new Error(error));
    else w.resolve(items ?? []);
  }

  /** Opens a project folder in a new VS Code window on that computer. */
  openProject(deviceId: string, path: string): boolean {
    return this.request({ type: 'computer.open', payload: { deviceId, path } });
  }

  hideSession(sessionId: string, hidden: boolean): boolean {
    const ok = this.request({ type: 'session.hide', payload: { sessionId, hidden } });
    if (ok) this.patch({ sessions: this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, hidden: hidden || undefined } : s)) });
    return ok;
  }

  deleteSession(sessionId: string): boolean {
    const ok = this.request({ type: 'session.delete', payload: { sessionId } });
    if (ok) this.forgetSession(sessionId);
    return ok;
  }

  private forgetSession(sessionId: string): void {
    this.latestConfigureRequest.delete(sessionId);
    const { [sessionId]: _thread, ...threads } = this.state.threads;
    const { [sessionId]: _loaded, ...loaded } = this.state.loaded;
    const { [sessionId]: _configureError, ...configureErrors } = this.state.configureErrors;
    const { [sessionId]: _workspace, ...workspaces } = this.state.workspaces;
    this.patch({
      sessions: this.state.sessions.filter((s) => s.sessionId !== sessionId),
      threads,
      loaded,
      configureErrors,
      workspaces,
      permissions: this.state.permissions.filter((p) => p.sessionId !== sessionId),
    });
  }

  /** Asks the brain for a one-time code; it arrives in `state.pairing`. */
  pairComputer(): boolean {
    this.patch({ pairing: null });
    return this.request({ type: 'computer.pair', payload: {} });
  }

  clearPairing(): void {
    this.patch({ pairing: null });
  }

  /** Owner only: asks for an invite link; it arrives in `state.invitation`. */
  invite(): boolean {
    this.patch({ invitation: null });
    return this.request({ type: 'user.invite', payload: {} });
  }

  clearInvitation(): void {
    this.patch({ invitation: null });
  }

  /** Asks for a Telegram deep link; it arrives in `state.telegramLink`. */
  linkTelegram(): boolean {
    this.patch({ telegramLink: null });
    return this.request({ type: 'telegram.link', payload: {} });
  }

  clearTelegramLink(): void {
    this.patch({ telegramLink: null });
  }

  /** Tells the Mac to forget this device; the caller wipes its keys afterwards. */
  unpairDevice(): boolean {
    return this.link.send(this.opts.brainDeviceId, { type: 'device.unpair', payload: {} });
  }

  /** Who this client belongs to, once the brain has said so. */
  get user(): HostStatus['user'] | undefined {
    return this.state.host?.user;
  }

  removeComputer(deviceId: string): boolean {
    return this.request({ type: 'computer.remove', payload: { deviceId } });
  }

  /** The computer a chat works on: its own choice if still paired, else the default. */
  computerFor(sessionId: string): Computer | undefined {
    const chosen = this.state.sessions.find((s) => s.sessionId === sessionId)?.executorId;
    return this.state.computers.find((c) => c.deviceId === chosen) ?? this.state.computers.find((c) => c.deviceId === this.state.activeComputer);
  }

  kill(): boolean {
    return this.request({ type: 'control.kill', payload: { scope: 'all' } });
  }

  clearError(): void {
    this.patch({ lastError: null, configureErrors: {} });
  }

  private request(body: InnerMessageBody): boolean {
    const ok = this.link.send(this.opts.brainDeviceId, body);
    if (!ok) this.patch({ lastError: 'Not connected to the Mac' });
    return ok;
  }

  private onMessage({ from, message }: IncomingMessage): void {
    if (from !== this.opts.brainDeviceId) return;
    switch (message.type) {
      case 'host.status':
        return this.patch({ host: message.payload, brainOnline: true });
      case 'session.list.result':
        return this.patch({ sessions: sortSessions(message.payload.sessions) });
      case 'session.created': {
        this.upsertSession(message.payload.session);
        this.patch({ loaded: { ...this.state.loaded, [message.payload.session.sessionId]: true } });
        this.pendingCreate.shift()?.(message.payload.session.sessionId);
        return;
      }
      case 'session.updated':
        return this.upsertSession(message.payload.session);
      case 'session.deleted':
        return this.forgetSession(message.payload.sessionId);
      case 'session.history.result':
        return this.patch({
          threads: { ...this.state.threads, [message.payload.sessionId]: buildThread(message.payload.events) },
          loaded: { ...this.state.loaded, [message.payload.sessionId]: true },
        });
      case 'session.event': {
        const { sessionId, event } = message.payload;
        if (event.kind === 'text_delta') {
          if (this.pendingDelta?.sessionId === sessionId) {
            this.pendingDelta.text += event.text;
            return;
          }
          this.flushDelta();
          this.pendingDelta = { sessionId, text: event.text, ...(event.at !== undefined ? { at: event.at } : {}), timer: setTimeout(() => this.flushDelta(), this.opts.deltaIntervalMs ?? DELTA_INTERVAL_MS) };
          return;
        }
        this.flushDelta();
        return this.applySessionEvent(sessionId, event);
      }
      case 'permission.request':
        if (this.state.permissions.some((p) => p.requestId === message.payload.requestId)) return;
        return this.patch({ permissions: [...this.state.permissions, message.payload] });
      case 'permission.resolved':
        return this.patch({ permissions: this.state.permissions.filter((p) => p.requestId !== message.payload.requestId) });
      case 'error': {
        const { requestId, sessionId } = message.payload;
        if (
          requestId !== undefined &&
          sessionId !== undefined &&
          this.latestConfigureRequest.get(sessionId) !== requestId
        ) return;
        return this.patch({
          lastError: message.payload.message,
          ...(message.payload.sessionId
            ? { configureErrors: { ...this.state.configureErrors, [message.payload.sessionId]: message.payload.message } }
            : {}),
        });
      }
      case 'models.result':
        return this.patch({ models: message.payload.models });
      case 'activity.result':
        return this.patch({ activity: message.payload });
      case 'computers.result': {
        const known = new Set(this.state.computers.map((c) => c.deviceId));
        const added = this.state.pairing && message.payload.computers.some((c) => !known.has(c.deviceId));
        return this.patch({
          computers: message.payload.computers,
          activeComputer: message.payload.activeId,
          mac: message.payload.mac ?? this.state.mac,
          ...(added ? { pairing: null } : {}),
        });
      }
      case 'computer.pairing':
        return this.patch({ pairing: message.payload });
      case 'user.invitation':
        return this.patch({ invitation: message.payload });
      case 'telegram.linking':
        return this.patch({ telegramLink: message.payload });
      case 'clipboard.result':
        return this.settleClipboard(message.payload.requestId, message.payload.items, message.payload.error);
      case 'clipboard.written':
        return this.settleClipboard(message.payload.requestId, [], message.payload.error);
      case 'screen.result': {
        const w = this.screenWaiters.get(message.payload.requestId);
        if (!w) return;
        clearTimeout(w.timer);
        this.screenWaiters.delete(message.payload.requestId);
        if (message.payload.image) w.resolve(message.payload.image);
        else w.reject(new Error(message.payload.error ?? 'No image'));
        return;
      }
      case 'camera.view': {
        const w = this.cameraWaiters.get(message.payload.requestId);
        if (!w) return;
        clearTimeout(w.timer);
        this.cameraWaiters.delete(message.payload.requestId);
        if (message.payload.error || !message.payload.url) w.reject(new Error(message.payload.error ?? 'No link'));
        else w.resolve({ url: message.payload.url, expiresAt: message.payload.expiresAt });
        return;
      }
      case 'workspace.result': {
        const status = message.payload;
        this.patch({ workspaces: { ...this.state.workspaces, [status.sessionId]: status } });
        const w = this.workspaceWaiters.get(status.requestId);
        if (!w) return;
        clearTimeout(w.timer);
        this.workspaceWaiters.delete(status.requestId);
        if (status.error) w.reject(new Error(status.error));
        else w.resolve(status);
        return;
      }
      case 'workspace.preview.result': {
        const w = this.previewWaiters.get(message.payload.requestId);
        if (!w) return;
        clearTimeout(w.timer);
        this.previewWaiters.delete(message.payload.requestId);
        if (message.payload.image) w.resolve({ image: message.payload.image, ...(message.payload.generation !== undefined ? { generation: message.payload.generation } : {}) });
        else w.reject(new Error(message.payload.error ?? 'No picture'));
        return;
      }
      case 'relay.moved':
        if (this.opts.followRelayMoves === false || !isRelayUrl(message.payload.url) || message.payload.url === this.link.currentRelayUrl) return;
        this.link.setRelayUrl(message.payload.url);
        this.opts.onRelayMoved?.(message.payload.url);
        return;
      default:
        return;
    }
  }

  private upsertSession(meta: SessionMeta): void {
    const others = this.state.sessions.filter((s) => s.sessionId !== meta.sessionId);
    this.patch({ sessions: sortSessions([...others, meta]) });
  }

  private applySessionEvent(sessionId: string, event: SessionEvent): void {
    const thread = this.state.threads[sessionId] ?? [];
    const patch: Partial<ChatState> = { threads: { ...this.state.threads, [sessionId]: applyEvent(thread, event) } };
    if (event.kind === 'state') {
      patch.sessions = this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, state: event.state } : s));
    }
    this.patch(patch);
  }

  private flushDelta(): void {
    const pending = this.pendingDelta;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDelta = null;
    this.applySessionEvent(pending.sessionId, { kind: 'text_delta', text: pending.text, ...(pending.at !== undefined ? { at: pending.at } : {}) });
  }

  private patch(p: Partial<ChatState>): void {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l(this.state);
  }
}

function sortSessions(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}
