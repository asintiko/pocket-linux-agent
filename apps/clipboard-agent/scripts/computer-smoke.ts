/**
 * Uses a real Windows desktop through the computer-use helper and checks what reached it: the helper is Windows
 * PowerShell 5.1 with Win32 calls, so only a Windows machine can tell whether a click lands, a text arrives whole or
 * a window comes to the front. CI runs it on windows-latest (.github/workflows/computer-windows.yml) and keeps the
 * screenshots. Usage: tsx scripts/computer-smoke.ts <output dir>
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ComputerAction, ComputerResult, WindowInfo } from '@pocket/protocol';
import { COMPUTER_PS, ComputerHost } from '../src/computer.js';

const out = resolve(process.argv[2] ?? 'computer-shots');
mkdirSync(out, { recursive: true });
const hostScript = join(out, 'computer.ps1');
const probeScript = join(out, 'probe.ps1');
const probeLog = join(out, 'probe.jsonl');
writeFileSync(hostScript, COMPUTER_PS);
writeFileSync(probeLog, '');

/** A window that writes down what reaches it: clicks, keys, the text in its box, where its list is scrolled to. ASCII only. */
const PROBE_PS = [
  'param([string]$log)',
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$utf8 = New-Object Text.UTF8Encoding $false',
  'function Note($o) { [IO.File]::AppendAllText($log, (ConvertTo-Json -InputObject $o -Compress) + [char]10, $utf8) }',
  'function Rect($c) { $p = $c.PointToScreen([Drawing.Point]::Empty); return @{ x = $p.X; y = $p.Y; width = $c.Width; height = $c.Height } }',
  '$form = New-Object Windows.Forms.Form',
  "$form.Text = 'Pocket probe'",
  "$form.StartPosition = 'Manual'",
  '$form.Location = New-Object Drawing.Point 120, 90',
  '$form.ClientSize = New-Object Drawing.Size 600, 420',
  '$form.KeyPreview = $true',
  '$box = New-Object Windows.Forms.TextBox',
  '$box.Location = New-Object Drawing.Point 20, 20',
  '$box.Size = New-Object Drawing.Size 560, 26',
  '$btn = New-Object Windows.Forms.Button',
  "$btn.Text = 'Press me'",
  '$btn.Location = New-Object Drawing.Point 20, 60',
  '$btn.Size = New-Object Drawing.Size 160, 40',
  '$chk = New-Object Windows.Forms.CheckBox',
  "$chk.Text = 'Tick me'",
  '$chk.Location = New-Object Drawing.Point 220, 66',
  '$chk.Size = New-Object Drawing.Size 160, 28',
  '$list = New-Object Windows.Forms.ListBox',
  '$list.Location = New-Object Drawing.Point 20, 120',
  '$list.Size = New-Object Drawing.Size 560, 280',
  "for ($i = 0; $i -lt 200; $i++) { [void]$list.Items.Add('row ' + $i) }",
  '$form.Controls.AddRange(@($box, $btn, $chk, $list))',
  '$script:presses = 0',
  "$btn.Add_Click({ $script:presses++; Note @{ ev = 'button'; n = $script:presses } })",
  "$chk.Add_CheckedChanged({ Note @{ ev = 'check'; on = $chk.Checked } })",
  "$box.Add_TextChanged({ Note @{ ev = 'text'; text = $box.Text } })",
  '$form.Add_KeyDown({',
  '  param($s, $e)',
  "  Note @{ ev = 'key'; key = $e.KeyCode.ToString(); ctrl = $e.Control; shift = $e.Shift; alt = $e.Alt }",
  '})',
  '$list.Add_MouseDown({',
  '  param($s, $e)',
  "  Note @{ ev = 'mouse'; button = $e.Button.ToString(); clicks = $e.Clicks; mods = [Windows.Forms.Control]::ModifierKeys.ToString() }",
  '})',
  '$timer = New-Object Windows.Forms.Timer',
  '$timer.Interval = 150',
  '$timer.Add_Tick({',
  "  Note @{ ev = 'state'; top = $list.TopIndex; active = ([Windows.Forms.Form]::ActiveForm -eq $form); window = $form.WindowState.ToString(); box = (Rect $box); button = (Rect $btn); check = (Rect $chk); list = (Rect $list) }",
  '})',
  "$form.Add_Shown({ $timer.Start(); Note @{ ev = 'shown' } })",
  '[Windows.Forms.Application]::Run($form)',
].join('\r\n');
writeFileSync(probeScript, PROBE_PS);

