import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const roleSchema = z.enum(['brain', 'executor', 'client']);
export type Role = z.infer<typeof roleSchema>;

export const sessionStateSchema = z.enum(['idle', 'running', 'waiting_permission', 'ended']);
export type SessionState = z.infer<typeof sessionStateSchema>;

const sessionEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const effortSchema = z.enum([...sessionEffortSchema.options, 'ultra']);
export type Effort = z.infer<typeof effortSchema>;

export const MAX_SYSTEM_PROMPT_LENGTH = 8_000;
export function normalizeSystemPrompt(systemPrompt: string | undefined): string | undefined {
  const trimmed = systemPrompt?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_SYSTEM_PROMPT_LENGTH) {
    throw new Error(`System prompt must not exceed ${MAX_SYSTEM_PROMPT_LENGTH} characters`);
  }
  return trimmed;
}

const systemPromptSchema = z.string().trim().max(MAX_SYSTEM_PROMPT_LENGTH).optional();
const sessionMetaSystemPromptSchema = z.string().trim().max(MAX_SYSTEM_PROMPT_LENGTH).transform((systemPrompt) => systemPrompt || undefined).optional();

export const sessionMetaSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  state: sessionStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastText: z.string().optional(),
  model: z.string().optional(),
  effort: sessionEffortSchema.optional(),
  codexEffort: z.literal('ultra').optional(),
  /** Instructions specific to this conversation; omitted when cleared. */
  systemPrompt: sessionMetaSystemPromptSchema,
  /** Who pays for this chat: 'api' bills the owner's Anthropic API key; unset means the Claude subscription. */
  billing: z.literal('api').optional(),
  /** How much of the context window the chat used after its last reply (tokens, window, rounded percent). */
  context: z.object({ tokens: z.number(), max: z.number(), percent: z.number() }).optional(),
  /** The computer this chat works on; unset means the account's active computer. */
  executorId: z.string().optional(),
  /** Project folder on that computer; unset means the folders open in VS Code. */
  project: z.string().optional(),
  /** Hidden from the chat list on clients, still kept on the brain. */
  hidden: z.boolean().optional(),
  /** The person the chat belongs to; the brain shows each client only its own person's chats. */
  userId: z.string().optional(),
  /** Claude Code session behind this chat; it is tied to a working directory, so moving the chat starts a new one. */
  engine: z.object({ id: z.string(), cwd: z.string() }).optional(),
  codexThreadId: z.string().optional(),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

export const subagentStatusSchema = z.enum(['starting', 'running', 'completed', 'failed', 'cancelled']);
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;
export const SUBAGENT_MAX_STEPS = 20;
export const SUBAGENT_MAX_RESULT = 20_000;

/** One tool call of a subagent, as its card lists it. */
export const subagentStepSchema = z.object({
  id: z.string(),
  tool: z.string().max(80),
  summary: z.string().max(300).optional(),
  status: z.enum(['running', 'done', 'error']),
  at: z.number().optional(),
});
export type SubagentStep = z.infer<typeof subagentStepSchema>;

