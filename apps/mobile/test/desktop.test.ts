import type { WorkspaceStatus } from '@pocket/client-core';
import type { Desktop } from '@pocket/protocol';
import { describe, expect, it } from 'vitest';
import { colors } from '../src/theme';
import { desktopBar, desktopDetail, desktopNote, desktopStateColor, desktopStateLabel, listDesktops, MAIN_DESKTOP, pickDesktop, previewAge } from '../src/desktop';

const main = (over: Partial<Desktop> = {}): Desktop => ({ key: 'main', label: 'This chat', state: 'running', ...over });
const child = (key: string, over: Partial<Desktop> = {}): Desktop => ({ key, label: `Agent ${key}`, state: 'running', ...over });

function status(over: Partial<WorkspaceStatus> = {}): WorkspaceStatus {
  return { requestId: 'r1', sessionId: 's1', supported: true, desktops: [main()], ...over };
}

describe('listing desktops', () => {
  it('puts the chat’s own desktop first and keeps the others in order', () => {
    expect(listDesktops([child('b'), main(), child('a')]).map((d) => d.key)).toEqual(['main', 'b', 'a']);
  });

  it('always has the chat’s own desktop, even before it was started', () => {
    expect(listDesktops([])).toEqual([{ key: MAIN_DESKTOP, label: 'This chat', state: 'none' }]);
    expect(listDesktops(undefined).map((d) => d.key)).toEqual(['main']);
    expect(listDesktops([child('a')]).map((d) => [d.key, d.state])).toEqual([['main', 'none'], ['a', 'running']]);
  });

  it('picks a desktop by key and falls back to the chat’s own', () => {
    const all = [main({ state: 'stopped' }), child('a')];
    expect(pickDesktop(all, 'a').key).toBe('a');
    expect(pickDesktop(all, 'gone')).toMatchObject({ key: 'main', state: 'stopped' });
    expect(pickDesktop(undefined, 'a')).toMatchObject({ key: 'main', state: 'none' });
  });
});

describe('desktop words', () => {
  it('names every state', () => {
    expect(desktopStateLabel('none')).toBe('None yet');
    expect(desktopStateLabel('starting')).toBe('Starting');
    expect(desktopStateLabel('running')).toBe('Running');
    expect(desktopStateLabel('stopped')).toBe('Closed');
    expect(desktopStateLabel('failed')).toBe('Failed');
  });

  it('colours running green, failed red, starting with the accent, the rest muted', () => {
    expect(desktopStateColor('running')).toBe(colors.ok);
    expect(desktopStateColor('failed')).toBe(colors.danger);
    expect(desktopStateColor('starting')).toBe(colors.accent);
    expect(desktopStateColor('none')).toBe(colors.textMuted);
    expect(desktopStateColor('stopped')).toBe(colors.textMuted);
  });

  it('writes display and start count together, and nothing before the first start', () => {
    expect(desktopDetail({ display: ':101', generation: 3 })).toBe(':101 · start #3');
    expect(desktopDetail({ display: ':101', generation: 0 })).toBe(':101');
    expect(desktopDetail({ generation: 2 })).toBe('start #2');
    expect(desktopDetail({})).toBe('');
  });

  it('explains why there is no picture, and says nothing for a running desktop', () => {
    expect(desktopNote({ key: 'main', state: 'none' })).toBe('This chat has no desktop running. One starts when the agent first needs it.');
    expect(desktopNote({ key: 'main', state: 'running' })).toBe('');
    expect(desktopNote({ key: 'main', state: 'starting' })).toMatch(/starting/);
    expect(desktopNote({ key: 'main', state: 'stopped' })).toMatch(/closed/);
    expect(desktopNote({ key: 'main', state: 'failed' })).toMatch(/Close it to start over/);
    expect(desktopNote({ key: 'task-1', state: 'none' })).toMatch(/subagent/);
    expect(desktopNote({ key: 'task-1', state: 'stopped' })).toBe('This desktop is closed.');
  });

  it('says how old a picture is', () => {
    expect(previewAge(10_000, 10_000)).toBe('just now');
    expect(previewAge(10_000, 11_999)).toBe('just now');
    expect(previewAge(10_000, 13_000)).toBe('3s ago');
    expect(previewAge(10_000, 70_000)).toBe('1m ago');
    expect(previewAge(10_000, 10_000 + 2 * 3_600_000)).toBe('2h ago');
    expect(previewAge(10_000, 5_000)).toBe('just now');
  });
});

describe('desktopBar', () => {
  const computer = { deviceId: 'd1', name: 'Linux box', online: true };

  it('shows the chat’s own desktop in words next to the computer', () => {
    expect(desktopBar(status({ computer }))).toEqual({ name: 'Linux box', label: 'Desktop running', color: colors.ok, more: 0 });
    expect(desktopBar(status({ computer, desktops: [main({ state: 'none' })] })).label).toBe('Desktop not started');
    expect(desktopBar(status({ computer, desktops: [main({ state: 'starting' })] })).label).toBe('Desktop starting');
    expect(desktopBar(status({ computer, desktops: [main({ state: 'stopped' })] })).label).toBe('Desktop closed');
    expect(desktopBar(status({ computer, desktops: [main({ state: 'failed' })] })).label).toBe('Desktop failed');
  });

  it('counts the subagents’ desktops, not the chat’s own', () => {
    expect(desktopBar(status({ computer, desktops: [main(), child('a'), child('b', { state: 'stopped' })] })).more).toBe(2);
    expect(desktopBar(status({ computer, desktops: [child('a')] }))).toMatchObject({ label: 'Desktop not started', more: 1 });
  });

  it('says the computer is offline rather than a state that may no longer hold', () => {
    expect(desktopBar(status({ computer: { ...computer, online: false } }))).toMatchObject({ label: 'Computer offline', color: colors.textMuted });
  });

  it('copes with a report that names no computer', () => {
    expect(desktopBar(status({ desktops: [] }))).toEqual({ name: undefined, label: 'Desktop not started', color: colors.textMuted, more: 0 });
  });
});
