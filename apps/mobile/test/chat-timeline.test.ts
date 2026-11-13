import type { ChatItem } from '@pocket/client-core';
import { describe, expect, it } from 'vitest';
import { buildTimeline, formatMessageTime } from '../src/chat-timeline';


function user(key: string, at?: number): ChatItem {
  return { type: 'user', key, text: key, from: 'phone', ...(at === undefined ? {} : { at }) };
}

describe('buildTimeline', () => {
  it('adds one separator for adjacent messages on the same local day', () => {
    const items = [
      user('first', new Date(2025, 4, 3, 9, 0).getTime()),
      user('second', new Date(2025, 4, 3, 9, 8).getTime()),
    ];

    const rows = buildTimeline(items, new Date(2025, 4, 3, 12));

    expect(rows.map((row) => row.type)).toEqual(['date', 'message', 'message']);
    expect(rows[0]).toMatchObject({ type: 'date', key: 'date:2025-05-03', label: 'Today' });
    expect(rows.filter((row) => row.type === 'message').map((row) => row.key)).toEqual(['first', 'second']);
  });

  it('uses local midnight and calendar year for separators and today/yesterday labels', () => {
    const beforeMidnight = user('before', new Date(2024, 11, 31, 23, 59).getTime());
    const afterMidnight = user('after', new Date(2025, 0, 1, 0, 1).getTime());

    const rows = buildTimeline([beforeMidnight, afterMidnight], new Date(2025, 0, 1, 12));
    const dates = rows.filter((row) => row.type === 'date');

    expect(dates).toEqual([
      { type: 'date', key: 'date:2024-12-31', label: 'Yesterday' },
      { type: 'date', key: 'date:2025-01-01', label: 'Today' },
    ]);
  });

  it('omits separators for absent or invalid timestamps instead of creating an epoch date', () => {
    const items = [
      user('missing'),
      user('zero', 0),
      user('invalid', Number.NaN),
      user('today', new Date(2025, 5, 2, 8).getTime()),
    ];

    const rows = buildTimeline(items, new Date(2025, 5, 2, 12));

    expect(rows.filter((row) => row.type === 'date')).toEqual([
      { type: 'date', key: 'date:2025-06-02', label: 'Today' },
    ]);
    expect(rows.filter((row) => row.type === 'message').map((row) => row.key)).toEqual([
      'missing',
      'zero',
      'invalid',
      'today',
    ]);
    expect(formatMessageTime()).toBe('');
    expect(formatMessageTime(0)).toBe('');
    expect(formatMessageTime(Number.NaN)).toBe('');
  });

  it('keeps message identity, order, and stable row keys', () => {
    const items = [
      user('older', new Date(2025, 2, 1, 18).getTime()),
      user('newer', new Date(2025, 2, 2, 8).getTime()),
    ];
    const now = new Date(2025, 2, 2, 12);

    const first = buildTimeline(items, now);
    const second = buildTimeline(items, now);
    const messages = first.filter((row) => row.type === 'message');

    expect(messages.map((row) => row.item)).toEqual(items);
    expect(messages[0]?.item).toBe(items[0]);
    expect(first.map((row) => row.key)).toEqual(second.map((row) => row.key));
    expect(messages.map((row) => row.key)).toEqual(['older', 'newer']);
    expect(first.map((row) => row.type)).toEqual(['date', 'message', 'date', 'message']);
  });
});

describe('formatMessageTime', () => {
  it('formats a valid timestamp using local time', () => {
    const date = new Date(2025, 0, 1, 9, 7);

    expect(formatMessageTime(date.getTime())).toBe(
      date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    );
  });
});