/** Normalised Claude Code activity, independent of the CLI's stream-json shape. */
export const sessionEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    text: z.string(),
    from: z.string(),
    images: z.number().int().positive().optional(),
    files: z.array(z.string()).optional(),
    /** Spoken on a call. */
    voice: z.boolean().optional(),
    at: z.number().optional(),
  }),
  z.object({ kind: z.literal('text_delta'), text: z.string(), at: z.number().optional() }),
  z.object({ kind: z.literal('text'), text: z.string(), at: z.number().optional() }),
  z.object({ kind: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown(), at: z.number().optional() }),
  z.object({ kind: z.literal('tool_output'), id: z.string(), chunk: z.string(), stream: z.enum(['stdout', 'stderr']), at: z.number().optional() }),
  z.object({ kind: z.literal('tool_result'), id: z.string(), content: z.string(), isError: z.boolean(), at: z.number().optional() }),
  z.object({ kind: z.literal('state'), state: sessionStateSchema, at: z.number().optional() }),
  z.object({
    kind: z.literal('result'),
    durationMs: z.number().optional(),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    at: z.number().optional(),
  }),
  z.object({ kind: z.literal('error'), message: z.string(), at: z.number().optional() }),
  /**
   * The card of one child agent the chat's agent delegated a task to. Every event carries the whole card, so the
   * latest one with an id is its state: a client that reconnects or reloads history never doubles a card. Only sent
   * to peers that list the 'subagents' feature.
   */
  z.object({
    kind: z.literal('subagent'),
    /** Task id of the child agent, unique within the chat. */
    id: z.string().min(1).max(200),
    status: subagentStatusSchema,
    /** Its role: the agent type, e.g. "general-purpose" or "Explore". */
    name: z.string().max(80).optional(),
    /** What it was asked to do. */
    task: z.string().max(2000),
    /** The parent's Agent tool use that started it. */
    toolUseId: z.string().optional(),
    /** Task id of the subagent that started this one; absent when the chat's main agent did. */
    parentId: z.string().optional(),
    /** Started in the background: it may outlive the reply that started it. */
    background: z.boolean().optional(),
    /** One line on what it is doing now; never the model's private reasoning. */
    activity: z.string().max(300).optional(),
    toolUses: z.number().int().min(0).optional(),
    /** Its latest tool calls, oldest first. */
    steps: z.array(subagentStepSchema).max(SUBAGENT_MAX_STEPS).optional(),
    /** Its final report to the parent. */
    result: z.string().max(SUBAGENT_MAX_RESULT).optional(),
    error: z.string().max(2000).optional(),
    /** It drives a Linux desktop of its own; `workspace.preview` with this card's id as `key` shows it. */
    desktop: z.boolean().optional(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    at: z.number().optional(),
  }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SubagentEvent = Extract<SessionEvent, { kind: 'subagent' }>;

/** Features a client or an overlay computer may list so the brain sends it what older builds cannot parse. */
export const PEER_FEATURES = {
  /** Understands `subagent` session events. */
  subagents: 'subagents',
  /** Understands the `workspace.*` desktop status, preview and reset messages. */
  workspaces: 'workspaces',
} as const;

export const permissionDecisionSchema = z.enum(['allow', 'allow_session', 'deny']);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

/** Photos are shown to Claude directly; other files are saved next to the chat and Claude reads them by path. */
export const attachmentSchema = z.object({ mime: z.string(), dataBase64: z.string(), name: z.string().max(255).optional() });
export type Attachment = z.infer<typeof attachmentSchema>;

export const clipboardItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('image'), mime: z.string(), dataBase64: z.string() }),
  z.object({ kind: z.literal('file'), name: z.string(), mime: z.string(), dataBase64: z.string(), size: z.number() }),
]);
export type ClipboardItem = z.infer<typeof clipboardItemSchema>;

/** A downscaled picture of a computer's screen (all monitors), small enough for Claude to look at. */
export const screenImageSchema = z.object({ mime: z.string(), dataBase64: z.string(), width: z.number().int().positive(), height: z.number().int().positive() });
export type ScreenImage = z.infer<typeof screenImageSchema>;

const px = z.number().int();
const size = z.number().int().positive();
const mouseButtonSchema = z.enum(['left', 'right', 'middle']);
/** Key names held during a click or scroll, e.g. ["ctrl"], ["shift"]. */
const modifiersSchema = z.array(z.string().min(1).max(20)).max(4).optional();

/** A monitor of a computer, in physical pixels of the whole desktop. */
export const displaySchema = z.object({
  index: z.number().int().min(0),
  x: px,
  y: px,
  width: size,
  height: size,
  primary: z.boolean(),
  /** 1.25 for a display set to 125 %. */
  scale: z.number().positive().optional(),
});
export type Display = z.infer<typeof displaySchema>;

export const windowInfoSchema = z.object({
  /** The window handle as a decimal string; pass it back to act on the window. */
  handle: z.string(),
  title: z.string(),
  process: z.string(),
  x: px,
  y: px,
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  minimized: z.boolean(),
  maximized: z.boolean(),
  focused: z.boolean(),
  /** Index of the display the window is on; absent for minimized windows. */
  display: z.number().int().min(0).optional(),
});
export type WindowInfo = z.infer<typeof windowInfoSchema>;

