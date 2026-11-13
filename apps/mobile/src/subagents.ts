import { subagentEnded, type ChatItem, type SubagentItem } from '@pocket/client-core';
import type { SubagentStatus, SubagentStep } from '@pocket/protocol';
import { bareToolName, type IconName } from './format';
import { colors } from './theme';

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The first line that says something, without a markdown heading marker. */
function firstLine(text: string | undefined): string | undefined {
  const line = text?.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line?.replace(/^#{1,6}\s+/, '');
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Still working: it can be stopped, and its desktop can be watched. */
export const subagentLive = (status: SubagentStatus): boolean => !subagentEnded(status);

export function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Working';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Stopped';
  }
}

export function subagentStatusColor(status: SubagentStatus): string {
  switch (status) {
    case 'starting':
    case 'running':
      return colors.accent;
    case 'completed':
      return colors.ok;
    case 'failed':
      return colors.danger;
    case 'cancelled':
      return colors.textMuted;
  }
}

/** The glyph of a card that ended; a live one shows a spinner instead, so it has none. */
export function subagentEndedIcon(status: SubagentStatus): IconName | undefined {
  switch (status) {
    case 'completed':
      return 'checkmark-circle';
    case 'failed':
      return 'close-circle';
    case 'cancelled':
      return 'stop-circle';
    default:
      return undefined;
  }
}

/** The role it was started with ("Explore"); older runs and plain tasks have none. */
export function subagentTitle(item: Pick<SubagentItem, 'name'>): string {
  return item.name?.trim() || 'Subagent';
}

/** What it was asked to do, as one line. */
export function subagentTaskLine(item: Pick<SubagentItem, 'task'>): string {
  return oneLine(item.task);
}

/** The single line shown on a collapsed card; only a live card ever reports what it is doing now. */
export function subagentHeadline(item: Pick<SubagentItem, 'status' | 'activity' | 'result' | 'error'>): string {
  switch (item.status) {
    case 'starting':
      return firstLine(item.activity) ?? 'Starting…';
    case 'running':
      return firstLine(item.activity) ?? 'Working…';
    case 'completed':
      return firstLine(item.result) ?? 'Done';
    case 'failed':
      return firstLine(item.error) ?? 'Failed';
    case 'cancelled':
      return 'Stopped';
  }
}

/** "42s", "3m 05s", "1h 05m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** How long it ran: up to `now` while live, up to `endedAt` once it ended (unknown when that was not reported). */
export function subagentDuration(item: Pick<SubagentItem, 'status' | 'startedAt' | 'endedAt'>, now: number): string | undefined {
  const end = subagentEnded(item.status) ? item.endedAt : now;
  return end === undefined ? undefined : formatElapsed(end - item.startedAt);
}

/** "Done · 3m 05s · 12 tool calls": the facts an expanded card opens with. */
export function subagentStats(item: Pick<SubagentItem, 'status' | 'startedAt' | 'endedAt' | 'toolUses'>, now: number): string {
  return [
    subagentStatusLabel(item.status),
    subagentDuration(item, now),
    item.toolUses ? plural(item.toolUses, 'tool call') : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Says when the activity list is only the latest part of what the child did. */
export function activityCaption(item: Pick<SubagentItem, 'steps' | 'toolUses'>): string | undefined {
  const shown = item.steps?.length ?? 0;
  return item.toolUses !== undefined && item.toolUses > shown && shown > 0 ? `latest ${shown} of ${item.toolUses}` : undefined;
}

export const stepName = (step: Pick<SubagentStep, 'tool'>): string => bareToolName(step.tool);

export function stepSummary(step: Pick<SubagentStep, 'summary'>): string | undefined {
  const summary = step.summary === undefined ? '' : oneLine(step.summary);
  return summary || undefined;
}

/** One tool call as a line: "Read src/app.ts", or just the tool's name when it has nothing to add. */
export function stepLine(step: Pick<SubagentStep, 'tool' | 'summary'>): string {
  const summary = stepSummary(step);
  return summary ? `${stepName(step)} ${summary}` : stepName(step);
}

export type StepGlyph = 'spinner' | 'done' | 'error' | 'idle';

/** What a step shows: one still "running" on a card that ended is not, so it never spins. */
export function stepGlyph(status: SubagentStep['status'], live: boolean): StepGlyph {
  if (status === 'error') return 'error';
  if (status === 'done') return 'done';
  return live ? 'spinner' : 'idle';
}

export function stepGlyphColor(glyph: StepGlyph): string {
  switch (glyph) {
    case 'spinner':
      return colors.accent;
    case 'done':
      return colors.ok;
    case 'error':
      return colors.danger;
    case 'idle':
      return colors.textMuted;
  }
}

/** Changes when a child with a desktop of its own starts or ends; the chat then asks the Mac for its desktops again. */
export function desktopAgentsKey(items: readonly ChatItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === 'subagent' && item.desktop === true) parts.push(`${item.id}:${subagentEnded(item.status) ? 'ended' : 'live'}`);
  }
  return parts.join(',');
}
