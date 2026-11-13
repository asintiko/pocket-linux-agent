import * as os from 'node:os';
import { deserializeIdentity, workspaceErrorCodeSchema, type InnerMessageBody, type ScreenImage, type SerializedIdentity, type WorkspaceBinding, type WorkspaceErrorCode, type WorkspaceInfo } from '@pocket/protocol';
import { DeviceLink, type IncomingMessage, type WebSocketCtor } from '@pocket/transport';
import type { CameraBackend } from './camera-host.js';
import type { ClipboardBackend } from './clipboard.js';
import type { ComputerBackend } from './computer.js';
import type { ScreenBackend } from './screenshot.js';

export interface AgentState {
  relayUrl: string;
  accountId: string;
  brainDeviceId: string;
  brainEncPub: string;
  deviceId: string;
  identity: SerializedIdentity;
  replay: Record<string, number>;
  /** Show AI replies in the overlay window; unset means on (Windows only). */
  overlay?: boolean;
  /** Overlay colours; unset means dark. */
  overlayTheme?: 'dark' | 'light';
  /** Lets Claude drive the mouse, keyboard and windows; unset means off, switched on only on this computer. */
  computer?: boolean;
  /** The stub lock screen: `on` covers the desktop, `off` leaves it alone; unset means its own switch decides. */
  blocker?: boolean;
  /** The password the stub lock screen takes; unset means "1805". */
  blockerPin?: string;
  /** Letters that lift the stub lock screen without a password; unset means "pocket". */
  blockerEscape?: string;
  /** Lets the phone look through this computer's webcam; unset means off, switched on only on this computer. */
  camera?: boolean;
  /** Gives every chat a desktop of its own (Linux); unset means on wherever the programs for it are installed. */
  workspaces?: boolean;
}

/** The per-chat desktops of this computer, as the agent uses them; see linux/workspaces.ts. */
export interface WorkspaceHost {
  /** Names this login; the VS Code extension on the same login reports the same value. */
  readonly hostId: string;
  /** The desktop a request names: started when no generation is given, refused as stale when the given one is gone. */
  use(binding: WorkspaceBinding): Promise<{ info: WorkspaceInfo; computer: ComputerBackend; clipboard: ClipboardBackend }>;
  status(binding: WorkspaceBinding): WorkspaceInfo;
  list(): WorkspaceInfo[];
  capture(id: string): Promise<{ image: ScreenImage; info: WorkspaceInfo }>;
  reset(id: string, opts?: { wipe?: boolean; children?: boolean }): Promise<WorkspaceInfo | undefined>;
  release(id: string): void;
  releaseAll(): void;
}

const NO_WORKSPACES = 'This computer has no per-chat desktops: they are switched off or the programs for them are missing (run install-linux.sh, then "PocketClipboard workspaces on").';
const WORKSPACE_REQUIRED =
  'On this computer chats work in desktops of their own, and this request named none: Pocket on the Mac is too old for that and has to be updated. The owner can still allow control of the real desktop here with "PocketClipboard computer on".';

/** What went wrong with a desktop, as the reply to the brain carries it. */
function failure(e: unknown): { error: string; code?: WorkspaceErrorCode } {
  const code = workspaceErrorCodeSchema.safeParse((e as { code?: unknown } | null)?.code);
  return { error: e instanceof Error ? e.message : String(e), ...(code.success ? { code: code.data } : {}) };
}

/** What the overlay window needs from the agent: the brain's session traffic and its presence. */
export interface OverlaySink {
  connected(): void;
  offline(): void;
  handle(message: InnerMessageBody): void;
}

/** Shares this computer's clipboard and screen with the paired Mac and, when allowed, its mouse and keyboard; no files, no commands. */
export class ClipboardAgent {
  private readonly link: DeviceLink;
  private overlay: OverlaySink | undefined;