/**
 * One step of computer use on a PocketClipboard computer. Coordinates are physical pixels of the whole desktop;
 * the brain converts from screenshot pixels. `key` takes xdotool-style names: "ctrl+shift+esc", "Return", "super+r".
 */
export const computerActionSchema = z.discriminatedUnion('action', [
  /** `settleMs`: first wait, at most that long, for the screen to stand still, so the picture shows what a step led to and not the middle of it. */
  z.object({
    action: z.literal('screenshot'),
    display: z.number().int().min(0).optional(),
    maxWidth: z.number().int().min(200).max(4000).optional(),
    maxHeight: z.number().int().min(200).max(4000).optional(),
    settleMs: z.number().int().min(0).max(10_000).optional(),
  }),
  z.object({ action: z.literal('zoom'), x: px, y: px, width: size, height: size, maxWidth: z.number().int().min(200).max(4000).optional(), maxHeight: z.number().int().min(200).max(4000).optional() }),
  z.object({ action: z.literal('move'), x: px, y: px }),
  /** Without x/y the click lands where the pointer is. */
  z.object({ action: z.literal('click'), x: px.optional(), y: px.optional(), button: mouseButtonSchema, count: z.number().int().min(1).max(3), modifiers: modifiersSchema }),
  z.object({ action: z.literal('button'), button: mouseButtonSchema, down: z.boolean() }),
  z.object({ action: z.literal('drag'), path: z.array(z.tuple([px, px])).min(2).max(50), button: mouseButtonSchema.optional() }),
  /** Wheel notches: dy > 0 scrolls down, dx > 0 scrolls right. */
  z.object({ action: z.literal('scroll'), x: px.optional(), y: px.optional(), dx: z.number().int().min(-50).max(50), dy: z.number().int().min(-50).max(50), modifiers: modifiersSchema }),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(20_000) }),
  z.object({ action: z.literal('key'), keys: z.string().min(1).max(200), holdMs: z.number().int().min(0).max(10_000).optional() }),
  z.object({ action: z.literal('cursor') }),
  z.object({ action: z.literal('windows') }),
  z.object({ action: z.literal('window'), handle: z.string().regex(/^\d+$/), op: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close']) }),
  /** A program, file, folder or URL, as the Run dialog takes it: "powershell", "chrome", "https://…", "notepad". */
  z.object({ action: z.literal('open'), target: z.string().min(1).max(2000), args: z.string().max(8000).optional() }),
  /** Lets go of every key and mouse button: what the kill switch does. */
  z.object({ action: z.literal('release') }),
]);
export type ComputerAction = z.infer<typeof computerActionSchema>;

/** What a step returns; screenshots and zooms say which part of the desktop the picture shows. */
export const computerResultSchema = z.object({
  image: screenImageSchema.optional(),
  region: z.object({ x: px, y: px, width: size, height: size }).optional(),
  displays: z.array(displaySchema).optional(),
  cursor: z.object({ x: px, y: px }).optional(),
  windows: z.array(windowInfoSchema).optional(),
  text: z.string().optional(),
  /**
   * A screenshot against the previous one of the same display: the share of the screen that differs and the box
   * around it, in pixels of this picture. No `box` means nothing changed; absent on the first screenshot and from
   * helpers that do not compare.
   */
  change: z.object({ fraction: z.number().min(0).max(1), box: z.object({ x: px, y: px, width: size, height: size }).optional() }).optional(),
  /** After `settleMs`: whether the screen stood still when the picture was taken (false: the wait ran out first). */
  settled: z.boolean().optional(),
});
export type ComputerResult = z.infer<typeof computerResultSchema>;

/**
 * The name of one independent Linux desktop: `ws_` and 26 base32 characters. The brain derives it from the owner, the
 * paired computer and the chat (plus the subagent, for a child desktop); nothing a model writes can choose one.
 */
