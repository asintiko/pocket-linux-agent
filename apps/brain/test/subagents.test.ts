import { describe, expect, it, vi } from 'vitest';
import type { SubagentEvent } from '@pocket/protocol';
import { SubagentTracker, summarizeInput } from '../src/subagents.js';

function setup(opts: { progressMs?: number } = {}) {
  let now = 1_000;
  const events: { event: SubagentEvent; durable: boolean }[] = [];
  const ended: string[] = [];
  const tracker = new SubagentTracker({
    emit: (event, durable) => events.push({ event, durable }),
    ended: (id) => ended.push(id),
    describe: (name, input) => {
      const summary = summarizeInput(input);
      return { tool: name.replace('mcp__pocket__', ''), ...(summary ? { summary } : {}) };
    },
    now: () => now,
    progressMs: opts.progressMs ?? 0,
  });
  /** A task message as Claude Code's stream carries it. */
  const sys = (msg: Record<string, unknown>) => tracker.task({ type: 'system', ...msg } as never);
  const start = (id: string, toolUseId: string, extra: Record<string, unknown> = {}) =>
    sys({ subtype: 'task_started', task_id: id, tool_use_id: toolUseId, description: `Task ${id}`, subagent_type: 'general-purpose', ...extra });
  const last = (id: string) => [...events].reverse().find((e) => e.event.id === id)!;
  return { tracker, events, ended, sys, start, last, tick: (ms: number) => (now += ms) };
}

