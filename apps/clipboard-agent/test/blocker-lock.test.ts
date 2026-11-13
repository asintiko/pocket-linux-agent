import { describe, expect, it } from 'vitest';
import { DEFAULT_PIN, LockScreen, validEscape, validPin, WRONG_PIN } from '../src/blocker/lock.js';

function setup(pin = DEFAULT_PIN, ownerMode = true, locked = true) {
  const logs: string[] = [];
  const lock = new LockScreen(() => pin, (m) => logs.push(m), ownerMode, locked);
  return { lock, logs };
}

describe('LockScreen', () => {
  it('starts locked and stays locked on anything but the password', () => {
    const { lock } = setup();
    expect(lock.view()).toEqual({ locked: true, error: '', attempts: 0 });
    expect(lock.submit('1234')).toEqual({ locked: true, error: WRONG_PIN, attempts: 1 });
    expect(lock.submit('18050')).toMatchObject({ locked: true, attempts: 2 });
    expect(lock.submit('')).toMatchObject({ locked: true, attempts: 2 });
  });

  it('can start with the desktop in plain sight, so the hotkey has somewhere to go', () => {
    expect(setup(DEFAULT_PIN, true, false).lock.view()).toEqual({ locked: false, error: '', attempts: 0 });
  });

  it('lets the desktop go on the password, and locks it again on demand', () => {
    const { lock, logs } = setup();
    expect(lock.submit('1805')).toEqual({ locked: false, error: '', attempts: 0 });
    expect(logs).toContain('blocker: unlocked by password');
    expect(lock.submit('1805')).toEqual({ locked: false, error: '', attempts: 0 });
    expect(lock.lock()).toEqual({ locked: true, error: '', attempts: 0 });
    expect(lock.submit('0000')).toMatchObject({ locked: true, error: WRONG_PIN, attempts: 1 });
  });

  it('takes the password it reads now, so a new one applies without a restart', () => {
    let pin = '1805';
    const lock = new LockScreen(() => pin);
    pin = '778899';
    expect(lock.submit('1805')).toMatchObject({ locked: true });
    expect(lock.submit('778899')).toMatchObject({ locked: false });
  });

  it('keeps owner mode: no key combination lifts it, only the escape word and the CLI', () => {
    const { lock, logs } = setup();
    expect(lock.unlock('alt')).toEqual({ locked: true, error: '', attempts: 0 });
    expect(lock.unlock('ctrla')).toEqual({ locked: true, error: '', attempts: 0 });
    expect(lock.unlock('keys')).toEqual({ locked: true, error: '', attempts: 0 });
    expect(logs).toContain('blocker: alt ignored (owner mode: password, escape word or the CLI only)');
    expect(lock.submitWord('pocket')).toEqual({ locked: false, error: '', attempts: 0 });
    expect(logs).toContain('blocker: unlocked by the escape word');
  });

  it('takes the escape word typed in any case and ignores any other word without a trace', () => {
    const { lock } = setup();
    expect(lock.submitWord('POcKeT').locked).toBe(false);
    const other = setup();
    expect(other.lock.submitWord('hello')).toEqual({ locked: true, error: '', attempts: 0 });
    expect(other.lock.submitWord('')).toEqual({ locked: true, error: '', attempts: 0 });
  });

  it('keeps the escape word out of the digits, so it never shows up in the box', () => {
    const seen: string[] = [];
    const lock = new LockScreen(() => DEFAULT_PIN, (m) => seen.push(m), true, true, 'myword');
    expect(lock.submitWord('myword').locked).toBe(false);
    expect(validEscape('myword')).toBe(true);
    expect(validEscape('ab')).toBe(false);
    expect(validEscape('1805')).toBe(false);
  });

  it('lets the CLI past owner mode, because the owner is the one typing it', () => {
    const { lock, logs } = setup();
    expect(lock.unlock('cli', true)).toEqual({ locked: false, error: '', attempts: 0 });
    expect(logs).toContain('blocker: unlocked without the password (cli)');
  });

  it('never lifts an unlocked screen twice, in any mode', () => {
    const { lock, logs } = setup(DEFAULT_PIN, false, false);
    expect(lock.unlock('alt').locked).toBe(false);
    expect(logs).toEqual([]);
  });

  it('counts a wrong attempt even after a lock and unlock', () => {
    const { lock } = setup();
    lock.submit('1');
    lock.lock();
    expect(lock.view().attempts).toBe(1);
  });

  it('accepts a 4 to 12 digit password only', () => {
    expect(validPin('1805')).toBe(true);
    expect(validPin('123456789012')).toBe(true);
    for (const bad of ['', '123', '1234567890123', '18 05', 'abcd', '1805\n']) expect(validPin(bad)).toBe(false);
  });
});