  constructor(
    private readonly state: AgentState,
    private readonly opts: {
      clipboard: ClipboardBackend;
      /** Screenshots on request; absent means the computer does not offer them. */
      screen?: ScreenBackend;
      /** Computer use: screen, mouse, keyboard and windows; absent means the computer does not offer it. */
      computer?: ComputerBackend;
      /** A webcam to look through when asked; absent means the computer does not offer it. */
      camera?: CameraBackend;
      /** Desktops of the chats' own (Linux); absent means the computer has none. */
      workspaces?: WorkspaceHost;
      /**
       * The owner switched per-chat desktops off on this Linux computer, so chats use its real desktop as they did
       * before. Never set because desktops merely could not be started: that is an error, not a reason to use the screen.
       */
      hostDesktop?: boolean;
      WebSocket?: WebSocketCtor;
      log: (m: string) => void;
      /** The relay moved; the caller persists the new address. */
      onRelayMoved: (url: string) => void;
      overlay?: OverlaySink;
    },
  ) {
    this.overlay = opts.overlay;
    this.link = new DeviceLink({
      relayUrl: state.relayUrl,
      accountId: state.accountId,
      deviceId: state.deviceId,
      role: 'executor',
      identity: deserializeIdentity(state.identity),
      peers: { [state.brainDeviceId]: state.brainEncPub },
      WebSocket: opts.WebSocket,
      replayState: state.replay,
      log: opts.log,
    });
    this.link.on('message', (m) => void this.onMessage(m));
    this.link.on('ready', (_r, online) => online.includes(state.brainDeviceId) && this.sendStatus());
    this.link.on('presence', (id, online) => {
      if (id !== state.brainDeviceId) return;
      if (online) this.sendStatus();
      else this.overlay?.offline();
    });
  }

  connect(): void {
    this.link.connect();
  }

  close(): void {
    this.link.close();
  }

  replayState(): Record<string, number> {
    return this.link.replayState();
  }

  /** Switches the overlay on or off at runtime; the Mac learns about it through the capabilities. */
  setOverlay(sink: OverlaySink | undefined): void {
    this.overlay = sink;
    if (this.link.isOnline(this.state.brainDeviceId)) this.sendStatus();
  }

  /** What the overlay asks of the brain: the session list, history, models, messages typed in the window and model changes. */
  request(body: InnerMessageBody): void {
    this.send(body);
  }

  private send(body: InnerMessageBody): void {
    this.link.send(this.state.brainDeviceId, body);
  }

  /** The desktop a chat's request names, or the reason it has none here. */
  private desktop(binding: WorkspaceBinding): ReturnType<WorkspaceHost['use']> {
    if (!this.opts.workspaces) return Promise.reject(Object.assign(new Error(NO_WORKSPACES), { code: 'workspace_unavailable' satisfies WorkspaceErrorCode }));
    return this.opts.workspaces.use(binding);
  }

  private sendStatus(): void {
    const capabilities = [
      'clipboard',
      ...(this.opts.screen || this.opts.workspaces ? ['screenshot'] : []),
      ...(this.opts.computer || this.opts.workspaces ? ['computer'] : []),
      ...(this.opts.camera ? ['camera'] : []),
      ...(this.overlay ? ['overlay'] : []),
      ...(this.opts.workspaces ? ['workspaces'] : this.opts.hostDesktop ? ['host-desktop'] : []),
    ];
    this.send({
      type: 'executor.status',
      payload: { workspaces: [], os: `${os.platform()} ${os.release()}`, shell: 'none', capabilities, ...(this.opts.workspaces ? { workspaceHost: this.opts.workspaces.hostId } : {}) },
    });
    this.overlay?.connected();
  }