describe('SubagentTracker', () => {
  it('follows a child from its start to its report', () => {
    const { tracker, events, ended, start, last, tick } = setup();
    start('t1', 'toolu_1', { prompt: 'Look at the page and say what is on it.' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      durable: true,
      event: { kind: 'subagent', id: 't1', status: 'starting', name: 'general-purpose', task: 'Task t1\nLook at the page and say what is on it.', toolUseId: 'toolu_1', startedAt: 1000, at: 1000 },
    });

    tick(50);
    tracker.childToolUse('toolu_1', 'c1', 'mcp__pocket__Bash', { command: 'ls -la' });
    // The first sign of life is kept in the history: the card says "running" from here on.
    expect(last('t1')).toMatchObject({ durable: true, event: { status: 'running', toolUses: 1, activity: 'Bash ls -la', steps: [{ id: 'c1', tool: 'Bash', summary: 'ls -la', status: 'running' }] } });

    tracker.childToolResult('toolu_1', 'c1', false);
    expect(last('t1')).toMatchObject({ durable: false, event: { status: 'running', steps: [{ id: 'c1', status: 'done' }] } });
    tracker.childText('toolu_1', 'Three files, nothing odd.');
    expect(last('t1').event.activity).toBe('Three files, nothing odd.');

    tick(50);
    tracker.agentResult('toolu_1', 'Report: three files, nothing odd.', false);
    const final = last('t1');
    expect(final.durable).toBe(true);
    expect(final.event).toMatchObject({ status: 'completed', result: 'Report: three files, nothing odd.', endedAt: 1100, steps: [{ id: 'c1', status: 'done' }] });
    expect(final.event.activity).toBeUndefined();
    expect(ended).toEqual(['t1']);
    expect(tracker.size).toBe(0);
    expect(tracker.events()).toEqual([]);
  });

  it('keeps the tool calls of children that run at the same time apart', () => {
    const { tracker, start, last } = setup();
    start('t1', 'toolu_1');
    start('t2', 'toolu_2');
    tracker.childToolUse('toolu_2', 'c9', 'Read', { file_path: '/srv/app/index.html' });
    tracker.childToolUse('toolu_1', 'c3', 'mcp__pocket__computer', { action: 'screenshot' });
    expect(last('t2').event.steps).toEqual([expect.objectContaining({ id: 'c9', tool: 'Read', summary: '/srv/app/index.html' })]);
    expect(last('t1').event.steps).toEqual([expect.objectContaining({ id: 'c3', tool: 'computer' })]);
    expect(tracker.taskOfToolUse('toolu_1')).toBe('t1');
    expect(tracker.taskOfToolUse('toolu_2')).toBe('t2');
    // A tool use that started no child belongs to nobody here.
    expect(tracker.taskOfToolUse('toolu_x')).toBeUndefined();
    tracker.childToolUse('toolu_x', 'c7', 'Read', {});
    expect(tracker.subagents().map((a) => [a.id, a.toolUses])).toEqual([['t1', 1], ['t2', 1]]);
  });

  it('shows a failure with its error and no report', () => {
    const { tracker, sys, start, last, ended } = setup();
    start('t1', 'toolu_1');
    tracker.childText('toolu_1', 'Trying the build…');
    sys({ subtype: 'task_notification', task_id: 't1', status: 'failed', summary: 'The build exited with code 2' });
    expect(last('t1').event).toMatchObject({ status: 'failed', error: 'The build exited with code 2' });
    expect(last('t1').event.result).toBeUndefined();
    expect(ended).toEqual(['t1']);
  });

  it('stops one child and leaves its sibling working', () => {
    const { tracker, sys, start, last, ended } = setup();
    start('t1', 'toolu_1');
    start('t2', 'toolu_2');
    tracker.childToolUse('toolu_1', 'c1', 'Bash', { command: 'sleep 600' });
    sys({ subtype: 'task_notification', task_id: 't1', status: 'stopped', summary: 'Agent stopped' });
    expect(last('t1').event).toMatchObject({ status: 'cancelled', steps: [{ id: 'c1', status: 'error' }] });
    expect(tracker.has('t1')).toBe(false);
    expect(tracker.has('t2')).toBe(true);
    expect(ended).toEqual(['t1']);
    tracker.childToolUse('toolu_2', 'c2', 'Read', { file_path: 'a.txt' });
    expect(last('t2').event.status).toBe('running');
    // Words from the stopped child that were still on their way change nothing.
    const before = last('t1');
    tracker.childText('toolu_1', 'still here');
    expect(last('t1')).toBe(before);
  });

  it('lets a background child outlive the reply that started it, but not one the reply waited for', () => {
    const { tracker, sys, start, last } = setup();
    start('t1', 'toolu_1');
    start('t2', 'toolu_2', { is_backgrounded: true });
    // For a background child the parent's tool result is only the note that it was started.
    tracker.agentResult('toolu_2', 'Async agent launched.', false);
    expect(tracker.has('t2')).toBe(true);

    tracker.replyEnded(false);
    expect(last('t1').event.status).toBe('completed');
    expect(tracker.has('t2')).toBe(true);
    expect(last('t2').event.status).toBe('starting');

    tracker.childText('toolu_2', 'All four pages load.');
    sys({ subtype: 'task_notification', task_id: 't2', status: 'completed', summary: 'Agent "Task t2" completed' });
    expect(last('t2').event).toMatchObject({ status: 'completed', result: 'All four pages load.', background: true });
  });

  it('ends children the reply waited for as stopped when the user stopped the reply', () => {
    const { tracker, start, last } = setup();
    start('t1', 'toolu_1');
    tracker.replyEnded(true);
    expect(last('t1').event.status).toBe('cancelled');
  });

  it('learns from the list of background tasks which children are in the background and which are gone', () => {
    vi.useFakeTimers();
    try {
      const { tracker, sys, start, last } = setup();
      start('t1', 'toolu_1');
      sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] });
      expect(last('t1').event.background).toBe(true);
      tracker.replyEnded(false);
      expect(tracker.has('t1')).toBe(true);
      // Gone from the list without a notification: the card is closed after a moment, not left running for ever.
      sys({ subtype: 'background_tasks_changed', tasks: [] });
      expect(tracker.has('t1')).toBe(true);
      vi.advanceTimersByTime(3100);
      expect(tracker.has('t1')).toBe(false);
      expect(last('t1').event.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not take background shell commands for subagents', () => {
    const { tracker, sys, events } = setup();
    sys({ subtype: 'task_started', task_id: 'b1', description: 'npm run dev', task_type: 'local_bash' });
    sys({ subtype: 'task_started', task_id: 'w1', description: 'watcher', subagent_type: 'general-purpose', ambient: true });
    expect(tracker.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('closes every card when the process the children run in is gone', () => {
    const { tracker, start, last, ended } = setup();
    start('t1', 'toolu_1');
    start('t2', 'toolu_2', { is_backgrounded: true });
    tracker.stopAll('Stopped: the chat ended.');
    expect(last('t1').event).toMatchObject({ status: 'cancelled', error: 'Stopped: the chat ended.' });
    expect(last('t2').event).toMatchObject({ status: 'cancelled', error: 'Stopped: the chat ended.' });
    expect(ended.sort()).toEqual(['t1', 't2']);
  });

  it('adds the report that arrives after the task was already reported done', () => {
    const { tracker, sys, start, last } = setup();
    start('t1', 'toolu_1');
    sys({ subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done' });
    expect(last('t1').event).toMatchObject({ status: 'completed' });
    expect(last('t1').event.result).toBeUndefined();
    tracker.agentResult('toolu_1', 'The page has a form with two fields.', false);
    expect(last('t1')).toMatchObject({ durable: true, event: { status: 'completed', result: 'The page has a form with two fields.' } });
  });

  it('sends status changes at once and holds the running commentary back', () => {
    vi.useFakeTimers();
    try {
      const { tracker, events, start, tick } = setup({ progressMs: 400 });
      start('t1', 'toolu_1');
      tracker.childText('toolu_1', 'one');
      const afterFirst = events.length;
      // "starting" and the first sign of life went out at once, both kept.
      expect(events.map((e) => [e.event.status, e.durable])).toEqual([['starting', true], ['running', true]]);
      for (const word of ['two', 'three', 'four']) {
        tick(50);
        tracker.childText('toolu_1', word);
      }
      expect(events.length).toBe(afterFirst);
      tick(400);
      vi.advanceTimersByTime(400);
      expect(events.length).toBe(afterFirst + 1);
      expect(events[afterFirst]).toMatchObject({ durable: false, event: { activity: 'four' } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('summarizeInput', () => {
  it('says in a line what a tool call is about', () => {
    expect(summarizeInput({ command: 'npm   test\n--watch' })).toBe('npm test --watch');
    expect(summarizeInput({ file_path: '/a/b.ts', limit: 20 })).toBe('/a/b.ts');
    expect(summarizeInput({ limit: 20 })).toBeUndefined();
    expect(summarizeInput(undefined)).toBeUndefined();
  });
});
