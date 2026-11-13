import type { ChatItem, SubagentItem } from '@pocket/client-core';
import type { SubagentStatus } from '@pocket/protocol';
import { describe, expect, it } from 'vitest';
import { colors } from '../src/theme';
import {
  activityCaption,
  desktopAgentsKey,
  formatElapsed,
  stepGlyph,
  stepLine,
  stepName,
  stepSummary,
  subagentDuration,
  subagentEndedIcon,
  subagentHeadline,
  subagentLive,
  subagentStats,
  subagentStatusColor,
  subagentStatusLabel,
  subagentTaskLine,
  subagentTitle,
} from '../src/subagents';

const LIVE: SubagentStatus[] = ['starting', 'running'];
const ENDED: SubagentStatus[] = ['completed', 'failed', 'cancelled'];

function card(over: Partial<SubagentItem> = {}): SubagentItem {
  return { type: 'subagent', key: 'i1', id: 'task-1', status: 'running', task: 'Check the page', startedAt: 1_000, ...over };
}

describe('subagent status', () => {
  it('names every status the way the card says it', () => {
    expect(subagentStatusLabel('starting')).toBe('Starting');
    expect(subagentStatusLabel('running')).toBe('Working');
    expect(subagentStatusLabel('completed')).toBe('Done');
    expect(subagentStatusLabel('failed')).toBe('Failed');
    expect(subagentStatusLabel('cancelled')).toBe('Stopped');
  });

  it('colours live cards with the accent and each ending with its own colour', () => {
    expect(subagentStatusColor('starting')).toBe(colors.accent);
    expect(subagentStatusColor('running')).toBe(colors.accent);
    expect(subagentStatusColor('completed')).toBe(colors.ok);
    expect(subagentStatusColor('failed')).toBe(colors.danger);
    expect(subagentStatusColor('cancelled')).toBe(colors.textMuted);
  });

  it('is live until the child ended, however it ended', () => {
    expect(LIVE.map(subagentLive)).toEqual([true, true]);
    expect(ENDED.map(subagentLive)).toEqual([false, false, false]);
  });

  it('gives an ended card a glyph and a live one none, so a live card shows its spinner instead', () => {
    expect(LIVE.map(subagentEndedIcon)).toEqual([undefined, undefined]);
    expect(subagentEndedIcon('completed')).toBe('checkmark-circle');
    expect(subagentEndedIcon('failed')).toBe('close-circle');
    expect(subagentEndedIcon('cancelled')).toBe('stop-circle');
  });
});

describe('subagent title and task', () => {
  it('uses the role, or "Subagent" without one', () => {
    expect(subagentTitle({ name: 'Explore' })).toBe('Explore');
    expect(subagentTitle({ name: '  general-purpose ' })).toBe('general-purpose');
    expect(subagentTitle({})).toBe('Subagent');
    expect(subagentTitle({ name: '   ' })).toBe('Subagent');
  });

  it('shows the task as one line', () => {
    expect(subagentTaskLine({ task: '  Check the\n\n  login   page\n' })).toBe('Check the login page');
    expect(subagentTaskLine({ task: '' })).toBe('');
  });
});

describe('subagentHeadline', () => {
  it('shows what a live child is doing, else that it is on its way', () => {
    expect(subagentHeadline(card({ status: 'running', activity: 'Reading src/app.ts' }))).toBe('Reading src/app.ts');
    expect(subagentHeadline(card({ status: 'starting', activity: 'Setting up' }))).toBe('Setting up');
    expect(subagentHeadline(card({ status: 'starting' }))).toBe('Starting…');
    expect(subagentHeadline(card({ status: 'running' }))).toBe('Working…');
    expect(subagentHeadline(card({ status: 'running', activity: '   ' }))).toBe('Working…');
    expect(subagentHeadline(card({ status: 'running', activity: 'Searching\nthe repo' }))).toBe('Searching');
  });

  it('shows the first line of the report once done', () => {
    expect(subagentHeadline(card({ status: 'completed', result: 'Found 3 broken links.\nSee below.' }))).toBe('Found 3 broken links.');
    expect(subagentHeadline(card({ status: 'completed', result: '\n\n  The page loads.\nMore' }))).toBe('The page loads.');
    expect(subagentHeadline(card({ status: 'completed', result: '## Findings\nAll good' }))).toBe('Findings');
    expect(subagentHeadline(card({ status: 'completed' }))).toBe('Done');
    expect(subagentHeadline(card({ status: 'completed', result: '' }))).toBe('Done');
  });

  it('shows the error of a failed child', () => {
    expect(subagentHeadline(card({ status: 'failed', error: 'Could not start the browser' }))).toBe('Could not start the browser');
    expect(subagentHeadline(card({ status: 'failed', error: 'Exit 1\nstack trace' }))).toBe('Exit 1');
    expect(subagentHeadline(card({ status: 'failed' }))).toBe('Failed');
  });

  it('says a stopped child stopped, whatever else the card holds', () => {
    expect(subagentHeadline(card({ status: 'cancelled' }))).toBe('Stopped');
    expect(subagentHeadline(card({ status: 'cancelled', activity: 'Reading', result: 'partial', error: 'x' }))).toBe('Stopped');
  });

  it('never reports a finished child as working or starting', () => {
    for (const status of ENDED) {
      const stale = card({ status, activity: 'Working on the page' });
      expect(subagentHeadline(stale)).not.toMatch(/working|starting/i);
      expect(subagentStatusLabel(status)).not.toMatch(/working|starting/i);
      expect(subagentStats({ ...stale, endedAt: 5_000 }, 9_000)).not.toMatch(/working|starting/i);
    }
  });
});

