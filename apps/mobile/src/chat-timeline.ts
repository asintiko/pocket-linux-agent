import type { ChatItem } from '@pocket/client-core';

export type TimelineEntry =
  | { type: 'message'; key: string; item: ChatItem }
  | { type: 'date'; key: string; label: string };


function timestampDate(at?: number): Date | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return String(date.getFullYear()) + '-' + month + '-' + day;
}

function localDayNumber(date: Date): number {
  const day = new Date(0);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(day.getTime() / 86_400_000);
}

function dateLabel(date: Date, now: Date): string {
  const daysAgo = localDayNumber(now) - localDayNumber(date);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';

  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(undefined, options);
}

/** Adds local-calendar separators without changing message order or keys. */
export function buildTimeline(items: readonly ChatItem[], now?: Date): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  const referenceDate = now ?? new Date();
  let previousDateKey: string | undefined;

  for (const item of items) {
    const date = timestampDate(item.at);
    if (date) {
      const dateKey = localDateKey(date);
      if (dateKey !== previousDateKey) {
        timeline.push({
          type: 'date',
          key: 'date:' + dateKey,
          label: dateLabel(date, referenceDate),
        });
        previousDateKey = dateKey;
      }
    }
    timeline.push({ type: 'message', key: item.key, item });
  }

  return timeline;
}

export function formatMessageTime(at?: number): string {
  const date = timestampDate(at);
  return date ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}
