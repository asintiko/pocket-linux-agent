import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SUBAGENT_MAX_RESULT, SUBAGENT_MAX_STEPS, type Subagent, type SubagentEvent, type SubagentStatus, type SubagentStep } from '@pocket/protocol';

/**
 * The child agents of one chat: who they are, what they are doing and how they ended, as cards in the chat.
 *
 * The children themselves are real: Claude Code runs them as tasks inside the chat's own process when the chat's
 * agent delegates with its Agent tool. This class only follows them. It turns the task life cycle and the children's
 * tool traffic (which the SDK reports with the id of the Agent tool use that started the child) into `subagent` events.
 * Every event is the whole card, so the last one a client has is the truth; starts, changes of status and endings are
 * kept in the chat's history, the running commentary in between is not.
 */

type Card = Omit<SubagentEvent, 'kind' | 'at'>;
type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

export interface SubagentTrackerHost {
  emit(event: SubagentEvent, durable: boolean): void;
  /** A child is over, however it ended: whatever it held, such as a desktop of its own, is no longer needed. */
  ended(id: string): void;
  /** A tool call as the chat shows it: the tool's display name and a one-line summary. */
  describe(name: string, input: unknown): { tool: string; summary?: string };
  now?: () => number;
  /** The running commentary of one child is sent at most this often. */
  progressMs?: number;
}

const ENDED: ReadonlySet<SubagentStatus> = new Set(['completed', 'failed', 'cancelled']);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string, max: number): string => clip(text.replace(/\s+/g, ' ').trim(), max);

const SUMMARY_KEYS = ['description', 'command', 'path', 'file_path', 'pattern', 'url', 'query', 'prompt', 'target', 'id'] as const;

/** One line on what a tool call is about: its command, path or pattern. */
export function summarizeInput(input: unknown): string | undefined {
  if (typeof input === 'string') return oneLine(input, 160) || undefined;
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, 160);
  }
  return undefined;
}

