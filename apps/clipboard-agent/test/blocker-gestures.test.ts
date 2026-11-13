import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BACKUP_NAME, parseBackup, restoreCommands, restoreGestures } from '../src/blocker/gestures.js';

const dir = mkdtempSync(join(tmpdir(), 'pocket-gestures-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('touchpad gestures while the picture is up', () => {
  it('reads the backup the window wrote, and skips anything it did not write', () => {
    expect(parseBackup('ThreeFingerSlideEnabled=1\nFourFingerSlideEnabled=-\nThreeFingerTapEnabled=0\n')).toEqual([
      { name: 'ThreeFingerSlideEnabled', value: 1 },
      { name: 'FourFingerSlideEnabled', value: null },
      { name: 'ThreeFingerTapEnabled', value: 0 },
    ]);
    expect(parseBackup('SomethingElse=1\nnoise\nThreeFingerSlideEnabled=x\n')).toEqual([]);
  });

  it('deletes a value that was absent rather than writing Windows defaults over it', () => {
    const commands = restoreCommands([
      { name: 'ThreeFingerSlideEnabled', value: 1 },
      { name: 'FourFingerTapEnabled', value: null },
    ]);
    expect(commands).toEqual([
      ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PrecisionTouchPad', '/v', 'ThreeFingerSlideEnabled', '/t', 'REG_DWORD', '/d', '1', '/f'],
      ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PrecisionTouchPad', '/v', 'FourFingerTapEnabled', '/f'],
    ]);
  });

  it('puts them back on start when a window died with the picture up, and clears the backup', () => {
    const file = join(dir, BACKUP_NAME);
    writeFileSync(file, 'ThreeFingerSlideEnabled=2\nFourFingerSlideEnabled=-\n');
    const ran: string[][] = [];
    const logs: string[] = [];
    const done = restoreGestures({ home: dir, log: (m) => logs.push(m), run: (args) => (ran.push(args), true) });
    expect(done).toBe(2);
    expect(ran.map((a) => a[0])).toEqual(['add', 'delete']);
    expect(ran[0]).toContain('2');
    expect(() => readFileSync(file)).toThrow();
    expect(logs).toEqual(['gestures: put back 2 of 2 touchpad settings left off by the lock screen']);
  });

  it('does nothing at all when there is no backup to restore', () => {
    const logs: string[] = [];
    expect(restoreGestures({ home: dir, log: (m) => logs.push(m), run: () => true })).toBe(0);
    expect(logs).toEqual([]);
  });
});
