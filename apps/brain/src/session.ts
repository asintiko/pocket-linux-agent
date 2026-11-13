import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { realpathSync } from 'node:fs';
import {
  type BackgroundTask,
  type Effort,
  type ModelInfo,
  normalizeSystemPrompt,
  type RunningTool,
  MCP_SERVER_NAME,
  type SessionEvent,
  type SessionMeta,
  type SessionState,
  type Subagent,
  type SubagentEvent,
} from '@pocket/protocol';
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk';
import { CHAT_ALLOWED_TOOLS, chatTools, chatToolsPrompt, FALLBACK_MODELS, type ChatControl, type ChatPatch } from './chat-tools.js';
import { computerTools, computerToolsPrompt, ComputerState, type ComputerTarget } from './computer-tools.js';
import { isCodexModel, runCodexTurn } from './codex.js';
import { isMarketModel, runMarketTurn, withMarket } from './marketllm.js';
import { KimiEngine } from './kimi-engine.js';
import { isKimiModel, KIMI_FALLBACK_MODELS, kimiCliModel, withKimi } from './kimi-models.js';
import { agentDefinitions, AUTO_ALLOWED_TOOLS, BUILTIN_TOOLS, CLAUDE_TOOLS, claudeTool, readLocalSkillFile, SUBAGENT_DESKTOP_NOTE, toDisplayCall, TOOL_ALIASES } from './claude-tools.js';
import type { ExecutorHandle, ExecutorInfo } from './executor.js';
import { SubagentTracker, summarizeInput } from './subagents.js';
import { MAIN_DESKTOP } from './workspaces.js';
import { log } from './log.js';
import { PC_ALLOWED_TOOLS, pcTools, pcToolsPrompt, type PcHandle } from './pc-tools.js';
import { ATTACHMENTS_DIR, chatFolder, DEFAULT_MAC_WORKSPACE, GUEST_PROMPT, guestSandbox, insideRoot, macSandbox, macWorkspaceFor, ownFolderPrompt, SANDBOX_PROMPT } from './sandbox.js';
import { readApiKey, readClaudeToken } from './api-key.js';
import { isOrcaModel, ORCA_STAND_IN, orcaEndpoint, readOrcaKey, withOrca } from './orca.js';
import { ensureSkillsPlugin, paths } from './store.js';

export interface SessionHost {
  executorFor(sessionId: string): ExecutorHandle;
  /** The person's PocketClipboard computer for the pc_* tools; with `agent`, as that subagent of the chat reaches it (a desktop of its own). */
  pcFor(sessionId: string, agent?: string): PcHandle;
  /** Whether the chat's shell commands run on the computer its desktop is on, so that what they start shows up there. */
  commandsInDesktop?(sessionId: string): boolean;
  /** A subagent of the chat is over: the desktop it had, if any, is closed. */
  closeDesktop?(sessionId: string, agent: string): void;
  /** For an invited person's Mac chat, the only part of the Mac it may touch; undefined for the owner and remote chats. */
  guestRoot(sessionId: string): string | undefined;
  /** Chats of the owner may bill the owner's Anthropic API key; nobody else's may. */
  ownerChat(sessionId: string): boolean;
  userName(sessionId: string): string;
  emit(sessionId: string, event: SessionEvent, durable: boolean): void;
  metaChanged(meta: SessionMeta): void;
  canUseTool: (sessionId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionResult>;
  claudeOptions(): Partial<Options>;
  onClaudeVersion(version: string): void;
}

/** A unit of text the user typed plus optional photos and files. */
export interface UserTurn {
  text: string;
  attachments?: { mime: string; dataBase64: string; name?: string }[];
  from: string;
  /** Spoken on a call: the reply is read aloud, so it must be short and plain. */
  voice?: boolean;
}

/** Prepended to spoken turns. Claude keeps its tools; only the shape of the answer changes. */
export const VOICE_NOTE = [
  '[Voice call. The user said this aloud and will hear your reply read by text-to-speech.',
  'Start with the spoken answer: one to three short sentences in the user\'s language, the way a person would say it on the phone, with no markdown, lists, code, commands, paths, links or tables.',
  'Only that part is read aloud. If details help (code, commands, tables, steps), put them after a line with only --- on it: the phone stops reading there and they stay in the chat. Then say so in the spoken part, for example that the code is in the chat.',
  'If they ask for a command, code or any text to paste, put the exact text on their computer with pc_clipboard_write and say it is on the clipboard, ready for Ctrl+V.',
  'If they ask to look at the screen, take a screenshot with pc_screenshot and tell them what matters. If they ask what they copied, read it with pc_clipboard_read and summarise it.',
  'If they ask to switch the model or how hard you think, do it with chat_configure and say in one sentence what changed.',
  'If they ask you to do something on their computer (open a program or a site, type into a window, click something), do it with the computer tool and say in a few words what you are doing.',
  'Before a tool that takes a while, say one short sentence about what you are doing, so the line is not silent.',
  'Do not read out file paths, URLs, hashes or long numbers: describe them in words.',
  'After any action, say in one sentence what you did and what you saw.]',
].join(' ');

export { DEFAULT_MAC_WORKSPACE };

const INLINE_TEXT_LIMIT = 200_000;
const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/i.test(mime);
const isTextLike = (mime: string, name = '') => /^text\/|json|xml|yaml|javascript|typescript|csv|markdown/i.test(mime) || /\.(txt|md|json|ya?ml|csv|log|ts|tsx|js|jsx|py|cs|java|go|rs|html?|css|sql|sh|ps1|ini|toml|xml)$/i.test(name);

function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = basename(name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 120) : fallback;
}

/** The id Claude Code gives the tool use a call belongs to; other engines do not say. */
function toolUseIdOf(extra: unknown): string | undefined {
  const id = (extra as { _meta?: Record<string, unknown> } | null | undefined)?._meta?.['claudecode/toolUseId'];
  return typeof id === 'string' && id ? id : undefined;
}

/** Aborted when Claude Code cancels the call the handler was started for. */
function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | null | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** How long a tool call waits for the stream to say whose it is. */
const ATTRIBUTION_WAIT_MS = 2000;

async function waitFor<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** `desktop`: the chat works in a Linux desktop of its own on its PocketClipboard computer. Commands of a Mac chat run on the Mac, never there. */
function macSystemPrompt(cwd: string, projectInstructions: string | null, pcName: string | undefined, place: { own: boolean; sandboxed: boolean }, desktop = false): string {
  return [
    '# Workspace',
    `You work on the user\'s Mac in ${cwd}. Use your normal tools there.`,
    'The user chats from a phone. Keep replies short and lead with the outcome; they can copy any reply or code block to their Windows laptop clipboard with one tap, so put things meant for pasting into a single code block.',
    'Files the user attaches (often straight from their Windows clipboard) are saved on this Mac; their paths are listed in the message. Read them from there.',
    place.own ? ownFolderPrompt(cwd) : '',
    place.sandboxed ? SANDBOX_PROMPT : '',
    pcToolsPrompt(pcName, desktop),
    computerToolsPrompt(pcName, desktop ? { commands: false } : undefined),
    chatToolsPrompt(),
    projectInstructions ? `# Project instructions (CLAUDE.md)\n${projectInstructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Built-ins that need a terminal UI or act outside the chat. */
const MAC_DISALLOWED = ['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'SendUserFile', 'Workflow'];
const MAC_AUTO_ALLOWED = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', ...BUILTIN_TOOLS.filter((t) => t !== 'ExitPlanMode'), ...PC_ALLOWED_TOOLS, ...CHAT_ALLOWED_TOOLS];
/** Claude Code's own file tools and where each keeps its path. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];
/** For invited people the file tools are not pre-allowed: every call goes through guestFileCheck. */
const GUEST_AUTO_ALLOWED = MAC_AUTO_ALLOWED.filter((t) => !FILE_TOOLS.has(t));

/** An invited person's file tool may only touch paths inside their root; anything else is denied without asking. */
export function guestFileCheck(toolName: string, input: Record<string, unknown>, cwd: string, root: string): string | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  const paths = PATH_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (typeof input.pattern === 'string' && (toolName === 'Glob' || isAbsolute(input.pattern) || input.pattern.startsWith('~'))) {
    const fixed = input.pattern.split(/[*?[{]/)[0]!;
    if (isAbsolute(fixed) || fixed.startsWith('~') || fixed.includes('..')) paths.push(fixed.replace(/^~/, homedir()) || '/');
  }
  const outside = paths.find((p) => !insideRoot(p.replace(/^~(?=$|\/)/, homedir()), cwd, root));
  return outside ? `${outside} is outside your workspace (${root}); only files there are yours.` : null;
}

const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const IDLE_SHUTDOWN_MS = 30 * 60_000;

function providerFor(model: string | null | undefined): string {
  if (isMarketModel(model)) return 'MarketLLM';
  if (isCodexModel(model)) return 'Codex';
  if (isKimiModel(model ?? undefined)) return 'Kimi';
  return 'Claude';
}

/** How a remote computer is spoken of in the prompts; a computer that has not said what it runs is taken for Windows, as before. */
interface RemotePlatform {
  name: string;
  /** "the user's Windows laptop" */
  machine: string;
  /** "the Windows laptop" */
  short: string;
  /** What subagents are told about the shell. */
  shell: string;
  /** What the chat's main agent is told about the shell. */
  shellLong: string;
}

export function remotePlatform(info: ExecutorInfo | null | undefined): RemotePlatform {
  const os = info?.os ?? '';
  const posix = (name: string, machine: string, short: string, fallback: string): RemotePlatform => {
    const shell = info?.shell && info.shell !== 'none' ? info.shell : fallback;
    return {
      name,
      machine,
      short,
      shell: `Bash runs ${shell} there, not PowerShell, whatever a tool description says: use POSIX shell syntax and ${name} paths.`,
      shellLong: `Bash runs ${shell} there, not PowerShell, whatever a tool description says: use POSIX shell syntax and ${name} paths.`,
    };
  };
  if (/^linux/i.test(os)) return posix('Linux', "the user's Linux computer", 'that Linux computer', 'sh');
  if (/^darwin/i.test(os)) return posix('macOS', "the user's Mac", 'that Mac', 'zsh');
  return {
    name: 'Windows',
    machine: "the user's Windows laptop",
    short: 'the Windows laptop',
    shell: 'Bash runs Windows PowerShell: use PowerShell syntax and Windows paths.',
    shellLong: 'Bash runs Windows PowerShell, not a POSIX shell: use PowerShell syntax and Windows paths.',
  };
}

function remoteWorkspaceBlock(workspaces: string[], platform: RemotePlatform = remotePlatform(null)): string {
  const roots = workspaces.length ? workspaces.map((w) => `- ${w}`).join('\n') : '- (no folder open yet)';
  return [
    `# Remote ${platform.name} workspace`,
    `All work happens on ${platform.machine} through the mcp__pocket__* tools (Bash, Read, Write, Edit, Glob, Grep, LS, BashOutput, KillShell).`,
    'The working directory in your environment details is an empty scratch folder on another machine. Never pass it or any path under it to a tool.',
    `Workspace roots on ${platform.name}:\n${roots}`,
    `Paths may be relative to the first root. ${platform.shell}`,
  ].join('\n');
}