export class SubagentTracker {
  /** Children that have not ended. */
  private readonly cards = new Map<string, Card>();
  /** The Agent tool use that started each child, also for a while after it ended: a late tool result still finds it. */
  private readonly byToolUse = new Map<string, string>();
  /** Each child's latest words: when it ends they are its report. */
  private readonly lastText = new Map<string, string>();
  /** Cards that ended without a report yet; the parent's tool result may still bring one. */
  private readonly finished = new Map<string, Card>();
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; sentAt: number }>();
  private readonly sentAt = new Map<string, number>();
  private readonly vanish = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly progressMs: number;

  constructor(private readonly host: SubagentTrackerHost) {
    this.now = host.now ?? Date.now;
    this.progressMs = host.progressMs ?? 400;
  }

  get size(): number {
    return this.cards.size;
  }

  has(id: string): boolean {
    return this.cards.has(id);
  }

  /** Whether a running child was sent to the background: it does not end with the reply that started it. */
  isBackground(id: string): boolean {
    return this.cards.get(id)?.background === true;
  }

  /** The child a tool use of the parent started, while it runs: the key of everything that belongs to that child. */
  taskOfToolUse(toolUseId: string): string | undefined {
    const id = this.byToolUse.get(toolUseId);
    return id !== undefined && this.cards.has(id) ? id : undefined;
  }

  /** Whether that tool use started a child at all (running or over). */
  knowsToolUse(toolUseId: string): boolean {
    return this.byToolUse.has(toolUseId);
  }

  label(id: string): string | undefined {
    const card = this.cards.get(id);
    return card ? oneLine(card.task.split('\n')[0] ?? '', 80) : undefined;
  }

  /** The cards of the running children, as events: what a client that just connected needs to be up to date. */
  events(): SubagentEvent[] {
    const at = this.now();
    return [...this.cards.values()].map((card) => ({ kind: 'subagent', ...card, at }));
  }

  /** The running children for the activity screen. */
  subagents(): Subagent[] {
    return [...this.cards.values()].map((card) => ({
      id: card.id,
      description: oneLine(card.task.split('\n')[0] ?? '', 200),
      ...(card.name ? { type: card.name } : {}),
      ...(card.toolUseId ? { toolUseId: card.toolUseId } : {}),
      startedAt: card.startedAt,
      ...(card.steps?.length ? { lastTool: card.steps[card.steps.length - 1]!.tool } : {}),
      ...(card.toolUses !== undefined ? { toolUses: card.toolUses } : {}),
      status: card.status,
      ...(card.activity ? { activity: card.activity } : {}),
      ...(card.desktop ? { desktop: true } : {}),
    }));
  }

  /** The task life cycle as Claude Code reports it. Shell commands in the background are tasks too, but not agents. */
  task(msg: SystemMessage): void {
    switch (msg.subtype) {
      case 'task_started': {
        if (msg.skip_transcript || msg.ambient) return;
        if (!msg.subagent_type && !/agent/i.test(msg.task_type ?? 'agent')) return;
        if (this.cards.has(msg.task_id)) return;
        const description = oneLine(msg.description || msg.subagent_type || 'Subagent task', 200);
        const prompt = msg.prompt?.trim();
        const card: Card = {
          id: clip(msg.task_id, 200),
          status: 'starting',
          ...(msg.subagent_type ? { name: clip(msg.subagent_type, 80) } : {}),
          task: clip(prompt && prompt !== description ? `${description}\n${prompt}` : description, 2000),
          ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
          ...(msg.parent_task_id && this.cards.has(msg.parent_task_id) ? { parentId: msg.parent_task_id } : {}),
          ...(msg.is_backgrounded ? { background: true } : {}),
          startedAt: this.now(),
        };
        this.cards.set(card.id, card);
        if (msg.tool_use_id) this.remember(msg.tool_use_id, card.id);
        this.send(card, true);
        return;
      }
      case 'task_progress': {
        const card = this.cards.get(msg.task_id);
        if (!card) return;
        const activity = msg.summary ? oneLine(msg.summary, 300) : msg.last_tool_name ? this.host.describe(msg.last_tool_name, {}).tool : undefined;
        this.update(card, { toolUses: Math.max(card.toolUses ?? 0, msg.usage.tool_uses), ...(activity && !card.steps?.some((s) => s.status === 'running') ? { activity } : {}) });
        return;
      }
      case 'task_updated': {
        const card = this.cards.get(msg.task_id);
        if (!card) return;
        const { status, error, is_backgrounded: background } = msg.patch;
        if (background !== undefined && background !== (card.background === true)) {
          const next: Card = { ...card };
          if (background) next.background = true;
          else delete next.background;
          this.cards.set(card.id, next);
          this.send(next, true);
        }
        if (status === 'completed') this.end(msg.task_id, 'completed', {});
        else if (status === 'failed') this.end(msg.task_id, 'failed', { error: error ?? 'The task failed.' });
        else if (status === 'killed') this.end(msg.task_id, 'cancelled', {});
        else if (status === 'running') this.update(this.cards.get(msg.task_id) ?? card, {});
        return;
      }
      case 'task_notification': {
        const status: SubagentStatus = msg.status === 'completed' ? 'completed' : msg.status === 'failed' ? 'failed' : 'cancelled';
        // The summary says how it went ("Agent … completed"); the report itself is what the child last said.
        this.end(msg.task_id, status, msg.status === 'failed' ? { error: msg.summary || 'The task failed.' } : msg.status === 'stopped' && msg.reason === 'worker_restart' ? { error: 'Claude Code restarted while the task was running.' } : {});
        return;
      }
      case 'background_tasks_changed': {
        // The full set of background tasks. A background child missing from it has ended; its notification normally
        // says how, so it gets a moment to arrive before the card is closed without one.
        const live = new Set(msg.tasks.map((t) => t.task_id));
        for (const card of [...this.cards.values()]) {
          if (!card.background && live.has(card.id)) {
            // Listed here, so it runs in the background, whether or not its own events said so yet.
            const next: Card = { ...card, background: true };
            this.cards.set(card.id, next);
            this.send(next, true);
            continue;
          }
          if (!card.background || live.has(card.id) || this.vanish.has(card.id)) continue;
          const timer = setTimeout(() => {
            this.vanish.delete(card.id);
            this.end(card.id, 'completed', {});
          }, 3000);
          timer.unref?.();
          this.vanish.set(card.id, timer);
        }
        return;
      }
      default:
        return;
    }
  }

  /** A tool call made by a child; `parentToolUseId` is the Agent tool use that started the child. */
  childToolUse(parentToolUseId: string, id: string, name: string, input: unknown): void {
    const card = this.cardOf(parentToolUseId);
    if (!card) return;
    const shown = this.host.describe(name, input);
    const step: SubagentStep = { id, tool: clip(shown.tool, 80), ...(shown.summary ? { summary: clip(shown.summary, 300) } : {}), status: 'running', at: this.now() };
    const steps = [...(card.steps ?? []).filter((s) => s.id !== id), step].slice(-SUBAGENT_MAX_STEPS);
    this.update(card, { steps, toolUses: (card.toolUses ?? 0) + 1, activity: oneLine(`${step.tool}${step.summary ? ` ${step.summary}` : ''}`, 300) });
  }

  childToolResult(parentToolUseId: string, toolUseId: string, isError: boolean): void {
    const card = this.cardOf(parentToolUseId);
    if (!card?.steps?.some((s) => s.id === toolUseId)) return;
    this.update(card, { steps: card.steps.map((s) => (s.id === toolUseId ? { ...s, status: isError ? 'error' : 'done' } : s)) });
  }

  /** Something a child said (never what it thought): the latest is its report when it ends. */
  childText(parentToolUseId: string, text: string): void {
    const card = this.cardOf(parentToolUseId);
    const said = text.trim();
    if (!card || !said) return;
    this.lastText.set(card.id, said);
    this.update(card, { activity: oneLine(said, 300) });
  }

  /**
   * The parent got the result of its Agent tool use. For a child it waited for, that is the child's report and its
   * end. For one sent to the background it is only the note that it was started, and says nothing about the outcome.
   */
  agentResult(toolUseId: string, content: string, isError: boolean): void {
    const id = this.byToolUse.get(toolUseId);
    if (id === undefined) return;
    const card = this.cards.get(id);
    if (card) {
      if (card.background) return;
      this.end(id, isError ? 'failed' : 'completed', isError ? { error: clip(content.trim() || 'The task failed.', 2000) } : { result: content });
      return;
    }
    const done = this.finished.get(id);
    if (done && done.status === 'completed' && !isError && content.trim()) {
      this.finished.delete(id);
      this.send({ ...done, result: clip(content.trim(), SUBAGENT_MAX_RESULT) }, true);
    }
  }

  /** The child now drives a desktop of its own (or no longer does); its card offers to show it. */
  setDesktop(id: string, on: boolean): void {
    const card = this.cards.get(id);
    if (!card || (card.desktop === true) === on) return;
    const next: Card = { ...card };
    if (on) next.desktop = true;
    else delete next.desktop;
    this.cards.set(id, next);
    this.send(next, true);
  }

  /** The chat's process is gone, so its children are too: nothing is left showing as running. */
  stopAll(reason: string): void {
    for (const id of [...this.cards.keys()]) this.end(id, 'cancelled', { error: reason });
  }

  /**
   * The parent's reply is over. A child the reply waited for cannot outlive it, so one that is still open here ended
   * without saying so: stopped with the reply when the user stopped it, else done. Children in the background stay.
   */
  replyEnded(stopped: boolean): void {
    for (const card of [...this.cards.values()]) {
      if (!card.background) this.end(card.id, stopped ? 'cancelled' : 'completed', {});
    }
  }

  private remember(toolUseId: string, id: string): void {
    this.byToolUse.set(toolUseId, id);
    if (this.byToolUse.size > 300) this.byToolUse.delete(this.byToolUse.keys().next().value!);
  }

  private cardOf(parentToolUseId: string): Card | undefined {
    const id = this.byToolUse.get(parentToolUseId);
    return id === undefined ? undefined : this.cards.get(id);
  }

  /** A change while the child runs. The first sign of life makes it "running", which is kept; the rest is commentary. */
  private update(card: Card, patch: Partial<Card>): void {
    if (!this.cards.has(card.id)) return;
    const started = card.status === 'starting';
    const next: Card = { ...card, ...patch, status: 'running' };
    this.cards.set(card.id, next);
    if (started) this.send(next, true);
    else this.sendSoon(next.id);
  }

  private end(id: string, status: SubagentStatus, how: { result?: string; error?: string }): void {
    const card = this.cards.get(id);
    if (!card) return;
    this.cards.delete(id);
    const waiting = this.vanish.get(id);
    if (waiting) clearTimeout(waiting);
    this.vanish.delete(id);
    const report = (how.result ?? this.lastText.get(id) ?? '').trim();
    this.lastText.delete(id);
    const { activity: _activity, desktop: _desktop, ...rest } = card;
    const final: Card = {
      ...rest,
      status,
      // A step still open when the child ended did not finish.
      ...(card.steps ? { steps: card.steps.map((s) => (s.status === 'running' ? { ...s, status: status === 'completed' ? 'done' : 'error' } : s)) } : {}),
      ...(report && status !== 'failed' ? { result: clip(report, SUBAGENT_MAX_RESULT) } : {}),
      ...(how.error ? { error: clip(how.error, 2000) } : {}),
      endedAt: this.now(),
    };
    if (status === 'completed' && !final.result) {
      this.finished.set(id, final);
      if (this.finished.size > 50) this.finished.delete(this.finished.keys().next().value!);
    }
    this.send(final, true);
    this.host.ended(id);
  }

  private send(card: Card, durable: boolean): void {
    const waiting = this.pending.get(card.id);
    if (waiting) clearTimeout(waiting.timer);
    this.pending.delete(card.id);
    if (ENDED.has(card.status)) this.sentAt.delete(card.id);
    else this.sentAt.set(card.id, this.now());
    this.host.emit({ kind: 'subagent', ...card, at: this.now() }, durable);
  }

  /** Commentary is sent at once when the last one is a while ago, else once when the wait is over, with the latest state. */
  private sendSoon(id: string): void {
    if (this.pending.has(id)) return;
    const since = this.now() - (this.sentAt.get(id) ?? 0);
    const flush = () => {
      this.pending.delete(id);
      const card = this.cards.get(id);
      if (card) this.send(card, false);
    };
    if (since >= this.progressMs) return flush();
    const timer = setTimeout(flush, this.progressMs - since);
    timer.unref?.();
    this.pending.set(id, { timer, sentAt: this.now() });
  }
}