describe('subagent time', () => {
  it('formats short and long runs', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(3_900_000)).toBe('1h 05m');
    expect(formatElapsed(-5_000)).toBe('0s');
  });

  it('counts up to now while the child works', () => {
    expect(subagentDuration(card({ status: 'running', startedAt: 1_000 }), 43_000)).toBe('42s');
    expect(subagentDuration(card({ status: 'starting', startedAt: 1_000 }), 186_000)).toBe('3m 05s');
    expect(subagentDuration(card({ status: 'running', startedAt: 10_000 }), 4_000)).toBe('0s');
  });

  it('stops at the end once it ended', () => {
    expect(subagentDuration(card({ status: 'completed', startedAt: 1_000, endedAt: 186_000 }), 999_999)).toBe('3m 05s');
    expect(subagentDuration(card({ status: 'cancelled', startedAt: 1_000, endedAt: 43_000 }), 999_999)).toBe('42s');
  });

  it('does not guess how long an ended child ran when the end was not reported', () => {
    expect(subagentDuration(card({ status: 'failed', startedAt: 1_000 }), 999_999)).toBeUndefined();
  });

  it('sums up an expanded card', () => {
    expect(subagentStats(card({ status: 'completed', startedAt: 1_000, endedAt: 186_000, toolUses: 12 }), 0)).toBe('Done · 3m 05s · 12 tool calls');
    expect(subagentStats(card({ status: 'running', startedAt: 1_000, toolUses: 1 }), 43_000)).toBe('Working · 42s · 1 tool call');
    expect(subagentStats(card({ status: 'running', startedAt: 1_000, toolUses: 0 }), 43_000)).toBe('Working · 42s');
    expect(subagentStats(card({ status: 'failed', startedAt: 1_000 }), 43_000)).toBe('Failed');
  });
});

describe('subagent steps', () => {
  it('names the tool without its server prefix', () => {
    expect(stepName({ tool: 'Bash' })).toBe('Bash');
    expect(stepName({ tool: 'mcp__pocket__computer' })).toBe('computer');
  });

  it('keeps a summary on one line and drops an empty one', () => {
    expect(stepSummary({ summary: 'npm  test\n--silent' })).toBe('npm test --silent');
    expect(stepSummary({ summary: '  ' })).toBeUndefined();
    expect(stepSummary({})).toBeUndefined();
  });

  it('writes a step as one line', () => {
    expect(stepLine({ tool: 'Read', summary: 'src/app.ts' })).toBe('Read src/app.ts');
    expect(stepLine({ tool: 'mcp__pocket__computer', summary: 'click\nsave' })).toBe('computer click save');
    expect(stepLine({ tool: 'Bash' })).toBe('Bash');
  });

  it('spins only for a step that is running on a card that is live', () => {
    expect(stepGlyph('running', true)).toBe('spinner');
    expect(stepGlyph('running', false)).toBe('idle');
    expect(stepGlyph('done', true)).toBe('done');
    expect(stepGlyph('done', false)).toBe('done');
    expect(stepGlyph('error', true)).toBe('error');
    expect(stepGlyph('error', false)).toBe('error');
  });

  it('says when the list holds only the latest calls', () => {
    const steps = [
      { id: 'a', tool: 'Read', status: 'done' as const },
      { id: 'b', tool: 'Bash', status: 'running' as const },
    ];
    expect(activityCaption({ steps, toolUses: 5 })).toBe('latest 2 of 5');
    expect(activityCaption({ steps, toolUses: 2 })).toBeUndefined();
    expect(activityCaption({ steps })).toBeUndefined();
    expect(activityCaption({ toolUses: 5 })).toBeUndefined();
    expect(activityCaption({ steps: [], toolUses: 5 })).toBeUndefined();
  });
});

describe('desktopAgentsKey', () => {
  const user: ChatItem = { type: 'user', key: 'u', text: 'hi', from: 'phone' };

  it('ignores everything but children with a desktop of their own', () => {
    expect(desktopAgentsKey([])).toBe('');
    expect(desktopAgentsKey([user, card({ id: 'a' }), card({ id: 'b', desktop: false })])).toBe('');
  });

  it('changes when such a child starts or ends, and not when its card only moves on', () => {
    const starting = [user, card({ id: 'a', desktop: true, status: 'starting' })];
    const working = [user, card({ id: 'a', desktop: true, status: 'running', activity: 'Clicking' })];
    const done = [user, card({ id: 'a', desktop: true, status: 'completed' })];
    const two = [...working, card({ id: 'b', desktop: true })];
    expect(desktopAgentsKey(starting)).toBe('a:live');
    expect(desktopAgentsKey(working)).toBe(desktopAgentsKey(starting));
    expect(desktopAgentsKey(done)).toBe('a:ended');
    expect(desktopAgentsKey(two)).toBe('a:live,b:live');
  });
});