type Rect = { x: number; y: number; width: number; height: number };
type ProbeEvent = { ev: string; n?: number; on?: boolean; text?: string; key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; button?: string | Rect; clicks?: number; mods?: string; top?: number; active?: boolean; window?: string; box?: Rect; check?: Rect; list?: Rect };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events = (kind?: string): ProbeEvent[] =>
  readFileSync(probeLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ProbeEvent)
    .filter((e) => !kind || e.ev === kind);
const last = (kind: string) => events(kind).at(-1);
const until = async (test: () => boolean, ms = 6000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (test()) return true;
  return test();
};
const middle = (r: Rect) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });

const hostLog: string[] = [];
const host = new ComputerHost({ script: hostScript, log: (m) => hostLog.push(m) });
const act = (a: ComputerAction) => host.act(a);
const windows = async () => (await act({ action: 'windows' })).windows ?? [];
const find = async (title: RegExp) => (await windows()).find((w) => title.test(w.title));
let shots = 0;
const shot = async (name: string, settleMs?: number): Promise<ComputerResult> => {
  const r = await act({ action: 'screenshot', ...(settleMs ? { settleMs } : {}) });
  if (r.image) writeFileSync(join(out, `${String(++shots).padStart(2, '0')}-${name}.jpg`), Buffer.from(r.image.dataBase64, 'base64'));
  return r;
};

const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  <- ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
};
/** One group of checks: a failure in it is recorded with a screenshot and the rest still run. */
const group = async (name: string, run: () => Promise<void>) => {
  try {
    await run();
  } catch (e) {
    check(`${name}: ${e instanceof Error ? e.message : String(e)}`, false);
    await shot(`failed-${name.replace(/\W+/g, '-')}`).catch(() => undefined);
  }
};

const TEXT = 'Hello, мир! Привет — «тест» ёж 😀 end';