/** `desktop`: the chat works in a Linux desktop of its own on its PocketClipboard computer; `commands` says whether its shell commands run there too. */
function systemPromptFor(
  workspaces: string[],
  projectInstructions: string | null,
  pcName: string | undefined,
  platform: RemotePlatform = remotePlatform(null),
  desktop?: { commands: boolean },
): string {
  const roots = workspaces.length ? workspaces.map((w) => `- ${w}`).join('\n') : '- (no folder open yet)';
  return [
    `# Remote ${platform.name} workspace`,
    `You run on a separate machine. All work happens on ${platform.machine} through the mcp__pocket__* tools (Bash, Read, Write, Edit, Glob, Grep, LS, BashOutput, KillShell, git_*). Subagents you start get the same tools.`,
    `Nothing on the machine you run on is part of the task: every path and command refers to ${platform.short}. The only exception is skill files, which Read serves locally.`,
    'The working directory in your environment details is an empty local scratch folder. Never pass it to a tool.',
    `Workspace roots on ${platform.name}:\n${roots}`,
    'Tool paths may be relative; they resolve against the first workspace root. Prefer relative paths.',
    `${platform.shellLong} Use run_in_background for servers and watchers. Read a file before editing it.`,
    'The user is chatting from a phone or a small VS Code panel: keep replies short and lead with the outcome.',
    pcToolsPrompt(pcName, desktop !== undefined),
    computerToolsPrompt(pcName, desktop),
    chatToolsPrompt(),
    projectInstructions ? `# Project instructions (CLAUDE.md on the ${platform.name} workspace)\n${projectInstructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function withChatSystemPrompt(prompt: string, systemPrompt: string | undefined): string {
  return systemPrompt === undefined || systemPrompt === ''
    ? prompt
    : `# Conversation-specific instructions\n${systemPrompt}\n\n${prompt}`;
}

/** Async queue feeding user turns into the long-lived Claude Code query. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;

  push(msg: SDKUserMessage): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  end(): void {
    this.done = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

/**
 * One chat thread backed by one Claude Code session.
 * The Claude Code process is started lazily and stopped after a period of inactivity; it is resumed by id later.
 */
export class Session {
  private q: Query | null = null;
  private kimi: KimiEngine | null = null;
  private codexTurn: AbortController | null = null;
  private marketTurn: AbortController | null = null;
  private startingProviders = 0;
  private input: InputQueue | null = null;
  private abort: AbortController | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingToolUseIds = new Map<string, string[]>();
  private readonly running = new Map<string, RunningTool>();
  private readonly background = new Map<string, BackgroundTask>();
  /** The chat's child agents: their cards in the chat, and which tool call belongs to which of them. */
  private readonly tracker: SubagentTracker = new SubagentTracker({
    emit: (event, durable) => this.recordSubagent(event, durable),
    ended: (id) => this.subagentEnded(id),
    describe: (name, input) => this.describeTool(name, input),
  });
  /** Which agent made each tool use: null for the chat's main agent, else the Agent tool use that started the subagent. */
  private readonly toolOwners = new Map<string, string | null>();
  /** Ends what the main agent's reply in progress is waiting for on the executor when the user stops it. */
  private turnAbort: AbortController | null = null;
  /** The user stopped the reply in progress: children it was waiting for end as stopped, not as done. */
  private turnStopped = false;
  /** What the chat was doing when a question went to the phone. */
  private beforeQuestion: SessionState | undefined;
  private turnStartedAt: number | undefined;
  /** Computer the running Claude Code process was started for; its prompt names that computer's folders. */
  private startedOn: string | undefined;
  private restartAfterTurn = false;
  /** Model/effort Claude switched to from inside a turn; the live process takes it when the turn ends. */
  private pendingConfig: ChatPatch | null = null;
  /** Which screenshot Claude's computer-use coordinates refer to. */
  private readonly computer = new ComputerState();
  /** The same for each subagent that has a desktop of its own, by task id. */
  private readonly childComputers = new Map<string, ComputerState>();
  /** Deleted chats must not resurface through late state updates from a stopping process. */
  private destroyed = false;
  private streamedText = false;
  private textBuffer = '';
  private started: boolean;
  private engineKind: 'claude' | 'kimi' | undefined;

  constructor(
    public meta: SessionMeta,
    private readonly host: SessionHost,
    resumable: boolean,
  ) {
    let systemPrompt: string | undefined;
    try {
      systemPrompt = normalizeSystemPrompt(meta.systemPrompt);
    } catch {
      log(`discarding over-limit system prompt for ${meta.sessionId}`);
    }
    this.meta = { ...meta, systemPrompt };
    this.started = resumable && !isCodexModel(meta.model) && !isMarketModel(meta.model) && !meta.codexThreadId;
  }

  get id(): string {
    return this.meta.sessionId;
  }

  get live(): boolean {
    return this.q !== null || this.kimi !== null || this.codexTurn !== null || (this.marketTurn !== null && !this.marketTurn.signal.aborted);
  }

  runningTools(): RunningTool[] {
    return [...this.running.values()];
  }

  /** Background commands or subagents are still working even if the turn has ended. */
  get busy(): boolean {
    return this.running.size > 0 || this.background.size > 0 || this.tracker.size > 0;
  }

  subagents(): Subagent[] {
    return this.tracker.subagents();
  }

  backgroundTasks(): BackgroundTask[] {
    return [...this.background.values()];
  }

  get turnStarted(): number | undefined {
    return this.turnStartedAt;
  }

  /** Applies model/effort live; billing and system-prompt changes need a fresh process. */
  async configure(patch: ChatPatch & { systemPrompt?: string }): Promise<void> {
    if (isCodexModel(patch.model) && !this.host.ownerChat(this.id)) {
      throw new Error("Only the owner can use the host's Codex account.");
    }
    const nextModel = patch.model === undefined ? this.meta.model : patch.model;
    const codex = isCodexModel(nextModel);
    const market = isMarketModel(nextModel);
    if (market) await this.validateMarketPatch(patch);
    if (patch.effort === 'ultra' && !codex && !market) throw new Error('Ultra effort is available only for supported provider models.');
    const switchingProvider = providerFor(nextModel) !== providerFor(this.meta.model);
    if (switchingProvider && (this.meta.state !== 'idle' || this.busy || this.startingProviders > 0 || this.marketTurn !== null)) {
      throw new Error('Stop or finish the current turn before switching the provider.');
    }
    const next: Partial<SessionMeta> = {};
    if (patch.model !== undefined) next.model = patch.model ?? undefined;
    if (patch.effort !== undefined) {
      next.effort = patch.effort === 'ultra' ? undefined : patch.effort ?? undefined;
      next.codexEffort = patch.effort === 'ultra' ? 'ultra' : undefined;
    } else if (patch.model !== undefined && (patch.model ?? undefined) !== this.meta.model) {
      next.effort = undefined;
      next.codexEffort = undefined;
    }
    const systemPrompt = patch.systemPrompt === undefined ? undefined : normalizeSystemPrompt(patch.systemPrompt);
    const systemPromptChanged = patch.systemPrompt !== undefined && systemPrompt !== this.meta.systemPrompt;
    if (patch.systemPrompt !== undefined) next.systemPrompt = systemPrompt;
    const billingChanged = this.needsFreshProcess(patch);
    if (patch.billing !== undefined) next.billing = patch.billing === 'api' ? 'api' : undefined;
    if (switchingProvider) {
      this.stop();
      next.context = undefined;
      if ((providerFor(nextModel) === 'Kimi' && this.engineKind === 'claude') || (providerFor(nextModel) === 'Claude' && this.engineKind === 'kimi')) {
        next.engine = undefined;
        this.started = false;
      }
      if (!this.engineKind && (providerFor(nextModel) === 'Kimi' || providerFor(nextModel) === 'Claude')) {
        next.engine = undefined;
        this.started = false;
      }
    }
    this.setMeta(next);
    if (codex || market) return;
    if (isKimiModel(this.meta.model)) {
      if (billingChanged || systemPromptChanged) {
        if (this.meta.state === 'idle' && !this.busy) this.stop();
        else this.restartAfterTurn = true;
        return;
      }
      if (this.kimi) {
        try {
          await this.kimi.configure(patch.model !== undefined && patch.model !== null ? kimiCliModel(patch.model) : undefined, patch.effort ?? undefined);
        } catch (e) {
          log(`live Kimi configure failed for ${this.id}, restarting on next message: ${String(e)}`);
          this.stop();
        }
      }
      return;
    }
    if (this.kimi && billingChanged) {
      if (this.meta.state === 'idle' && !this.busy) this.stop();
      else this.restartAfterTurn = true;
      return;
    }
    if (!this.q) return;
    if (billingChanged || systemPromptChanged) {
      // Prompt context and billing credentials are fixed at process start; the chat resumes on the next turn.
      if (this.meta.state === 'idle' && !this.busy) this.stop();
      else this.restartAfterTurn = true;
      return;
    }
    try {
      if (patch.model !== undefined) await this.q.setModel(patch.model ?? undefined);
      if (patch.effort !== undefined && patch.effort !== 'ultra') await this.q.applyFlagSettings({ effortLevel: patch.effort ?? undefined });
    } catch (e) {
      log(`live configure failed for ${this.id}, restarting on next message: ${String(e)}`);
      this.stop();
      throw e;
    }
  }

  /**
   * A change Claude asked for itself (chat_configure). The chat shows it at once; the live process takes it when the
   * turn is over, so the model never changes halfway through a tool loop.
   */
  configureAfterTurn(patch: ChatPatch): void | Promise<void> {
    const nextModel = patch.model === undefined ? this.meta.model : patch.model;
    if (isMarketModel(nextModel) || isMarketModel(this.meta.model) || isCodexModel(nextModel) || isCodexModel(this.meta.model)) {
      if ((isMarketModel(nextModel) || isCodexModel(nextModel)) && !this.host.ownerChat(this.id)) {
        throw new Error("Only the owner can use the host's provider account.");
      }
      const queue = () => {
        if (this.destroyed) return;
        this.pendingConfig = { ...this.pendingConfig, ...patch };
        if (this.meta.state === 'idle' && !this.busy) this.applyPendingConfig();
      };
      if (isMarketModel(nextModel)) return this.validateMarketPatch(patch).then(queue);
      queue();
      return;
    }
    if (patch.effort === 'ultra') throw new Error('Ultra effort is available only for supported Codex models.');
    const fresh = this.needsFreshProcess(patch);
    const next: Partial<SessionMeta> = {};
    if (patch.model !== undefined) next.model = patch.model ?? undefined;
    if (patch.effort !== undefined) next.effort = patch.effort ?? undefined;
    if (patch.billing !== undefined) next.billing = patch.billing === 'api' ? 'api' : undefined;
    this.setMeta(next);
    if (!this.q) return;
    if (fresh) {
      if (this.meta.state === 'idle' && !this.busy) this.stop();
      else this.restartAfterTurn = true;
      return;
    }
    this.pendingConfig = { ...this.pendingConfig, ...patch };
    if (this.meta.state === 'idle' && this.running.size === 0) this.applyPendingConfig();
  }

  /** How full the context window is after the turn, for the phone's chip; estimated locally, no extra API call. */
  private refreshContext(): void {
    const q = this.q;
    if (!q) return;
    Promise.resolve()
      .then(() => q.getContextUsage({ detail: 'summary' }))
      .then((u) => {
        if (this.q !== q || this.destroyed) return;
        this.setMeta({ context: { tokens: u.totalTokens, max: u.rawMaxTokens, percent: Math.round(u.percentage) } });
      })
      .catch((e: unknown) => log(`context usage for ${this.id} failed: ${String(e)}`));
  }

  /** Billing and the provider are fixed when Claude Code starts, so changing them needs a new process. */
  private needsFreshProcess(patch: ChatPatch): boolean {
    return (
      (patch.billing !== undefined && (patch.billing === 'api') !== (this.meta.billing === 'api')) ||
      (patch.model !== undefined && isOrcaModel(patch.model ?? undefined) !== isOrcaModel(this.meta.model)) ||
      (patch.model !== undefined && providerFor(patch.model) !== providerFor(this.meta.model))
    );
  }

  private async applyPendingConfig(): Promise<void> {
    const patch = this.pendingConfig;
    this.pendingConfig = null;
    if (patch) await this.configure(patch).catch((error: unknown) => {
      this.record({ kind: 'error', message: error instanceof Error ? error.message : String(error) }, true);
    });
  }

  private async validateMarketPatch(patch: ChatPatch): Promise<void> {
    if (!this.host.ownerChat(this.id)) throw new Error("Only the owner can use the host's MarketLLM key.");
    const model = patch.model === undefined ? this.meta.model : patch.model;
    const available = await withMarket([], true);
    const selected = available.find((candidate) => candidate.value === model);
    if (!selected) throw new Error('This MarketLLM model is unavailable for the configured key.');
    if (patch.effort != null && !selected.efforts?.includes(patch.effort)) {
      throw new Error(`MarketLLM model ${selected.displayName} does not support ${patch.effort} effort.`);
    }
  }

  /** Moves the chat to another computer. The process restarts so Claude sees that computer's folders and CLAUDE.md. */
  /** `executorId` undefined means the Mac itself. */
  setExecutor(executorId: string | undefined, project?: string | null): void {
    if (project === undefined && executorId !== this.meta.executorId && this.meta.project) project = null;
    const projectChanged = project !== undefined && (project ?? undefined) !== this.meta.project;
    if (this.marketTurn && (executorId !== this.meta.executorId || projectChanged)) this.marketTurn.abort();
    this.setMeta({ executorId, ...(project !== undefined ? { project: project ?? undefined } : {}) });
    this.resetDesktop();
    if (!this.q || (this.startedOn === executorId && !projectChanged)) return;
    if (this.meta.state === 'idle' && !this.busy) this.stop();
    else this.restartAfterTurn = true;
  }

  setHidden(hidden: boolean): void {
    this.setMeta({ hidden: hidden || undefined });
  }

  /** Stops Claude Code and removes the chat's history from disk. Its own folder on the Mac stays, just in case. */
  destroy(): void {
    this.stop();
    this.destroyed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    rmSync(this.historyFile(), { force: true });
    rmSync(this.agentsFile(), { force: true });
    const folder = chatFolder(this.meta);
    if (existsSync(folder)) log(`chat ${this.id} deleted; its files stay in ${folder}`);
  }

  rename(title: string): void {
    this.setMeta({ title });
  }

  async supportedModels(): Promise<ModelInfo[] | null> {
    const kimi = this.kimi?.models() ?? KIMI_FALLBACK_MODELS;
    if (isKimiModel(this.meta.model)) return withKimi(FALLBACK_MODELS, kimi);
    if (!this.q) return null;
    const models = await this.q.supportedModels();
    return withKimi(models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels } : {}),
    })), kimi);
  }

  history(): SessionEvent[] {
    try {
      return readFileSync(this.historyFile(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SessionEvent);
    } catch {
      return [];
    }
  }

  async send(turn: UserTurn): Promise<void> {
    const attachments = turn.attachments ?? [];
    if (this.marketTurn) throw new Error('A MarketLLM reply is already in progress or stopping.');
    const useCodex = isCodexModel(this.meta.model);
    const useMarket = isMarketModel(this.meta.model);
    if (useMarket) {
      if (!this.host.ownerChat(this.id)) throw new Error("Only the owner can use the host's MarketLLM key.");
      if (this.marketTurn) throw new Error('A MarketLLM reply is already in progress.');
      if (attachments.some((attachment) => !isImage(attachment.mime) && (!isTextLike(attachment.mime, attachment.name) || Buffer.byteLength(attachment.dataBase64, 'base64') > INLINE_TEXT_LIMIT))) {
        throw new Error('MarketLLM accepts images and text files up to 200 KB.');
      }
    }
    if (useCodex) {
      if (!this.host.ownerChat(this.id)) throw new Error("Only the owner can use the host's Codex account.");
      if (this.codexTurn) throw new Error('A Codex reply is already in progress.');
      if (attachments.length) throw new Error('Codex currently accepts text messages only.');
    }
    const images = attachments.filter((a) => isImage(a.mime) && !a.name);
    const files = attachments.filter((a) => !images.includes(a));
    this.record(
      {
        kind: 'user',
        text: turn.text,
        from: turn.from,
        ...(images.length ? { images: images.length } : {}),
        ...(files.length ? { files: files.map((f, i) => safeFileName(f.name, `file-${i + 1}`)) } : {}),
        ...(turn.voice ? { voice: true } : {}),
      },
      true,
    );
    this.setMeta({ lastText: turn.text.slice(0, 200) });
    if (useCodex) return this.sendCodex(turn);
    if (useMarket) return this.sendMarket(turn);
    if (isKimiModel(this.meta.model)) return this.sendKimi(turn, images, files);
    if (!this.q) await this.startProvider(() => this.start());
    this.setState('running');
    this.turnStartedAt ??= Date.now();
    const blocks: Exclude<SDKUserMessage['message']['content'], string> = images.map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mime as 'image/png', data: img.dataBase64 },
    }));
    const notes = this.saveFiles(files, blocks);
    const spoken = turn.voice ? `${VOICE_NOTE}\n\n${turn.text}` : turn.text;
    const text = notes.length ? `${spoken}\n\n${notes.join('\n')}` : spoken;
    const content: SDKUserMessage['message']['content'] = blocks.length ? [...blocks, { type: 'text' as const, text }] : text;
    this.input!.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } as SDKUserMessage);
    this.touch();
  }

  private async startProvider(start: () => Promise<void>): Promise<void> {
    this.startingProviders++;
    try {
      await start();
    } finally {
      this.startingProviders--;
    }
  }

  private async sendCodex(turn: UserTurn): Promise<void> {
    const controller = new AbortController();
    const started = Date.now();
    this.codexTurn = controller;
    this.turnStartedAt = started;
    this.setState('running');
    let answer = '';
    let failure: string | undefined;
    try {
      const cwd = join(paths.workDir, 'codex', this.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      await runCodexTurn({
        cwd,
        threadId: this.meta.codexThreadId,
        instructions: this.meta.systemPrompt,
        model: this.meta.model,
        effort: this.meta.codexEffort ?? this.meta.effort,
        text: turn.voice ? `Answer briefly in the user's language, in plain text for speech.\n\n${turn.text}` : turn.text,
        signal: controller.signal,
        onThread: (id) => {
          if (!controller.signal.aborted && id !== this.meta.codexThreadId) this.setMeta({ codexThreadId: id });
        },
        onDelta: (text) => {
          if (controller.signal.aborted) return;
          answer += text;
          this.record({ kind: 'text_delta', text }, false);
        },
      });
    } catch (e) {
      if (!controller.signal.aborted) failure = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.codexTurn === controller) {
        this.codexTurn = null;
        if (answer) {
          this.record({ kind: 'text', text: answer }, true);
          this.setMeta({ lastText: answer.slice(0, 200) });
        }
        if (failure !== undefined) this.record({ kind: 'error', message: failure }, true);
        else if (!controller.signal.aborted) this.record({ kind: 'result', durationMs: Date.now() - started }, true);
        this.turnStartedAt = undefined;
        this.setState('idle');
      }
    }
  }

  private marketScope(): string {
    const executor = this.host.executorFor(this.id);
    return JSON.stringify({
      executor: executor.id ?? null,
      project: this.meta.project ?? executor.root ?? null,
      workspace: executor.id === undefined ? macWorkspaceFor(this.meta).cwd : executor.info?.workspaces ?? [],
      computer: this.host.pcFor(this.id).id ?? null,
    });
  }

  private async sendMarket(turn: UserTurn): Promise<void> {
    const controller = new AbortController();
    const started = Date.now();
    const scope = this.marketScope();
    const executor = this.host.executorFor(this.id);
    const timeout = setTimeout(() => controller.abort(new Error('MarketLLM reply timed out after 10 minutes.')), 10 * 60_000);
    this.marketTurn = controller;
    this.turnStartedAt = started;
    this.setState('running');
    const automatic = new Set([...AUTO_ALLOWED_TOOLS, ...PC_ALLOWED_TOOLS, ...CHAT_ALLOWED_TOOLS]);
    try {
      const roots = executor.root ? [executor.root] : executor.info?.workspaces ?? [];
      const pc = this.host.pcFor(this.id);
      let instructions = executor.id === undefined
        ? [
          'You are an assistant in Pocket. Use the provided tools to work with the paired computer.',
          'The available tools describe what you can do. Ask the user for files or details when a required tool is unavailable.',
          pcToolsPrompt(pc.name, pc.desktop !== undefined), computerToolsPrompt(pc.name, pc.desktop ? { commands: executor.id !== undefined && this.host.commandsInDesktop?.(this.id) === true } : undefined), chatToolsPrompt(),
        ].join('\n\n')
        : [
          'You are an assistant in Pocket. File and command tools run on the paired remote computer.',
          `The remote computer reports ${executor.info?.os ?? 'an unknown operating system'}; its shell is ${executor.info?.shell ?? 'the configured shell'}. Use that platform's paths and command syntax.`,
          `Workspace roots:\n${roots.map((root) => `- ${root}`).join('\n') || '(no folder open yet)'}`,
          'Paths resolve relative to the first workspace root. Read a file before editing it.',
          pcToolsPrompt(pc.name, pc.desktop !== undefined), computerToolsPrompt(pc.name, pc.desktop ? { commands: executor.id !== undefined && this.host.commandsInDesktop?.(this.id) === true } : undefined), chatToolsPrompt(),
        ].join('\n\n');
      instructions = withChatSystemPrompt(instructions, this.meta.systemPrompt).replaceAll(MCP_PREFIX, '');
      const attachments = turn.attachments ?? [];
      const images = attachments.filter((attachment) => isImage(attachment.mime));
      const notes = attachments.filter((attachment) => !isImage(attachment.mime)).map((file, index) => {
        const name = safeFileName(file.name, `file-${index + 1}`);
        return `[Attached file ${name}]\n\`\`\`\n${Buffer.from(file.dataBase64, 'base64').toString('utf8')}\n\`\`\``;
      });
      const spoken = turn.voice ? `${VOICE_NOTE}\n\n${turn.text}` : turn.text;
      const usage = await runMarketTurn({
        sessionId: this.id,
        scope,
        instructions,
        model: this.meta.model!,
        effort: this.meta.codexEffort ?? this.meta.effort,
        text: [spoken, ...notes].join('\n\n'),
        images,
        tools: executor.id === undefined ? this.pocketTools() : this.remoteTools(controller.signal),
        signal: controller.signal,
        emit: (event) => {
          if (this.marketTurn !== controller || this.destroyed) return;
          if (event.kind === 'tool_use') {
            const shown = this.trackToolUse(event.id, MCP_PREFIX + event.name, event.input);
            this.record({ ...event, name: shown.name, input: shown.input }, true);
            return;
          }
          if (event.kind === 'tool_result') this.running.delete(event.id);
          if (event.kind === 'text') this.setMeta({ lastText: event.text.slice(0, 200) });
          this.record(event, event.kind !== 'text_delta' && event.kind !== 'tool_output');
        },
        canUseTool: async (name, input) => {
          const scoped = () => !controller.signal.aborted && scope === this.marketScope();
          if (!scoped()) return { behavior: 'deny', message: 'The turn stopped or its computer changed.' };
          if (automatic.has(MCP_PREFIX + name)) return { behavior: 'allow', updatedInput: input };
          const decision = await this.host.canUseTool(this.id, MCP_PREFIX + name, input, controller.signal);
          return scoped() ? decision : { behavior: 'deny', message: 'The turn stopped or its computer changed.' };
        },
      });
      if (this.marketTurn === controller && !controller.signal.aborted) {
        this.record({ kind: 'result', durationMs: Date.now() - started, ...usage }, true);
      }
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      const abortedWithError = failure instanceof Error && failure.name !== 'AbortError';
      if (this.marketTurn === controller && (!controller.signal.aborted || abortedWithError)) {
        this.record({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) }, true);
      }
    } finally {
      clearTimeout(timeout);
      if (this.marketTurn === controller) {
        this.marketTurn = null;
        this.running.clear();
        this.pendingToolUseIds.clear();
        this.turnStartedAt = undefined;
        this.setState('idle');
        await this.applyPendingConfig();
      }
    }
  }

  private async sendKimi(turn: UserTurn, images: { mime: string; dataBase64: string; name?: string }[], files: { mime: string; dataBase64: string; name?: string }[]): Promise<void> {
    this.textBuffer = '';
    this.streamedText = false;
    try {
      if (!this.kimi) await this.startProvider(() => this.startKimi());
    } catch (e) {
      this.record({ kind: 'error', message: e instanceof Error ? e.message : String(e) }, true);
      this.setState('idle');
      return;
    }
    const engine = this.kimi!;
    this.setState('running');
    this.turnStartedAt ??= Date.now();
    const started = Date.now();
    const sdkBlocks: Exclude<SDKUserMessage['message']['content'], string> = [];
    const notes = this.saveFiles(files, sdkBlocks);
    const spoken = turn.voice ? `${VOICE_NOTE}\n\n${turn.text}` : turn.text;
    const text = notes.length ? `${spoken}\n\n${notes.join('\n')}` : spoken;
    const content: AcpContentBlock[] = images.map((image) => ({ type: 'image', data: image.dataBase64, mimeType: image.mime }));
    // ACP restores the old system prompt; pass current chat instructions per turn without losing history.
    const instructions = this.meta.systemPrompt ?? 'No additional conversation-specific instructions. Use the default instructions.';
    content.push({ type: 'text', text: `# Current conversation instructions\nThese apply to this turn and replace any earlier conversation-specific instructions.\n\n${instructions}` });
    content.push({ type: 'text', text });
    try {
      await engine.prompt(content);
      const full = this.textBuffer;
      if (full) {
        this.record({ kind: 'text', text: full }, true);
        this.setMeta({ lastText: full.slice(0, 200) });
      }
      this.record({ kind: 'result', durationMs: Date.now() - started }, true);
      this.textBuffer = '';
      this.streamedText = false;
      this.running.clear();
      this.turnStartedAt = undefined;
      this.setState('idle');
      if (this.restartAfterTurn && !this.busy) {
        this.restartAfterTurn = false;
        this.stop();
        return;
      }
      await this.applyPendingConfig();
      this.touch();
    } catch (e) {
      this.record({ kind: 'error', message: e instanceof Error ? e.message : String(e) }, true);
      this.textBuffer = '';
      this.streamedText = false;
      this.running.clear();
      this.turnStartedAt = undefined;
      this.setState('idle');
    }
  }

  /**
   * On the Mac, files land in the chat's inbox and Claude gets their paths. On a remote computer Claude
   * cannot read Mac paths, so text files are inlined instead.
   */
  private saveFiles(files: { mime: string; dataBase64: string; name?: string }[], blocks: Exclude<SDKUserMessage['message']['content'], string>): string[] {
    if (!files.length) return [];
    const onMac = this.host.executorFor(this.id).id === undefined;
    const place = onMac ? macWorkspaceFor(this.meta) : undefined;
    const inbox = place?.own ? join(place.cwd, ATTACHMENTS_DIR) : join(paths.home, 'inbox', this.id);
    if (onMac) mkdirSync(inbox, { recursive: true, mode: 0o700 });
    const notes: string[] = [];
    files.forEach((f, i) => {
      const name = safeFileName(f.name, `file-${i + 1}`);
      const data = Buffer.from(f.dataBase64, 'base64');
      if (onMac) {
        let target = join(inbox, name);
        for (let n = 2; existsSync(target); n++) target = join(inbox, name.replace(/(\.[^.]*)?$/, `-${n}$1`));
        writeFileSync(target, data, { mode: 0o600 });
        notes.push(`[Attached file: ${target}]`);
        if (isImage(f.mime)) blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png', data: f.dataBase64 } });
      } else if (isTextLike(f.mime, name) && data.length <= INLINE_TEXT_LIMIT) {
        notes.push(`[Attached file ${name}]\n\`\`\`\n${data.toString('utf8')}\n\`\`\``);
      } else if (isImage(f.mime)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png', data: f.dataBase64 } });
        notes.push(`[Attached image ${name}]`);
      } else {
        notes.push(`[Attached file ${name} (${f.mime}, ${data.length} bytes) could not be passed on: this chat works on another computer]`);
      }
    });
    return notes;
  }

  async interrupt(): Promise<void> {
    // Stop ends the reply in progress and what it waits for: the main agent's calls on the executor, and the computer
    // (a long text being typed stops and held keys are let go). The desktop itself stays as it is for the next
    // message. Children the reply waits for end with it; ones sent to the background go on until their own card says.
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.turnStopped = this.meta.state !== 'idle';
    // A step in flight, or a mouse button an earlier step left held down: nothing else is the chat's to let go of.
    const letGo = (state: ComputerState, agent?: string) => {
      if (state.busy === 0 && !state.held) return;
      state.held = false;
      void this.host.pcFor(this.id, agent).computer({ action: 'release' }).catch(() => {});
    };
    letGo(this.computer);
    for (const [agent, state] of this.childComputers) {
      if (!this.tracker.isBackground(agent)) letGo(state, agent);
    }
    if (this.marketTurn) {
      this.marketTurn.abort();
      return;
    }
    if (this.codexTurn) {
      this.codexTurn.abort();
      return;
    }
    if (this.kimi) {
      try {
        await this.kimi.cancel();
      } catch (e) {
        log(`Kimi interrupt failed for ${this.id}: ${String(e)}`);
      }
      return;
    }
    if (!this.q) return;
    try {
      await this.q.interrupt();
    } catch (e) {
      log(`interrupt failed for ${this.id}: ${String(e)}`);
    }
  }

  stop(): void {
    this.restartAfterTurn = false;
    this.pendingConfig = null;
    // The children run inside the process that is ending here: they end with it, and their cards say so.
    this.tracker.stopAll("Stopped together with the chat's agent before it finished.");
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.toolOwners.clear();
    this.input?.end();
    this.abort?.abort();
    this.marketTurn?.abort();
    this.codexTurn?.abort();
    this.codexTurn = null;
    this.kimi?.close();
    this.kimi = null;
    this.q = null;
    this.input = null;
    this.abort = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.running.clear();
    this.turnStartedAt = undefined;
    if (this.meta.state !== 'idle') this.setState('idle');
  }

  setState(state: SessionState): void {
    if (this.destroyed || this.meta.state === state) return;
    this.setMeta({ state });
    this.host.emit(this.id, { kind: 'state', state }, true);
  }

  /**
   * A tool call waits for the user's answer on the phone, or has it. With the answer in, the chat goes back to what
   * it was doing: replying, or nothing at all when the question came from a subagent that works in the background
   * after the reply that started it has ended. It must not look as if it were typing then.
   */
  setWaiting(waiting: boolean): void {
    if (waiting) {
      if (this.meta.state !== 'waiting_permission') this.beforeQuestion = this.meta.state;
      this.setState('waiting_permission');
    } else if (this.meta.state === 'waiting_permission') {
      this.setState(this.beforeQuestion === 'idle' ? 'idle' : 'running');
      this.beforeQuestion = undefined;
    }
  }

  private setMeta(patch: Partial<SessionMeta>): void {
    if (this.destroyed) return;
    this.meta = { ...this.meta, ...patch, updatedAt: Date.now() };
    this.host.metaChanged(this.meta);
  }

  private historyFile(): string {
    return join(paths.sessionsDir, `${this.id}.jsonl`);
  }

  private record(event: SessionEvent, durable: boolean): void {
    if (this.destroyed) return;
    const timestamped = event.at === undefined ? { ...event, at: Date.now() } : event;
    if (durable && event.kind !== 'text_delta' && event.kind !== 'tool_output') {
      appendFileSync(this.historyFile(), `${JSON.stringify(timestamped)}\n`, { mode: 0o600 });
    }
    this.host.emit(this.id, timestamped, durable);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.meta.state === 'idle' && !this.busy) {
        log(`session ${this.id} idle, stopping Claude Code`);
        this.stop();
      } else this.touch();
    }, IDLE_SHUTDOWN_MS);
  }

  private async startKimi(): Promise<void> {
    const executor = this.host.executorFor(this.id);
    this.startedOn = executor.id;
    const pc = this.host.pcFor(this.id);
    const pcName = pc.name;
    const desktop = pc.desktop !== undefined;
    let cwd: string;
    let prompt: string;
    if (executor.id === undefined) {
      const place = macWorkspaceFor(this.meta);
      const guestRoot = this.host.guestRoot(this.id);
      cwd = place.cwd;
      mkdirSync(cwd, { recursive: true });
      if (guestRoot) mkdirSync(guestRoot, { recursive: true, mode: 0o700 });
      prompt = `${guestRoot ? `${GUEST_PROMPT}\n\n` : ''}${macSystemPrompt(cwd, readInstructions(cwd), pcName, { own: place.own, sandboxed: !!guestRoot }, desktop)}`;
    } else {
      const roots = executor.root ? [executor.root] : (executor.info?.workspaces ?? []);
      let projectInstructions: string | null = null;
      if (executor.online) {
        const r = await executor.call('read_file', { path: 'CLAUDE.md' }, { timeoutMs: 15_000 });
        if (!r.isError) projectInstructions = r.content.replace(/^\s*\d+\t/gm, '');
      }
      cwd = join(paths.workDir, this.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      prompt = systemPromptFor(roots, projectInstructions, pcName, remotePlatform(executor.info), desktop ? { commands: this.host.commandsInDesktop?.(this.id) === true } : undefined);
    }
    const previous = this.meta.engine;
    const resumeId = previous && previous.cwd === cwd && this.engineKind !== 'claude' ? previous.id : undefined;
    this.abort = new AbortController();
    const engine = await KimiEngine.start({
      cwd,
      home: join(paths.workDir, 'kimi-home', this.id),
      prompt,
      model: this.meta.model ? kimiCliModel(this.meta.model) : undefined,
      effort: this.meta.effort,
      resumeId,
      tools: this.pocketTools(),
      events: {
        text: (delta) => {
          this.markWorking();
          this.streamedText = true;
          this.textBuffer += delta;
          this.record({ kind: 'text_delta', text: delta }, false);
        },
        tool: (id, name, input) => {
          const shown = this.trackToolUse(id, name, input);
          this.record({ kind: 'tool_use', id, name: shown.name, input: shown.input }, true);
        },
        toolResult: (id, content, isError) => {
          this.running.delete(id);
          this.record({ kind: 'tool_result', id, content, isError }, true);
        },
        error: (message) => this.record({ kind: 'error', message }, true),
        log: (message) => log(message),
      },
    });
    this.kimi = engine;
    this.engineKind = 'kimi';
    this.started = true;
    this.setMeta({ engine: { id: engine.sessionId, cwd } });
  }

  private async start(): Promise<void> {
    this.engineKind = 'claude';
    const executor = this.host.executorFor(this.id);
    this.startedOn = executor.id;
    const skillsPlugin = ensureSkillsPlugin();
    const orca = isOrcaModel(this.meta.model) ? await this.orca() : undefined;
    const apiKey = !orca && this.meta.billing === 'api' ? this.apiKey() : undefined;
    const subscriptionToken = orca || apiKey ? undefined : readClaudeToken();
    const common: Partial<Options> = {
      ...this.host.claudeOptions(),
      // OrcaRouter: Claude Code talks to the loopback endpoint in this process, which holds the real key.
      ...(orca ? { env: { ...stringEnv(process.env, ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']), ANTHROPIC_BASE_URL: orca.url, ANTHROPIC_API_KEY: orca.token } } : {}),
      // API billing: Claude Code uses the key instead of the subscription login, straight to api.anthropic.com.
      // Subscription: the long-lived token from `claude setup-token` when there is one, so no process has to refresh.
      ...(apiKey ? { env: { ...stringEnv(process.env, ['CLAUDE_CODE_OAUTH_TOKEN']), ANTHROPIC_API_KEY: apiKey } } : {}),
      ...(subscriptionToken ? { env: { ...stringEnv(process.env, ['ANTHROPIC_API_KEY']), CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken } } : {}),
      ...(orca ? { model: ORCA_STAND_IN } : this.meta.model ? { model: this.meta.model } : {}),
      ...(this.meta.effort ? { effort: this.meta.effort } : {}),
      settingSources: [],
      ...(skillsPlugin ? { plugins: [{ type: 'local' as const, path: skillsPlugin }], skills: 'all' as const } : {}),
      permissionMode: 'default',
      includePartialMessages: true,
      stderr: (data: string) => log(`claude[${this.id.slice(0, 8)}] ${data.trimEnd()}`),
    };

    let cwd: string;
    let specific: Partial<Options>;
    const pc = this.host.pcFor(this.id);
    const pcName = pc.name;
    const desktop = pc.desktop !== undefined;
    const guestRoot = executor.id === undefined ? this.host.guestRoot(this.id) : undefined;
    if (executor.id === undefined) {
      const place = macWorkspaceFor(this.meta);
      cwd = place.cwd;
      mkdirSync(cwd, { recursive: true });
      if (guestRoot) mkdirSync(guestRoot, { recursive: true, mode: 0o700 });
      const sandbox = guestRoot ? guestSandbox(guestRoot) : macSandbox(process.env, { autoAllow: place.own });
      specific = {
        tools: { type: 'preset', preset: 'claude_code' },
        disallowedTools: MAC_DISALLOWED,
        allowedTools: guestRoot ? GUEST_AUTO_ALLOWED : MAC_AUTO_ALLOWED,
        mcpServers: { [MCP_SERVER_NAME]: this.pcServer() },
        ...(sandbox ? { sandbox } : {}),
        // The chat's own folder is its sandbox: edits and commands there go through; a picked project still asks.
        ...(place.own ? { permissionMode: 'acceptEdits' as const } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: withChatSystemPrompt((guestRoot ? `${GUEST_PROMPT}\n\n` : '') + macSystemPrompt(cwd, readInstructions(cwd), pcName, { own: place.own, sandboxed: !!sandbox }, desktop), this.meta.systemPrompt), snapshot: false },
      };
    } else {
      const roots = executor.root ? [executor.root] : (executor.info?.workspaces ?? []);
      let projectInstructions: string | null = null;
      if (executor.online) {
        const r = await executor.call('read_file', { path: 'CLAUDE.md' }, { timeoutMs: 15_000 });
        if (!r.isError) projectInstructions = r.content.replace(/^\s*\d+\t/gm, '');
      }
      cwd = join(paths.workDir, this.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const platform = remotePlatform(executor.info);
      const inDesktop = desktop ? { commands: this.host.commandsInDesktop?.(this.id) === true } : undefined;
      specific = {
        tools: [...BUILTIN_TOOLS],
        toolAliases: TOOL_ALIASES,
        mcpServers: { [MCP_SERVER_NAME]: this.mcpServer() },
        strictMcpConfig: true,
        allowedTools: [...AUTO_ALLOWED_TOOLS, ...PC_ALLOWED_TOOLS, ...CHAT_ALLOWED_TOOLS],
        agents: agentDefinitions(remoteWorkspaceBlock(roots, platform), platform.name, desktop ? SUBAGENT_DESKTOP_NOTE : undefined),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: withChatSystemPrompt(systemPromptFor(roots, projectInstructions, pcName, platform, inDesktop), this.meta.systemPrompt), snapshot: false },
      };
    }

    const previous = this.meta.engine ?? (this.started ? { id: this.id, cwd: join(paths.workDir, this.id) } : undefined);
    const resume = previous !== undefined && previous.cwd === cwd;
    const engineId = resume ? previous.id : randomUUID();
    this.setMeta({ engine: { id: engineId, cwd } });

    this.input = new InputQueue();
    this.abort = new AbortController();
    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      if (guestRoot && FILE_TOOLS.has(toolName)) {
        // Inside their own workspace a person's files are theirs to read and edit; outside it nothing is.
        const refused = guestFileCheck(toolName, input, cwd, guestRoot);
        return refused ? { behavior: 'deny', message: refused } : { behavior: 'allow', updatedInput: input };
      }
      return this.host.canUseTool(this.id, toolName, input, signal);
    };
    const options: Options = {
      ...common,
      ...specific,
      cwd,
      canUseTool,
      abortController: this.abort,
      ...(resume ? { resume: engineId } : { sessionId: engineId }),
    };
    this.started = true;
    this.q = query({ prompt: this.input, options });
    void this.pump(this.q);
  }

  /** The pc_* and chat_* tools: what Mac and chat-only sessions get. */
  private pocketTools() {
    return [
      ...pcTools(async (extra) => (await this.computerTarget(extra)).pc),
      ...computerTools(() => this.host.pcFor(this.id), this.computer, { route: (extra) => this.computerTarget(extra) }),
      ...chatTools(() => this.chatControl()),
    ];
  }

  private pcServer() {
    return createSdkMcpServer({ name: MCP_SERVER_NAME, version: '0.1.0', alwaysLoad: true, tools: this.pocketTools() });
  }

  /** The loopback OrcaRouter endpoint, or the subscription when there is no key or it cannot start. */
  private async orca(): Promise<{ url: string; token: string } | undefined> {
    if (!readOrcaKey()) {
      log(`session ${this.id}: no OrcaRouter key, using the default model`);
      this.setMeta({ model: undefined });
      return undefined;
    }
    try {
      return await orcaEndpoint();
    } catch (e) {
      log(`session ${this.id}: OrcaRouter endpoint failed (${String(e)}), using the default model`);
      this.setMeta({ model: undefined });
      return undefined;
    }
  }

  /** The owner's key for an API-billed chat; without one (or for someone else's chat) it falls back to the subscription. */
  private apiKey(): string | undefined {
    const blocked = this.apiBlocked();
    const key = blocked ? undefined : readApiKey();
    if (!key) {
      log(`session ${this.id}: API billing unavailable (${blocked ?? 'no key'}), using the subscription`);
      this.setMeta({ billing: undefined });
    }
    return key;
  }

  private apiBlocked(): string | null {
    if (!this.host.ownerChat(this.id)) return "Only the owner's chats can use the owner's Anthropic API key.";
    if (!readApiKey()) return 'There is no Anthropic API key on the Mac yet: the owner sets it with `pocket-claude api-key set`.';
    return null;
  }

  private chatControl(): ChatControl {
    return {
      current: () => {
        const effort = this.meta.codexEffort ?? this.meta.effort;
        return { ...(this.meta.model ? { model: this.meta.model } : {}), ...(effort ? { effort } : {}), billing: this.meta.billing === 'api' ? 'api' : 'subscription' };
      },
      apiBlocked: () => this.apiBlocked(),
      models: async () => {
        const live = await this.supportedModels().catch(() => null);
        return withMarket(withOrca(withKimi(live?.length ? live : FALLBACK_MODELS, this.kimi?.models())), this.host.ownerChat(this.id));
      },
      configure: (patch) => this.configureAfterTurn(patch),
    };
  }

  private remoteTools(signal?: AbortSignal) {
    const executor = this.host.executorFor(this.id);
    const skillDirs = skillDirectories();
    const scratch = scratchPrefixes(join(paths.workDir, this.id));
    return [...this.pocketTools(), ...CLAUDE_TOOLS.map((t) =>
      tool(t.name, t.description, t.shape, async (args, extra) => {
        const toolUseId = this.takeToolUseId(t.name, extra);
        const input = unscratchPaths(args as Record<string, unknown>, scratch);
        if (t.name === 'Read' && typeof input.file_path === 'string') {
          const local = await readLocalSkillFile(skillDirs, input.file_path, input.offset as number | undefined, input.limit as number | undefined).catch(
            (e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`,
          );
          if (local !== undefined) return { content: [{ type: 'text' as const, text: local }] };
        }
        const call = t.toProtocol(input);
        let caller: string;
        try {
          caller = await this.callerOf(extra);
        } catch (e) {
          return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
        const result = await executor.call(call.name, call.args, {
          signal: this.callSignal(signal, caller, extra),
          ...(caller !== MAIN_DESKTOP ? { agent: caller } : {}),
          onOutput: (chunk, stream) => {
            if (toolUseId) this.record({ kind: 'tool_output', id: toolUseId, chunk, stream }, false);
          },
        });
        this.trackBackground(call, result.content, result.isError === true);
        return { content: [{ type: 'text' as const, text: result.content }], isError: result.isError ?? false };
      }),
      )];
  }

  private mcpServer() {
    return createSdkMcpServer({ name: MCP_SERVER_NAME, version: '0.1.0', alwaysLoad: true, tools: this.remoteTools() });
  }

  private trackBackground(call: { name: string; args: Record<string, unknown> }, content: string, isError: boolean): void {
    if (call.name === 'run_command' && call.args.background && !isError) {
      const id = /with id (\S+?)\./.exec(content)?.[1];
      if (id) this.background.set(id, { id, command: String(call.args.command), startedAt: Date.now() });
    } else if ((call.name === 'command_output' || call.name === 'command_kill') && typeof call.args.id === 'string') {
      if (isError || /exited|already|Stopping/.test(content.split('\n').pop() ?? content)) this.background.delete(call.args.id);
    }
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg);
    } catch (e) {
      if (this.q === q) {
        log(`session ${this.id} crashed: ${String(e)}`);
        this.record({ kind: 'error', message: e instanceof Error ? e.message : String(e) }, true);
      }
    } finally {
      if (this.q === q) {
        this.q = null;
        this.input = null;
        this.running.clear();
        this.turnStartedAt = undefined;
        // Claude Code is gone, and its tasks with it: no card is left saying that a child still runs.
        this.tracker.stopAll("Stopped: the chat's agent ended before this task finished.");
        this.setState('idle');
      }
    }
  }

  /** Queues the id for the MCP handler of the same tool and marks it running. Returns what clients should see. */
  private trackToolUse(id: string, rawName: string, input: unknown, parentId?: string): { name: string; input: unknown } {
    const name = rawName.startsWith(MCP_PREFIX) ? rawName.slice(MCP_PREFIX.length) : rawName;
    if (claudeTool(name) && rawName.startsWith(MCP_PREFIX)) {
      const queue = this.pendingToolUseIds.get(name) ?? [];
      queue.push(id);
      this.pendingToolUseIds.set(name, queue);
    }
    this.toolOwners.set(id, parentId ?? null);
    if (this.toolOwners.size > 500) this.toolOwners.delete(this.toolOwners.keys().next().value!);
    const shown = toDisplayCall(name, input);
    this.running.set(id, { id, name: shown.name, input: shown.input, startedAt: Date.now(), ...(parentId ? { parentId } : {}) });
    return shown;
  }

  /** A background subagent finishing makes Claude answer on its own, without a user turn. */
  private markWorking(): void {
    if (this.meta.state !== 'idle') return;
    this.turnStartedAt ??= Date.now();
    this.setState('running');
  }

  /** A tool call as the chat shows it: the display name and a line on what it is about. */
  private describeTool(rawName: string, input: unknown): { tool: string; summary?: string } {
    const shown = toDisplayCall(rawName.startsWith(MCP_PREFIX) ? rawName.slice(MCP_PREFIX.length) : rawName, input);
    const summary = summarizeInput(shown.input);
    return { tool: shown.name, ...(summary ? { summary } : {}) };
  }

  /** A child agent is over: its screenshots mean nothing any more and the desktop it had is closed. */
  private subagentEnded(id: string): void {
    this.childComputers.delete(id);
    this.host.closeDesktop?.(this.id, id);
  }

  private recordSubagent(event: SubagentEvent, durable: boolean): void {
    this.record(event, durable);
    if (durable) this.saveLiveSubagents();
  }

  private agentsFile(): string {
    return join(paths.sessionsDir, `${this.id}.agents.json`);
  }

  /** The cards of the children that are running, next to the history: what `reconcile` closes if this process dies with them. */
  private saveLiveSubagents(): void {
    if (this.destroyed) return;
    const live = this.tracker.events();
    try {
      if (live.length) writeFileSync(this.agentsFile(), JSON.stringify(live), { mode: 0o600 });
      else rmSync(this.agentsFile(), { force: true });
    } catch (e) {
      log(`session ${this.id}: could not note its running subagents: ${String(e)}`);
    }
  }

  /**
   * Closes the cards of children that were running when the daemon went away. They ran inside Claude Code's process,
   * which is gone with it, so they are over; without this their cards would say "running" for ever. Called once the
   * relay is reachable, so that the phones hear of it.
   */
  reconcile(): void {
    if (this.destroyed || this.tracker.size > 0) return;
    let left: unknown;
    try {
      left = JSON.parse(readFileSync(this.agentsFile(), 'utf8'));
    } catch {
      return;
    }
    rmSync(this.agentsFile(), { force: true });
    if (!Array.isArray(left)) return;
    const endedAt = Date.now();
    for (const event of left as Partial<SubagentEvent>[]) {
      if (event?.kind !== 'subagent' || typeof event.id !== 'string' || typeof event.task !== 'string' || typeof event.startedAt !== 'number') continue;
      const { activity: _activity, desktop: _desktop, at: _at, ...card } = event as SubagentEvent;
      this.record({ ...card, status: 'cancelled', error: 'Stopped: Pocket was restarted on the Mac before this task finished.', endedAt }, true);
    }
  }

  /** The cards of the running children as they are right now, for a client that just connected or opened the chat. */
  liveSubagentEvents(): SubagentEvent[] {
    return this.tracker.events();
  }

  /** What the task of a running child is, for naming its desktop. */
  subagentLabel(id: string): string | undefined {
    return this.tracker.label(id);
  }

  /** Stops one child. Claude Code ends that task alone; its siblings, the chat's own turn and other chats go on. */
  async cancelSubagent(id: string): Promise<void> {
    if (!this.tracker.has(id)) throw new Error('That task is not running any more.');
    if (!this.q) throw new Error("The chat's agent is not running.");
    await this.q.stopTask(id);
  }

  /**
   * What the screenshots showed no longer holds: the chat moved to another computer, or the user closed its desktop
   * (`key`: the chat's own or one subagent's; none: all of them). `closed` says the user did it and how, so that the
   * agent that was looking at that desktop is told with its next screenshot; a subagent's desktop is never kept.
   */
  resetDesktop(key?: string, closed?: 'reset' | 'deleted'): void {
    const reset = (state: ComputerState, how: 'reset' | 'deleted' | undefined) => {
      const seen = state.generation !== undefined;
      state.reset();
      if (how && seen) state.closed = how;
    };
    if (key === undefined || key === MAIN_DESKTOP) reset(this.computer, closed);
    for (const [agent, state] of this.childComputers) {
      if (key === undefined || key === agent) reset(state, closed ? 'deleted' : undefined);
    }
  }

  /**
   * Who made a tool call: the chat's main agent ('main') or one of its subagents (its task id). Claude Code names the
   * tool use with every call it makes, and its stream says for every tool use which agent it belongs to, so this is
   * read off, not guessed, and nothing in the call's arguments has a say. A call that cannot be attributed while
   * subagents are running is refused: it must not act on some agent's desktop on a guess.
   */
  private async callerOf(extra: unknown): Promise<string> {
    const id = toolUseIdOf(extra);
    const unattributed = (): string => {
      // An engine that names no tool use has no subagents either: there is only the one agent.
      if (this.tracker.size === 0) return MAIN_DESKTOP;
      throw new Error('This call could not be matched to the agent that made it while subagents are running, so it was not run. Try it again.');
    };
    if (id === undefined) return unattributed();
    // The stream is read in order, but a call may be handled a moment before the message that announces it.
    const owner = await waitFor(() => this.toolOwners.get(id), ATTRIBUTION_WAIT_MS);
    if (owner === undefined) return unattributed();
    if (owner === null) return MAIN_DESKTOP;
    const task = await waitFor(() => this.tracker.taskOfToolUse(owner) ?? (this.tracker.knowsToolUse(owner) ? null : undefined), ATTRIBUTION_WAIT_MS);
    if (typeof task === 'string') return task;
    throw new Error(task === null ? 'The subagent that made this call has already ended, so it was not run.' : 'This call came from a subagent that is not known yet, so it was not run. Try it again.');
  }

  /**
   * The computer and the screenshot bookkeeping a call works with. Where chats have desktops of their own, a
   * subagent gets its own too, the first time it needs one: two agents never share a focus, a pointer or a browser.
   * A computer with the one real screen has nothing to hand out, so there every agent's steps queue for it.
   */
  private async computerTarget(extra: unknown): Promise<ComputerTarget> {
    const caller = await this.callerOf(extra);
    const pc = this.host.pcFor(this.id);
    if (caller === MAIN_DESKTOP || !pc.desktop) return { pc, state: this.computer };
    let state = this.childComputers.get(caller);
    if (!state) this.childComputers.set(caller, (state = new ComputerState()));
    this.tracker.setDesktop(caller, true);
    return { pc: this.host.pcFor(this.id, caller), state };
  }

  /** The id of the tool use a handler was called for: the exact one when Claude Code names it, else the oldest waiting. */
  private takeToolUseId(name: string, extra: unknown): string | undefined {
    const exact = toolUseIdOf(extra);
    const queue = this.pendingToolUseIds.get(name);
    if (exact === undefined) return queue?.shift();
    const at = queue?.indexOf(exact) ?? -1;
    if (at >= 0) queue!.splice(at, 1);
    return exact;
  }

  /** Ends with the reply in progress when the user stops it; a new one is made for the next reply. */
  private turnSignal(): AbortSignal {
    return (this.turnAbort ??= new AbortController()).signal;
  }

  /**
   * What ends a call on the executor: the chat's process going away, Claude Code cancelling that very call (as it
   * does for a subagent that is stopped), and, for the main agent's own calls, the user stopping the reply.
   */
  private callSignal(base: AbortSignal | undefined, caller: string, extra: unknown): AbortSignal | undefined {
    const signals = [base ?? this.abort?.signal, caller === MAIN_DESKTOP ? this.turnSignal() : undefined, signalOf(extra)].filter((s): s is AbortSignal => s instanceof AbortSignal);
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.host.onClaudeVersion(msg.claude_code_version);
        else if (msg.subtype === 'compact_boundary') {
          const before = msg.compact_metadata?.pre_tokens;
          const text = `Контекст сжат${before ? ` (было ${Math.round(before / 1000)}k токенов)` : ''}: Claude помнит главное из разговора.`;
          this.record({ kind: 'text', text }, true);
          this.setMeta({ lastText: text });
        } else this.tracker.task(msg);
        return;
      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        this.markWorking();
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.streamedText = true;
          this.textBuffer += ev.delta.text;
          this.record({ kind: 'text_delta', text: ev.delta.text }, false);
        }
        return;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) {
          // A subagent's turn: its tool calls and what it says belong on its own card, not in the chat as the main agent's.
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              this.trackToolUse(block.id, block.name, block.input, msg.parent_tool_use_id);
              this.tracker.childToolUse(msg.parent_tool_use_id, block.id, block.name, block.input);
            } else if (block.type === 'text') this.tracker.childText(msg.parent_tool_use_id, block.text);
          }
          return;
        }
        this.markWorking();
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            if (!this.streamedText) this.record({ kind: 'text_delta', text: block.text }, false);
            this.record({ kind: 'text', text: block.text }, true);
            this.setMeta({ lastText: block.text.slice(0, 200) });
            this.streamedText = false;
            this.textBuffer = '';
          } else if (block.type === 'tool_use') {
            const shown = this.trackToolUse(block.id, block.name, block.input);
            this.record({ kind: 'tool_use', id: block.id, name: shown.name, input: shown.input }, true);
          }
        }
        return;
      }
      case 'user': {
        const content = msg.message.content;
        if (typeof content === 'string') return;
        if (msg.parent_tool_use_id) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            this.running.delete(block.tool_use_id);
            this.tracker.childToolResult(msg.parent_tool_use_id, block.tool_use_id, block.is_error ?? false);
          }
          return;
        }
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.running.delete(block.tool_use_id);
          const text =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
          this.record({ kind: 'tool_result', id: block.tool_use_id, content: text, isError: block.is_error ?? false }, true);
          // For a child the parent waited for, this is its report; the tracker ignores every other tool's result.
          this.tracker.agentResult(block.tool_use_id, text, block.is_error ?? false);
        }
        return;
      }
      case 'result': {
        if (msg.subtype !== 'success') this.record({ kind: 'error', message: `Claude stopped: ${msg.subtype}` }, true);
        this.record(
          {
            kind: 'result',
            durationMs: msg.duration_ms,
            costUsd: msg.total_cost_usd,
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
          },
          true,
        );
        this.running.clear();
        this.turnStartedAt = undefined;
        // The reply is over; children it sent to the background keep running and keep their cards open.
        this.tracker.replyEnded(this.turnStopped || msg.subtype !== 'success');
        this.turnStopped = false;
        this.turnAbort = null;
        this.setState('idle');
        this.refreshContext();
        if (this.restartAfterTurn && !this.busy) {
          this.restartAfterTurn = false;
          this.stop();
          return;
        }
        this.applyPendingConfig();
        this.touch();
        return;
      }
      default:
        return;
    }
  }
}

function skillDirectories(): string[] {
  const dirs = [join(paths.skillsPlugin, 'skills'), paths.userSkills];
  try {
    dirs.push(realpathSync(paths.userSkills));
  } catch {}
  return dirs;
}

function scratchPrefixes(dir: string): string[] {
  const out = [dir];
  try {
    out.push(realpathSync(dir));
  } catch {}
  return out;
}

/** Claude sometimes reaches for its local working directory; on the executor that means the workspace root. */
function unscratchPaths(input: Record<string, unknown>, prefixes: readonly string[]): Record<string, unknown> {
  let out = input;
  for (const key of ['file_path', 'path']) {
    const v = input[key];
    if (typeof v !== 'string') continue;
    const prefix = prefixes.find((p) => v === p || v.startsWith(`${p}/`));
    if (prefix) out = { ...out, [key]: v.slice(prefix.length + 1) || '.' };
  }
  return out;
}

function readInstructions(dir: string): string | null {
  try {
    return readFileSync(join(dir, 'CLAUDE.md'), 'utf8').slice(0, 40_000);
  } catch {
    return null;
  }
}

/** process.env without the unset entries (and without `drop`), as Claude Code's env option wants plain strings. */
function stringEnv(env: NodeJS.ProcessEnv, drop: string[] = []): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && !drop.includes(e[0])));
}