  private async onMessage({ from, message }: IncomingMessage): Promise<void> {
    if (from !== this.state.brainDeviceId) return;
    switch (message.type) {
      case 'clipboard.read': {
        const { requestId, workspace } = message.payload;
        if (workspace) {
          // A chat's own clipboard: the one of its desktop, never the person's.
          try {
            const desktop = await this.desktop(workspace);
            const items = await desktop.clipboard.read();
            this.opts.log(`clipboard read in desktop ${workspace.id.slice(3, 9)}: ${items.map((i) => i.kind).join(', ') || 'empty'}`);
            this.send({ type: 'clipboard.data', payload: { requestId, items, workspace: desktop.info } });
          } catch (e) {
            this.send({ type: 'clipboard.data', payload: { requestId, ...failure(e) } });
          }
          return;
        }
        try {
          const items = await this.opts.clipboard.read();
          this.opts.log(`clipboard read: ${items.map((i) => i.kind).join(', ') || 'empty'}`);
          this.send({ type: 'clipboard.data', payload: { requestId, items } });
        } catch (e) {
          this.send({ type: 'clipboard.data', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'clipboard.write': {
        const { requestId, item, workspace } = message.payload;
        if (workspace) {
          try {
            const desktop = await this.desktop(workspace);
            await desktop.clipboard.write(item);
            this.opts.log(`clipboard written in desktop ${workspace.id.slice(3, 9)}: ${item.kind}`);
            this.send({ type: 'clipboard.done', payload: { requestId, workspace: desktop.info } });
          } catch (e) {
            this.send({ type: 'clipboard.done', payload: { requestId, ...failure(e) } });
          }
          return;
        }
        try {
          await this.opts.clipboard.write(item);
          this.opts.log(`clipboard written: ${item.kind}`);
          this.send({ type: 'clipboard.done', payload: { requestId } });
        } catch (e) {
          this.send({ type: 'clipboard.done', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'screen.capture': {
        const { requestId, workspace } = message.payload;
        if (workspace) {
          try {
            const desktop = await this.desktop(workspace);
            const { image } = await desktop.computer.act({ action: 'screenshot' });
            if (!image) throw new Error('The desktop returned no picture.');
            this.opts.log(`screenshot of desktop ${workspace.id.slice(3, 9)} sent: ${image.width}x${image.height}`);
            this.send({ type: 'screen.image', payload: { requestId, image, workspace: desktop.info } });
          } catch (e) {
            this.send({ type: 'screen.image', payload: { requestId, ...failure(e) } });
          }
          return;
        }
        if (!this.opts.screen) return this.send({ type: 'screen.image', payload: { requestId, error: 'This computer does not take screenshots.' } });
        try {
          const image = await this.opts.screen.capture();
          this.opts.log(`screenshot sent: ${image.width}x${image.height}, ${Math.round(image.dataBase64.length / 1024)} KB`);
          this.send({ type: 'screen.image', payload: { requestId, image } });
        } catch (e) {
          this.send({ type: 'screen.image', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'camera.capture': {
        const { requestId, maxWidth } = message.payload;
        if (!this.opts.camera) return this.send({ type: 'camera.frame', payload: { requestId, error: 'This computer has no camera to look through.' } });
        try {
          const image = await this.opts.camera.capture(maxWidth ?? 1280);
          // The camera is shut down right after the frame, so its indicator stops between looks.
          this.opts.log(`camera frame: ${image.width}x${image.height}, ${Math.round(image.dataBase64.length / 1024)} KB`);
          this.send({ type: 'camera.frame', payload: { requestId, image } });
        } catch (e) {
          this.opts.log(`camera: ${e instanceof Error ? e.message : String(e)}`);
          this.send({ type: 'camera.frame', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'computer.act': {
        const { requestId, action, workspace } = message.payload;
        if (workspace) {
          if (action.action === 'release') {
            // Letting go never starts a desktop: one that is not running holds nothing.
            this.opts.workspaces?.release(workspace.id);
            return this.send({ type: 'computer.done', payload: { requestId, text: 'Let go of all keys and mouse buttons.' } });
          }
          try {
            const desktop = await this.desktop(workspace);
            const result = await desktop.computer.act(action);
            this.opts.log(`computer in desktop ${workspace.id.slice(3, 9)}: ${action.action}${result.image ? ` ${result.image.width}x${result.image.height}` : ''}`);
            this.send({ type: 'computer.done', payload: { requestId, ...result, workspace: desktop.info } });
          } catch (e) {
            this.opts.log(`computer in desktop ${workspace.id.slice(3, 9)}: ${action.action} failed: ${e instanceof Error ? e.message : String(e)}`);
            this.send({ type: 'computer.done', payload: { requestId, ...failure(e) } });
          }
          return;
        }
        // No desktop named: this is about the person's own screen, which only their own switch opens. Where chats have
        // desktops of their own that switch is not implied, so a request without one is refused rather than run there.
        if (!this.opts.computer) {
          return this.send({
            type: 'computer.done',
            payload: this.opts.workspaces
              ? { requestId, error: WORKSPACE_REQUIRED, code: 'workspace_required' }
              : { requestId, error: 'This computer cannot be controlled: PocketClipboard runs here without computer use.' },
          });
        }
        if (action.action === 'release') {
          // Not queued behind the step it is meant to stop.
          this.opts.computer.release();
          return this.send({ type: 'computer.done', payload: { requestId, text: 'Let go of all keys and mouse buttons.' } });
        }
        try {
          const result = await this.opts.computer.act(action);
          // Only the kind of step: typed text and window titles stay off the log.
          this.opts.log(`computer: ${action.action}${result.image ? ` ${result.image.width}x${result.image.height}` : ''}`);
          this.send({ type: 'computer.done', payload: { requestId, ...result } });
        } catch (e) {
          this.opts.log(`computer: ${action.action} failed: ${e instanceof Error ? e.message : String(e)}`);
          this.send({ type: 'computer.done', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'workspace.control': {
        const { requestId, op, workspace, children } = message.payload;
        const host = this.opts.workspaces;
        if (!host) return this.send({ type: 'workspace.state', payload: { requestId, error: NO_WORKSPACES, code: 'workspace_unavailable' } });
        try {
          if (op === 'list') return this.send({ type: 'workspace.state', payload: { requestId, workspaces: host.list().slice(0, 200) } });
          if (!workspace) throw new Error('No desktop was named.');
          if (op === 'ensure') return this.send({ type: 'workspace.state', payload: { requestId, workspace: (await host.use(workspace)).info } });
          if (op === 'capture') {
            const { image, info } = await host.capture(workspace.id);
            return this.send({ type: 'workspace.state', payload: { requestId, image, workspace: info } });
          }
          if (op === 'reset' || op === 'delete') {
            await host.reset(workspace.id, { wipe: op === 'delete', ...(children ? { children: true } : {}) });
            this.opts.log(`desktop ${workspace.id.slice(3, 9)} ${op === 'delete' ? 'deleted' : 'closed'} on request`);
          }
          this.send({ type: 'workspace.state', payload: { requestId, workspace: host.status(workspace) } });
        } catch (e) {
          this.send({ type: 'workspace.state', payload: { requestId, ...failure(e) } });
        }
        return;
      }
      case 'control.kill':
        this.opts.computer?.release();
        this.opts.workspaces?.releaseAll();
        return;
      case 'tool.call':
        this.send({ type: 'tool.result', payload: { callId: message.payload.callId, content: 'This computer shares its clipboard, screen and per-chat desktops; commands run through the VS Code extension.', isError: true } });
        return;
      case 'relay.moved':
        if (/^https?:\/\//.test(message.payload.url) && message.payload.url !== this.link.currentRelayUrl) {
          this.link.setRelayUrl(message.payload.url);
          this.opts.onRelayMoved(message.payload.url);
        }
        return;
      case 'session.event':
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'session.list.result':
      case 'session.history.result':
      case 'models.result':
      // The brain answers only the overlay's own messages with errors (a chat that is gone, Claude failing to start).
      case 'error':
        this.overlay?.handle(message);
        return;
      default:
        return;
    }
  }
}