async function main(): Promise<void> {
  // Not windowsHide: a process started hidden has its first window hidden too, and the probe's window is the point.
  const probe = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', probeScript, probeLog], { stdio: 'ignore' });
  let probeWindow: WindowInfo | undefined;
  const state = () => last('state')!;

  await group('screen', async () => {
    const first = await shot('desktop');
    check('a screenshot is a JPEG no larger than asked for', !!first.image && first.image.mime === 'image/jpeg' && first.image.dataBase64.startsWith('/9j/') && first.image.width <= 1280 && first.image.height <= 800, first.image && { ...first.image, dataBase64: '' });
    check('it says which part of the desktop it shows and where the pointer is', !!first.region && !!first.displays?.length && first.region.width === first.displays[0]!.width && !!first.cursor, { region: first.region, displays: first.displays });
    check('the first screenshot has nothing to compare with', first.change === undefined && first.settled === undefined, { change: first.change, settled: first.settled });
  });

  await group('windows', async () => {
    check('the probe window opened', await until(() => events('shown').length > 0 && events('state').length > 0, 30_000), hostLog.slice(-5));
    for (const end = Date.now() + 10_000; !probeWindow && Date.now() < end; await sleep(200)) probeWindow = await find(/^Pocket probe$/);
    check('the list has the probe window with its place and program', !!probeWindow && probeWindow.width > 600 && probeWindow.process.toLowerCase() === 'powershell', probeWindow);
    check('the list leaves out the desktop itself', !(await windows()).some((w) => w.title === 'Program Manager'), (await windows()).map((w) => w.title));
    const r = await act({ action: 'window', handle: probeWindow!.handle, op: 'focus' });
    check('focus says the window is in front', r.text === 'The window is now in front.', r.text);
    check('and it is: the window knows it is active and the list marks it', (await until(() => state().active === true)) && (await find(/^Pocket probe$/))?.focused === true, state());
    const gone = await act({ action: 'window', handle: '1', op: 'focus' }).then(() => '', (e: Error) => e.message);
    check('a window that does not exist is an error', /no longer exists/.test(gone), gone);
  });

  await group('open', async () => {
    const r = await act({ action: 'open', target: 'notepad' });
    check('open starts a program and reports its window in front', /^Started notepad \(process \d+\)\. Its window ".*" is in front\.$/.test(r.text ?? ''), r.text);
    const front = (await windows())[0];
    check('the new window is first in the list and focused', !!front && /notepad/i.test(front.process) && front.focused, front);
    await shot('notepad-opened', 1500);
    const back = await act({ action: 'window', handle: probeWindow!.handle, op: 'focus' });
    check('a window behind another comes to the front when asked', back.text === 'The window is now in front.' && (await until(() => state().active === true)), { text: back.text, state: state() });
    if (front && /notepad/i.test(front.process)) {
      const closed = await act({ action: 'window', handle: front.handle, op: 'close' });
      check('close closes a window', closed.text === 'Closed.' && !(await find(/Notepad/i)), closed.text);
    }
    const missing = await act({ action: 'open', target: 'no-such-program-anywhere' }).then((x) => x.text ?? '', (e: Error) => e.message);
    check('opening something that does not exist is an error', /^Could not open no-such-program-anywhere/.test(missing), missing);
    await act({ action: 'window', handle: probeWindow!.handle, op: 'focus' });
  });

  await group('mouse', async () => {
    await shot('before-clicks', 1500);
    const b = middle(state().button as Rect);
    await act({ action: 'click', ...b, button: 'left', count: 1 });
    check('a click presses the button it points at', await until(() => events('button').length === 1), events('button'));
    const c = { x: (state().check as Rect).x + 8, y: middle(state().check as Rect).y };
    const done = await act({ action: 'click', ...c, button: 'left', count: 1 });
    check('a click ticks the check box and leaves the pointer there', (await until(() => last('check')?.on === true)) && done.cursor?.x === c.x && done.cursor?.y === c.y, { check: last('check'), cursor: done.cursor });
    const after = await shot('after-tick', 1500);
    const box = after.change?.box;
    check('the screenshot after it says a small part of the screen changed, around the check box', !!after.change && after.change.fraction > 0 && after.change.fraction < 0.2 && !!box && after.settled === true, { change: after.change, settled: after.settled });
    const again = await shot('unchanged', 1500);
    check('a second look says nothing changed', !!again.change && !again.change.box && again.change.fraction === 0 && again.settled === true, { change: again.change, settled: again.settled });
    const l = middle(state().list as Rect);
    const before = events('mouse').length;
    await act({ action: 'click', ...l, button: 'left', count: 2 });
    check('a double click arrives as one', await until(() => events('mouse').slice(before).some((e) => e.clicks === 2)), events('mouse').slice(before));
    const mid = events('mouse').length;
    await act({ action: 'click', x: l.x, y: l.y + 30, button: 'right', count: 1, modifiers: ['ctrl'] });
    check('ctrl + right click carries the button and the modifier', await until(() => events('mouse').slice(mid).some((e) => e.button === 'Right' && /Control/.test(e.mods ?? ''))), events('mouse').slice(mid));
    const plain = events('mouse').length;
    await act({ action: 'click', button: 'left', count: 1 });
    check('a click without a point lands where the pointer is, with no modifier left held', await until(() => events('mouse').slice(plain).some((e) => e.button === 'Left' && e.mods === 'None')), events('mouse').slice(plain));
    const top = state().top!;
    await act({ action: 'scroll', ...l, dx: 0, dy: 5 });
    check('scrolling down moves the list', await until(() => state().top! > top), { top, now: state().top });
    // The list keeps moving for a moment after the first notch shows.
    await sleep(800);
    const lower = state().top!;
    await act({ action: 'scroll', ...l, dx: 0, dy: -2 });
    check('scrolling up moves it back', await until(() => state().top! < lower), { lower, now: state().top });
  });

  await group('keyboard', async () => {
    await act({ action: 'click', ...middle(state().box as Rect), button: 'left', count: 1 });
    await act({ action: 'type', text: TEXT });
    check('typed text arrives whole: Cyrillic, punctuation, an emoji', await until(() => last('text')?.text === TEXT), last('text'));
    const keysAfter = async (keys: string, holdMs?: number) => {
      const from = events('key').length;
      await act({ action: 'key', keys, ...(holdMs ? { holdMs } : {}) });
      await sleep(400);
      return events('key').slice(from);
    };
    let seen = await keysAfter('ctrl+a');
    check('ctrl+a is the A key with ctrl', seen.some((e) => e.key === 'A' && e.ctrl && !e.shift), seen);
    // Select from the start to the end the way every text box understands, then delete.
    seen = await keysAfter('Home shift+End Delete');
    check('Home, shift+End and Delete empty the box', seen.some((e) => e.key === 'End' && e.shift) && seen.some((e) => e.key === 'Delete') && (await until(() => last('text')?.text === '')), { seen, text: last('text') });
    seen = await keysAfter('ctrl+shift+Home F5 Escape');
    check('several combinations arrive in order', ['Home', 'F5', 'Escape'].every((k) => seen.some((e) => e.key === k)) && seen.some((e) => e.key === 'Home' && e.ctrl && e.shift), seen);
    seen = await keysAfter('ctrl+/');
    check('ctrl+/ is the slash key with ctrl, whatever the layout', seen.some((e) => e.key === 'OemQuestion' && e.ctrl && !e.shift), seen);
    seen = await keysAfter('shift', 300);
    check('a held key goes down', seen.some((e) => e.key === 'ShiftKey'), seen);
    await act({ action: 'type', text: 'line one\tTab' });
    check('plain text with a tab moves on to the next control', await until(() => last('text')?.text === 'line one'), last('text'));
    const bad = await act({ action: 'key', keys: 'hyper+x' }).then(() => '', (e: Error) => e.message);
    check('an unknown key is an error', /Unknown key/.test(bad), bad);
  });

  await group('window operations', async () => {
    const w = (await find(/^Pocket probe$/))!;
    await act({ action: 'drag', path: [[w.x + 200, w.y + 14], [w.x + 320, w.y + 94]], button: 'left' });
    await sleep(500);
    const moved = (await find(/^Pocket probe$/))!;
    check('dragging the title bar moves the window', Math.abs(moved.x - w.x - 120) <= 8 && Math.abs(moved.y - w.y - 80) <= 8, { from: [w.x, w.y], to: [moved.x, moved.y] });
    let r = await act({ action: 'window', handle: w.handle, op: 'minimize' });
    check('minimize', r.text === 'Minimized.' && (await find(/^Pocket probe$/))?.minimized === true, r.text);
    r = await act({ action: 'window', handle: w.handle, op: 'focus' });
    check('focus brings a minimized window back', r.text === 'The window is now in front.' && (await until(() => state().active === true && state().window === 'Normal')), { text: r.text, state: state() });
    r = await act({ action: 'window', handle: w.handle, op: 'maximize' });
    check('maximize', r.text === 'Maximized.' && (await find(/^Pocket probe$/))?.maximized === true, r.text);
    await shot('maximized', 1500);
    r = await act({ action: 'window', handle: w.handle, op: 'restore' });
    check('restore', r.text === 'Restored.' && (await find(/^Pocket probe$/))?.maximized === false, r.text);
    const z = await act({ action: 'zoom', x: moved.x, y: moved.y, width: 300, height: 200 });
    check('zoom returns the region asked for', z.region?.width === 300 && z.region.height === 200 && !!z.image, z.region);
    await act({ action: 'move', x: moved.x + 300, y: moved.y + 300 });
    await act({ action: 'button', button: 'left', down: true });
    r = await act({ action: 'release' });
    check('release lets go of a held button', /Let go/.test(r.text ?? ''), r.text);
    r = await act({ action: 'window', handle: w.handle, op: 'close' });
    check('close closes the probe window', r.text === 'Closed.' && !(await find(/^Pocket probe$/)), r.text);
  });

  await shot('end').catch(() => undefined);
  host.close();
  probe.kill();
}

main()
  .catch((e) => {
    check(`the run itself: ${e instanceof Error ? e.stack : String(e)}`, false);
    host.close();
  })
  .finally(() => {
    writeFileSync(join(out, 'host.log'), hostLog.join('\n'));
    if (existsSync(probeLog)) console.log(`probe events: ${events().length}`);
    console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}\n\nhelper log:\n${hostLog.slice(-30).join('\n')}` : '\nall passed');
    process.exit(failures.length ? 1 : 0);
  });
