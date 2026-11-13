import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BlockerView } from '../src/blocker/view.js';
import { BLOCKER_PS, BLOCKER_PS_FILE } from '../src/blocker/script.js';

class StubChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines: string[] = [];
  kill = vi.fn(() => {
    this.emit('exit', null);
    return true;
  });
  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      this.lines.push(...parts);
    });
  }
  ops() {
    return this.lines.map((l) => JSON.parse(l) as { op: string; locked?: boolean; error?: string; ms?: number });
  }
}

function setup(pin = '1805', opts: { locked?: boolean; ownerMode?: boolean } = { locked: true }) {
  const children: StubChild[] = [];
  const logs: string[] = [];
  const locks: boolean[] = [];
  const view = new BlockerView({
    script: 'C:\\blocker.ps1',
    pin,
    log: (m) => logs.push(m),
    ownerMode: opts.ownerMode,
    locked: opts.locked,
    onLock: (locked) => locks.push(locked),
    spawn: ((command: string, args: string[]) => {
      expect(command).toBe('powershell.exe');
      expect(args).toContain('C:\\blocker.ps1');
      const child = new StubChild();
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  view.start();
  return { view, children, logs, locks, child: children[0]! };
}

describe('BlockerView', () => {
  it('starts the window locked', () => {
    const { view, child } = setup();
    expect(view.locked()).toBe(true);
    expect(child.ops()).toEqual([{ op: 'state', locked: true, error: '' }]);
  });

  it('can start resident but unlocked, so the agent is always there for Alt+Shift+Space', () => {
    const { view, child, locks } = setup('1805', { locked: false });
    expect(view.locked()).toBe(false);
    expect(child.ops()).toEqual([{ op: 'state', locked: false, error: '' }]);
    expect(locks).toEqual([false]);
    // The hotkey puts the picture up and tells the agent the desktop is covered.
    child.stdout.write('{"ev":"hotkey","keys":"alt shift space"}\n');
    expect(view.locked()).toBe(true);
    expect(child.ops().at(-1)).toEqual({ op: 'state', locked: true, error: '' });
    expect(locks).toEqual([false, true]);
  });

  it('lifts the picture from the CLI even in owner mode, and never needs the window for it', () => {
    const { view, child, locks } = setup();
    child.stdout.write('{"ev":"hotkey","keys":"alt shift space"}\n');
    // Already locked: the hotkey changes nothing.
    expect(locks).toEqual([true]);
    view.release();
    expect(view.locked()).toBe(false);
    expect(child.ops().at(-1)).toEqual({ op: 'state', locked: false, error: '' });
  });

  it('unlocks on 1805 from the box and reports the error on a wrong one', () => {
    const { view, child } = setup();
    child.stdout.write('{"ev":"pin","text":"1111"}\n');
    child.stdout.write('{"ev":"pin","text":"1805"}\n');
    expect(child.ops().slice(1)).toEqual([
      { op: 'state', locked: true, error: 'Неверный пароль. Попробуйте снова.' },
      { op: 'state', locked: false, error: '' },
    ]);
    expect(view.locked()).toBe(false);
  });

  it('locks again on demand, and takes a new password from the next Enter', () => {
    const { view, child } = setup();
    child.stdout.write('{"ev":"pin","text":"1805"}\n');
    view.lock();
    expect(view.locked()).toBe(true);
    view.setPin('2468');
    child.stdout.write('{"ev":"pin","text":"1805"}\n');
    expect(view.locked()).toBe(true);
    child.stdout.write('{"ev":"pin","text":"2468"}\n');
    expect(view.locked()).toBe(false);
  });

  it('lets Shift+Space+Q through even in owner mode: no field to click, the picture in the way', () => {
    const { view, child } = setup();
    child.stdout.write('{"ev":"unlock","how":"spaceq"}\n');
    expect(view.locked()).toBe(false);
    expect(child.ops().at(-1)).toEqual({ op: 'state', locked: false, error: '' });
  });

  it('lets the owner through by typing the escape word, which shows nothing on the picture', () => {
    const { view, child, logs } = setup();
    child.stdout.write('{"ev":"word","text":"pocket"}\n');
    expect(view.locked()).toBe(false);
    expect(child.ops().at(-1)).toEqual({ op: 'state', locked: false, error: '' });
    expect(logs).toContain('blocker: unlocked by the escape word');
  });

  it('ignores any other word, and any key combination, in owner mode', () => {
    const { view, child, logs } = setup();
    child.stdout.write('{"ev":"word","text":"hello"}\n');
    child.stdout.write('{"ev":"unlock","how":"alt"}\n');
    expect(view.locked()).toBe(true);
    expect(logs).toContain('blocker: alt ignored (owner mode: password, escape word or the CLI only)');
  });


  it('steps aside for a click of Claude only while the desktop is covered', () => {
    const { view, child } = setup();
    view.through(400);
    expect(child.ops().at(-1)).toEqual({ op: 'through', ms: 400 });
    child.stdout.write('{"ev":"pin","text":"1805"}\n');
    view.through(400);
    expect(child.ops().filter((o) => o.op === 'through')).toHaveLength(1);
  });

  it('ignores a ready and other chatter without losing the window', () => {
    const { view, child } = setup();
    child.stdout.write('{"ev":"ready"}\n{"ev":"log","message":"capture exclusion failed: 5"}\nnot json\n');
    expect(view.locked()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('the lock screen script', () => {
  it('is opaque (WPF cannot hide a per-pixel layered window from capture) and never takes focus', () => {
    expect(BLOCKER_PS).not.toContain('AllowsTransparency');
    expect(BLOCKER_PS).toContain('ShowActivated = false');
    expect(BLOCKER_PS).toContain('WDA_EXCLUDEFROMCAPTURE');
    expect(BLOCKER_PS).toContain('WS_EX_NOACTIVATE');
  });

  it('swallows the person\'s keys but lets injected ones through, or Claude could not type', () => {
    expect(BLOCKER_PS).toContain('LLKHF_INJECTED');
    const hook = BLOCKER_PS.slice(BLOCKER_PS.indexOf('IntPtr HookCallback'), BLOCKER_PS.indexOf('// Runs on the hook'));
    expect(hook.indexOf('if (injected) return')).toBeLessThan(hook.indexOf('return (IntPtr)1;'));
  });

  it('is written with a byte order mark, as the overlay is, and keeps every label it shows out of the script', () => {
    expect(BLOCKER_PS_FILE.charCodeAt(0)).toBe(0xfeff);
    expect(BLOCKER_PS_FILE.slice(1)).toBe(BLOCKER_PS);
    // The one text the person reads ("Неверный пароль") travels from the agent with the state, not in the script.
    expect(BLOCKER_PS).not.toMatch(/[а-я]/);
    expect(BLOCKER_PS).toContain('S(op, "error")');
  });

  it('watches the keyboard on a thread of its own and puts the hook back every five seconds', () => {
    // Windows drops a low-level hook whose callback is slow, and then the person's keys reach the desktop.
    expect(BLOCKER_PS).toContain('SetTimer(IntPtr.Zero, IntPtr.Zero, 5000, IntPtr.Zero)');
    expect(BLOCKER_PS).toContain('if (msg.message == Native.WM_TIMER) RefreshHook();');
    expect(BLOCKER_PS).toContain('void RefreshHook()');
    // Nothing in the hook may write to stdout directly: the agent reads slowly now and then.
    const emit = BLOCKER_PS.slice(BLOCKER_PS.indexOf('void Emit('), BLOCKER_PS.indexOf('static void Write('));
    expect(emit).toContain('ThreadPool.QueueUserWorkItem');
  });

  it('switches the touchpad gestures off with the picture and puts the person\'s values back', () => {
    expect(BLOCKER_PS).toContain('ThreeFingerSlideEnabled');
    expect(BLOCKER_PS).toContain('FourFingerSlideEnabled');
    expect(BLOCKER_PS).toContain('void GesturesOff()');
    expect(BLOCKER_PS).toContain('void GesturesBack()');
    // Back on the way out however the window ends, and Explorer told to reload its cached settings.
    expect(BLOCKER_PS).toContain('win.Closing += OnClosing;');
    expect(BLOCKER_PS).toContain('4214f6fa-eb36-4e2f-9ca2-23fdc1832df7');
    // A state that is already locked still runs it: the window may have come back from a crash.
    const apply = BLOCKER_PS.slice(BLOCKER_PS.indexOf('void ApplyState('), BLOCKER_PS.indexOf('// ---------------------------------------------------------------- helpers'));
    expect(apply).toContain('GesturesOff();');
    expect(apply).toContain('GesturesBack();');
  });

  it('walks away from touchpad gestures: shell overlays get Esc and the picture comes back on top', () => {
    expect(BLOCKER_PS).toContain('XamlExplorerHostIslandWindow');
    expect(BLOCKER_PS).toContain('MultitaskingViewFrame');
    expect(BLOCKER_PS).toContain('keybd_event');
    expect(BLOCKER_PS).toContain('IsWindowOnCurrentVirtualDesktop');
  });

  it('puts the login block on the primary monitor, in its own pixels', () => {
    expect(BLOCKER_PS).toContain('global::System.Windows.Forms.Screen.PrimaryScreen');
    expect(BLOCKER_PS).toContain('void PositionLogin()');
    expect(BLOCKER_PS).toContain('loginPanel.Height = height;');
  });

  it('shows the desktop wallpaper as a brush, never as an OpacityMask over a JPEG', () => {
    expect(BLOCKER_PS).toContain('new ImageBrush(bitmap)');
    expect(BLOCKER_PS).not.toContain('OpacityMask');
    expect(BLOCKER_PS).toContain('wallpaper failed:');
  });

  it('registers Alt+Shift+Space with the system, so it works while the window is hidden', () => {
    expect(BLOCKER_PS).toContain('RegisterHotKey');
    expect(BLOCKER_PS).toContain('Native.MOD_ALT | Native.MOD_SHIFT | Native.MOD_NOREPEAT');
    expect(BLOCKER_PS).toContain('WM_HOTKEY');
    // Resident but out of sight until the hotkey: the process has to exist for the hotkey to exist.
    expect(BLOCKER_PS).toContain('win.Show();\n            win.Hide();');
  });

  it('keeps the escape word off the picture: letters are swallowed, never drawn', () => {
    const type = BLOCKER_PS.slice(BLOCKER_PS.indexOf('void Type(uint vk)'), BLOCKER_PS.indexOf('// ---------------------------------------------------------------- clicks'));
    // Only the mapped digit is ever appended to the box.
    expect(type).not.toMatch(/box\.Password \+= letter/);
    expect(type).toContain('box.Password += digit.ToString()');
    expect(type).toContain('Emit("word"');
  });

  it('stays inside what the .NET Framework compiler behind Add-Type knows', () => {
    expect(BLOCKER_PS).not.toMatch(/\?\.|\$"|nameof\(/);
    expect(BLOCKER_PS).not.toMatch(/\$\{/);
  });

  it('repositions using the actual window DPI when the display layout changes', () => {
    expect(BLOCKER_PS).toContain('msg == Native.WM_DISPLAYCHANGE || msg == Native.WM_DPICHANGED');
    expect(BLOCKER_PS).toContain('placedWidth = int.MinValue;');
    expect(BLOCKER_PS).toContain('source.CompositionTarget.TransformFromDevice');
    expect(BLOCKER_PS).toContain('(primary.Left - virtualScreen.Left) * scaleX');
    expect(BLOCKER_PS).toContain('(primary.Top - virtualScreen.Top) * scaleY');
    expect(BLOCKER_PS).not.toContain('SystemParameters.PrimaryScreenWidth');
    const sourceInitialized = BLOCKER_PS.slice(BLOCKER_PS.indexOf('win.SourceInitialized'), BLOCKER_PS.indexOf('win.Closing'));
    expect(sourceInitialized).toMatch(/StyleHwnd\(\);\s*Place\(\);\s*PositionLogin\(\);/);
  });

  it.skipIf(process.platform !== 'win32')('compiles the WPF host with Windows PowerShell 5.1 without starting it', () => {
    const file = join(tmpdir(), `pocket-blocker-compile-${process.pid}.ps1`);
    const compileOnly = BLOCKER_PS_FILE.replace(/\[PocketBlocker\.Blocker\]::Run\(\)\s*$/, '');
    expect(compileOnly).not.toContain('[PocketBlocker.Blocker]::Run()');
    writeFileSync(file, compileOnly + "\nWrite-Output 'compiled'\n");
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        encoding: 'utf8', timeout: 60_000,
      });
      expect(out.trim()).toBe('compiled');
    } finally {
      rmSync(file, { force: true });
    }
  }, 65_000);

  // PowerShell 7 parses 5.1 syntax; CI runners and Macs with pwsh get a real syntax check, elsewhere the test is skipped.
  const pwsh = process.env.POCKET_PWSH ?? 'pwsh';
  const hasPwsh = (() => {
    try {
      execFileSync(pwsh, ['-NoProfile', '-c', '1'], { stdio: 'ignore', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasPwsh)('parses without syntax errors', () => {
    const file = join(tmpdir(), `pocket-blocker-${process.pid}.ps1`);
    writeFileSync(file, BLOCKER_PS_FILE);
    const check = [
      '$t = $null; $e = $null',
      "[System.Management.Automation.Language.Parser]::ParseFile('" + file.replace(/'/g, "''") + "', [ref]$t, [ref]$e) | Out-Null",
      'if ($e) { $e | ForEach-Object { "{0}: {1}" -f $_.Extent.StartLineNumber, $_.Message }; exit 1 }',
      "'ok'",
    ].join('; ');
    const out = execFileSync(pwsh, ['-NoProfile', '-c', check], { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
    expect(out.trim()).toBe('ok');
  });
});