export const WORKSPACE_ID_PATTERN = /^ws_[a-z2-7]{26}$/;
export const workspaceIdSchema = z.string().regex(WORKSPACE_ID_PATTERN);

/**
 * Which desktop a chat-owned request is for, on a computer with the 'workspaces' capability. Without `generation` the
 * computer starts the desktop when it is not running; with it, a desktop that is gone or was recreated since makes
 * the request stale and nothing is done.
 */
export const workspaceBindingSchema = z.object({
  id: workspaceIdSchema,
  generation: z.number().int().positive().optional(),
  /** Shown in local listings on the computer ("Fix the build", "subagent: check the page"); display only. */
  label: z.string().max(120).optional(),
  /** The chat's own desktop when this one belongs to a subagent of it: resets and deletions take the children along. */
  parent: workspaceIdSchema.optional(),
});
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;

/** Why a request for a desktop was refused; the brain turns these into what the agent and the phone are told. */
export const workspaceErrorCodeSchema = z.enum([
  /** The desktop was recreated (or closed) since the generation the request named. */
  'workspace_stale',
  /** It could not be started or has crashed: a missing program, the X server died. */
  'workspace_unavailable',
  /** This computer runs chat requests in per-chat desktops only and the request named none. */
  'workspace_required',
  /** More desktops are running than this computer allows. */
  'workspace_limit',
]);
export type WorkspaceErrorCode = z.infer<typeof workspaceErrorCodeSchema>;

export const workspaceInfoSchema = z.object({
  id: workspaceIdSchema,
  /** Counts the times the desktop was started; 0 before the first. */
  generation: z.number().int().min(0),
  state: z.enum(['starting', 'running', 'stopped', 'failed']),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** The X display, e.g. ":101": for looking at it on that computer, never accepted back as an address. */
  display: z.string().max(16).optional(),
  label: z.string().max(120).optional(),
  parent: workspaceIdSchema.optional(),
  startedAt: z.number().optional(),
  lastUsedAt: z.number().optional(),
  error: z.string().max(500).optional(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

/** A chat's desktop (or a subagent's) as the phone lists it. `key` is 'main' or the subagent's task id. */
export const desktopSchema = z.object({
  key: z.string().min(1).max(200),
  label: z.string().max(160),
  state: z.enum(['none', 'starting', 'running', 'stopped', 'failed']),
  generation: z.number().int().min(0).optional(),
  display: z.string().max(16).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  lastUsedAt: z.number().optional(),
  error: z.string().max(500).optional(),
});
export type Desktop = z.infer<typeof desktopSchema>;

/** Where a tool call's programs and background jobs belong on the executor. */
export const toolContextSchema = z.object({
  /** Owner of the background jobs the call starts or reads: one per chat, opaque to the executor. */
  scope: z.string().regex(/^[a-z0-9_]{8,64}$/),
  /** The desktop the call's programs must appear on; the executor finds it on its own machine or refuses. */
  workspace: z.object({ id: workspaceIdSchema, generation: z.number().int().positive() }).optional(),
});
export type ToolContext = z.infer<typeof toolContextSchema>;

export const modelInfoSchema = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  efforts: z.array(effortSchema).optional(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const runningToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  startedAt: z.number(),
  /** Set for tools called by a subagent: the id of the Agent tool use that spawned it. */
  parentId: z.string().optional(),
});
export type RunningTool = z.infer<typeof runningToolSchema>;

export const backgroundTaskSchema = z.object({ id: z.string(), command: z.string(), startedAt: z.number() });
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

export const subagentSchema = z.object({
  id: z.string(),
  description: z.string(),
  type: z.string().optional(),
  /** The Agent tool use that started it; tools with this `parentId` belong to it. */
  toolUseId: z.string().optional(),
  startedAt: z.number(),
  lastTool: z.string().optional(),
  toolUses: z.number().optional(),
  status: subagentStatusSchema.optional(),
  /** One line on what it is doing now. */
  activity: z.string().optional(),
  /** It drives a Linux desktop of its own. */
  desktop: z.boolean().optional(),
});
export type Subagent = z.infer<typeof subagentSchema>;

export const activitySessionSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  state: sessionStateSchema,
  live: z.boolean(),
  executorId: z.string().optional(),
  project: z.string().optional(),
  model: z.string().optional(),
  effort: sessionEffortSchema.optional(),
  codexEffort: z.literal('ultra').optional(),
  runningTools: z.array(runningToolSchema),
  background: z.array(backgroundTaskSchema).optional(),
  agents: z.array(subagentSchema).optional(),
  pendingPermissions: z.number(),
  turnStartedAt: z.number().optional(),
});
export type ActivitySession = z.infer<typeof activitySessionSchema>;

export const projectSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** Open in a VS Code window right now. */
  open: z.boolean(),
  lastOpened: z.number().optional(),
});
export type Project = z.infer<typeof projectSchema>;

/** Pseudo device id for "work on the Mac itself" in computer.select. */
export const MAC_DEVICE_ID = 'mac';

export const computerSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  online: z.boolean(),
  os: z.string().optional(),
  workspaces: z.array(z.string()),
  projects: z.array(projectSchema).optional(),
  capabilities: z.array(z.string()).optional(),
  pairedAt: z.number(),
});
export type Computer = z.infer<typeof computerSchema>;

const m = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

export const innerMessageBodySchema = z.discriminatedUnion('type', [
  // client → brain
  m('session.create', z.object({ title: z.string().optional(), systemPrompt: systemPromptSchema })),
  m('session.list', z.object({})),
  m('session.history', z.object({ sessionId: z.string() })),
  /** `voice`: the text was spoken on a call and the reply will be read aloud; the brain asks Claude for a short spoken answer. */
  m('message.send', z.object({ sessionId: z.string(), text: z.string(), attachments: z.array(attachmentSchema).optional(), voice: z.boolean().optional() })),
  m('session.interrupt', z.object({ sessionId: z.string() })),
  m('permission.respond', z.object({ requestId: z.string(), decision: permissionDecisionSchema })),
  /** `features`: what this build understands beyond the first protocol, see PEER_FEATURES; the brain remembers it per device. */
  m('status.get', z.object({ features: z.array(z.string().max(40)).max(20).optional() })),
  m('session.configure', z.object({ sessionId: z.string(), requestId: z.string().optional(), model: z.string().nullable().optional(), effort: effortSchema.nullable().optional(), systemPrompt: systemPromptSchema })),
  m('session.rename', z.object({ sessionId: z.string(), title: z.string().min(1).max(80) })),
  m('session.hide', z.object({ sessionId: z.string(), hidden: z.boolean() })),
  m('session.delete', z.object({ sessionId: z.string() })),
  m('models.get', z.object({ supportsUltra: z.boolean().optional() })),
  m('activity.get', z.object({})),
  m('computers.get', z.object({})),
  /** Binds a chat to a computer (when `sessionId` is set) and makes it the default for new chats. */
  m('computer.select', z.object({ deviceId: z.string(), sessionId: z.string().optional(), project: z.string().nullable().optional() })),
  /** Opens a project folder in a new VS Code window on that computer. */
  m('computer.open', z.object({ deviceId: z.string(), path: z.string() })),
  m('computer.pair', z.object({})),
  /** Asks a computer for what is on its clipboard right now. */
  m('clipboard.get', z.object({ requestId: z.string(), deviceId: z.string() })),
  m('clipboard.set', z.object({ requestId: z.string(), deviceId: z.string(), item: clipboardItemSchema })),
  /** Asks a computer for a picture of its screen right now. */
  m('screen.get', z.object({ requestId: z.string(), deviceId: z.string() })),
  /** Asks a computer with a camera for one frame of it. */
  m('camera.get', z.object({ requestId: z.string(), deviceId: z.string(), maxWidth: z.number().int().min(120).max(1920).optional() })),
  /** Starts watching that computer's camera: answered with `camera.view`, a link that shows the frames for a while. */
  m('camera.watch', z.object({ requestId: z.string(), deviceId: z.string().optional() })),
  m('computer.remove', z.object({ deviceId: z.string() })),
  /** Owner only: asks for an invite link that registers a new person with their own phone, computers and chats. */
  m('user.invite', z.object({})),
  /** Asks for a link that connects the Mac's Telegram bot to this person; answered with `telegram.linking`. */
  m('telegram.link', z.object({})),
  /** The sending device leaves the account: the brain forgets it. */
  m('device.unpair', z.object({})),
  /** Asks what desktops a chat has on its Linux computer; answered with `workspace.result`. */
  m('workspace.get', z.object({ requestId: z.string(), sessionId: z.string() })),
  /** Asks for a picture of a chat's desktop (`key` 'main', or a subagent's task id) without touching it. */
  m('workspace.preview', z.object({ requestId: z.string(), sessionId: z.string(), key: z.string().max(200).optional() })),
  /**
   * Closes a chat's desktop and everything running in it; the next use starts a fresh one. `wipe` also removes its
   * browser profile and saved application state. Without `key` the chat's own desktop and its subagents' are closed.
   */
  m('workspace.reset', z.object({ requestId: z.string(), sessionId: z.string(), key: z.string().max(200).optional(), wipe: z.boolean().optional() })),
  /** Stops one child agent of a chat; its siblings and the chat itself go on. */
  m('subagent.cancel', z.object({ sessionId: z.string(), id: z.string().min(1).max(200) })),

  // brain → client
  m('host.status', z.object({
    ready: z.boolean(),
    reason: z.string().optional(),
    claudeVersion: z.string().optional(),
    kimiVersion: z.string().optional(),
    executorOnline: z.boolean(),
    workspaces: z.array(z.string()),
    /** Who this client belongs to. Owners may work on the Mac itself and invite people. */
    user: z.object({ id: z.string(), name: z.string(), owner: z.boolean() }).optional(),
    /** Username of the Telegram bot set up on the Mac, when there is one. */
    telegramBot: z.string().optional(),
    /** What this brain understands beyond the first protocol, see PEER_FEATURES: clients only ask for those things. */
    features: z.array(z.string().max(40)).max(20).optional(),
  })),
  m('session.created', z.object({ session: sessionMetaSchema })),
  m('session.list.result', z.object({ sessions: z.array(sessionMetaSchema) })),
  m('session.history.result', z.object({ sessionId: z.string(), events: z.array(sessionEventSchema) })),
  m('session.updated', z.object({ session: sessionMetaSchema })),
  m('session.deleted', z.object({ sessionId: z.string() })),
  m('session.event', z.object({ sessionId: z.string(), event: sessionEventSchema })),
  m('permission.request', z.object({
    requestId: z.string(),
    sessionId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    expiresAt: z.number(),
  })),
  m('permission.resolved', z.object({ requestId: z.string(), decision: permissionDecisionSchema, by: z.string() })),
  m('error', z.object({ code: z.string(), message: z.string(), sessionId: z.string().optional(), requestId: z.string().optional() })),
  m('models.result', z.object({ models: z.array(modelInfoSchema) })),
  /** `activeId` is the default computer for the clipboard; `mac` lists projects chats can work in on the Mac itself. */
  m('computers.result', z.object({
    computers: z.array(computerSchema),
    activeId: z.string().nullable(),
    mac: z.object({ name: z.string(), projects: z.array(projectSchema) }).optional(),
  })),
  /** `uri` is the same code as a pocketclaude://pair link with the relay inside: one paste or one QR scan for PocketClipboard. */
  m('computer.pairing', z.object({ code: z.string(), safetyNumber: z.string(), expiresAt: z.number(), uri: z.string().optional() })),
  m('user.invitation', z.object({ uri: z.string(), code: z.string(), safetyNumber: z.string(), expiresAt: z.number() })),
  /** `url` opens the bot with the pairing code as its start parameter. */
  m('telegram.linking', z.object({ url: z.string(), code: z.string(), expiresAt: z.number() })),
  m('clipboard.result', z.object({ requestId: z.string(), deviceId: z.string(), items: z.array(clipboardItemSchema).optional(), error: z.string().optional() })),
  m('clipboard.written', z.object({ requestId: z.string(), deviceId: z.string(), error: z.string().optional() })),
  m('screen.result', z.object({ requestId: z.string(), deviceId: z.string(), image: screenImageSchema.optional(), error: z.string().optional() })),
  m('camera.result', z.object({ requestId: z.string(), deviceId: z.string(), image: screenImageSchema.optional(), error: z.string().optional() })),
  /** The link that shows the camera live until `expiresAt`. */
  m('camera.view', z.object({ requestId: z.string(), url: z.string(), expiresAt: z.number(), deviceId: z.string(), error: z.string().optional() })),
  /** `supported` is false when the chat's computer has no per-chat desktops; `reason` then says why in a sentence. */
  m('workspace.result', z.object({
    requestId: z.string(),
    sessionId: z.string(),
    supported: z.boolean(),
    computer: z.object({ deviceId: z.string(), name: z.string(), online: z.boolean() }).optional(),
    desktops: z.array(desktopSchema).max(50),
    reason: z.string().max(500).optional(),
    error: z.string().max(500).optional(),
  })),
  m('workspace.preview.result', z.object({
    requestId: z.string(),
    sessionId: z.string(),
    key: z.string(),
    image: screenImageSchema.optional(),
    generation: z.number().int().min(0).optional(),
    error: z.string().optional(),
  })),
  m('activity.result', z.object({
    at: z.number(),
    sessions: z.array(activitySessionSchema),
    executor: z.object({ online: z.boolean(), workspaces: z.array(z.string()), os: z.string().optional() }),
    claudeVersion: z.string().optional(),
    kimiVersion: z.string().optional(),
  })),

  // brain ↔ executor
  /** `root` limits the call to one project folder; without it the executor uses the folders open in VS Code. */
  /** `context` goes only to executors with the 'workspace-env' capability; without it a Linux executor runs the call with no display. */
  m('tool.call', z.object({ callId: z.string(), name: z.string(), args: z.unknown(), root: z.string().optional(), context: toolContextSchema.optional() })),
  m('workspace.open', z.object({ path: z.string() })),
  /**
   * Clipboard and screen requests are either a chat's (`workspace`: that chat's desktop on a computer with the
   * 'workspaces' capability) or the person's own from the phone (`scope: 'host'`: the computer's real clipboard and
   * screen). Older brains send neither, which a computer treats as the person's own.
   */
  m('clipboard.read', z.object({ requestId: z.string(), workspace: workspaceBindingSchema.optional(), scope: z.literal('host').optional() })),
  m('clipboard.write', z.object({ requestId: z.string(), item: clipboardItemSchema, workspace: workspaceBindingSchema.optional(), scope: z.literal('host').optional() })),
  m('clipboard.data', z.object({ requestId: z.string(), items: z.array(clipboardItemSchema).optional(), error: z.string().optional(), code: workspaceErrorCodeSchema.optional(), workspace: workspaceInfoSchema.optional() })),
  m('clipboard.done', z.object({ requestId: z.string(), error: z.string().optional(), code: workspaceErrorCodeSchema.optional(), workspace: workspaceInfoSchema.optional() })),
  m('screen.capture', z.object({ requestId: z.string(), workspace: workspaceBindingSchema.optional(), scope: z.literal('host').optional() })),
  /** One frame of the computer's camera, for watching it from the phone or the bot. */
  m('camera.capture', z.object({ requestId: z.string(), maxWidth: z.number().int().min(120).max(1920).optional() })),
  m('camera.frame', z.object({ requestId: z.string(), image: screenImageSchema.optional(), error: z.string().optional() })),
  m('screen.image', z.object({ requestId: z.string(), image: screenImageSchema.optional(), error: z.string().optional(), code: workspaceErrorCodeSchema.optional(), workspace: workspaceInfoSchema.optional() })),
  /** Computer use on a computer with the 'computer' capability (PocketClipboard on Windows or Linux X11). */
  /** `workspace`: the chat's desktop the step is for. A computer with the 'workspaces' capability refuses a step that names none unless its owner allowed control of the real desktop. */
  m('computer.act', z.object({ requestId: z.string(), action: computerActionSchema, workspace: workspaceBindingSchema.optional() })),
  m('computer.done', computerResultSchema.extend({ requestId: z.string(), error: z.string().optional(), code: workspaceErrorCodeSchema.optional(), workspace: workspaceInfoSchema.optional() })),
  /**
   * Manages per-chat desktops on a computer with the 'workspaces' capability; answered with `workspace.state`.
   * `ensure` starts the desktop if needed, `status` only reports, `capture` takes a picture of a running one without
   * touching it, `reset` closes it (keeping its browser profile), `delete` also removes what it stored, `list`
   * reports every desktop. `children` extends reset and delete to the desktops whose parent it is.
   */
  m('workspace.control', z.object({
    requestId: z.string(),
    op: z.enum(['ensure', 'status', 'capture', 'reset', 'delete', 'list']),
    workspace: workspaceBindingSchema.optional(),
    children: z.boolean().optional(),
  })),
  m('workspace.state', z.object({
    requestId: z.string(),
    workspace: workspaceInfoSchema.optional(),
    workspaces: z.array(workspaceInfoSchema).max(200).optional(),
    image: screenImageSchema.optional(),
    error: z.string().optional(),
    code: workspaceErrorCodeSchema.optional(),
  })),
  /** Stops the running calls and background jobs of one chat on an executor with the 'workspace-env' capability; with `workspace` only those inside that desktop. */
  m('jobs.kill', z.object({ scope: z.string().regex(/^[a-z0-9_]{8,64}$/), workspace: workspaceIdSchema.optional() })),
  m('tool.result', z.object({ callId: z.string(), content: z.string(), isError: z.boolean() })),
  m('tool.output', z.object({ callId: z.string(), chunk: z.string(), stream: z.enum(['stdout', 'stderr']) })),
  m('tool.cancel', z.object({ callId: z.string() })),
  m('executor.status', z.object({
    workspaces: z.array(z.string()),
    os: z.string(),
    shell: z.string(),
    projects: z.array(projectSchema).optional(),
    /**
     * What this computer offers: 'tools' (VS Code extension), 'clipboard' (PocketClipboard), 'screenshot' (PocketClipboard answers screen.capture),
     * 'overlay' (PocketClipboard shows the chat on screen: it receives session events, may list sessions, read history, list models, and write text into its person's chats and set their model and thinking level),
     * 'computer' (PocketClipboard answers computer.act: screen, mouse, keyboard, windows),
     * 'camera' (PocketClipboard answers camera.capture: frames of its webcam),
     * 'workspaces' (PocketClipboard on Linux gives every chat a desktop of its own: it answers workspace.control and runs requests that carry a `workspace` there),
     * 'host-desktop' (PocketClipboard on Linux whose owner switched those desktops off: chats use its real desktop, as on other systems),
     * 'workspace-env' (the VS Code extension runs a call's programs inside the desktop its `context` names and keeps background jobs apart per chat),
     * 'subagents' (an overlay that understands `subagent` session events).
     */
    capabilities: z.array(z.string()).optional(),
    /**
     * Names the Linux login the device runs in, as both PocketClipboard and the VS Code extension read it from the
     * same private file there: two devices of one person that report the same value share that computer's desktops.
     */
    workspaceHost: z.string().regex(/^[a-z0-9]{16,64}$/).optional(),
  })),

  // brain → every device
  /** The relay has a new public address: save it and reconnect there. */
  m('relay.moved', z.object({ url: z.string().url() })),

  // any → any
  m('control.kill', z.object({ scope: z.literal('all') })),
]);

export type InnerMessageBody = z.infer<typeof innerMessageBodySchema>;
export type MessageType = InnerMessageBody['type'];
export type PayloadOf<T extends MessageType> = Extract<InnerMessageBody, { type: T }>['payload'];

export const innerMessageSchema = z.intersection(
  z.object({ ts: z.number(), counter: z.number() }),
  innerMessageBodySchema,
);
export type InnerMessage = z.infer<typeof innerMessageSchema>;
