/**
 * Acceptance run for an installed PocketClipboard: what `scripts/install-linux.sh` put on this machine, run as the
 * systemd user service it set up, and used through the launcher a person types (`PocketClipboard …`). It answers
 * what the other acceptance runs cannot: whether the installer's files work, whether the commands that change a
 * desktop from the command line do what they say, and what becomes of a chat's desktop when systemd stops the
 * service with a browser open on it.
 *
 * It pairs the installed agent with a brain started here and uninstalls it at the end, so it is for a machine that
 * is nobody's (a CI runner, a test VM) and refuses to run without --this-machine. From lx/, after the installer:
 *   bash apps/clipboard-agent/scripts/install-linux.sh </dev/null
 *   node --import tsx apps/clipboard-agent/scripts/service-acceptance.ts --this-machine [--out <folder>] [--browser <command>] [--keep]
 *
 * Real: systemd, the installed bundle and helpers, the launcher, the desktops and the browser, the relay and the
 * brain. Standing in, as in the other runs: the phone, the VS Code window around the executor code, the person's
 * screen, and the model.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { coloursIn, findBrowser, liveRecord, LX_ROOT, prepare, processesOf, running, sleep, startStack, until, workspaceDir, type Chat, type ToolOutcome } from './acceptance/stack.js';

/** Points of pure red (every second pixel each way) that only the test page's banner puts on a screen. */
const RED_BANNER = 3000;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const SERVICE = 'pocket-clipboard.service';
const home = os.homedir();
const installed = path.join(home, '.pocket-clipboard');
const bundle = path.join(installed, 'agent.cjs');
const launcher = path.join(home, '.local', 'bin', 'PocketClipboard');
const unitFile = path.join(home, '.config', 'systemd', 'user', SERVICE);

if (!flag('this-machine')) {
  console.error('This run pairs the PocketClipboard installed for this login with a brain of its own and uninstalls it afterwards. Run it on a machine that is nobody\'s, with --this-machine.');
  process.exit(2);
}
if (!existsSync(bundle)) {
  console.error(`${bundle} is not there: run apps/clipboard-agent/scripts/install-linux.sh first.`);
  process.exit(2);
}

interface Check {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const notes: string[] = [];
let current = '';
const section = (title: string) => {
  current = title;
  console.log(`\n== ${title}`);
};
const show = (detail: unknown): string => (typeof detail === 'string' ? detail : (JSON.stringify(detail) ?? ''));
function check(name: string, ok: boolean, detail: unknown = ''): boolean {
  const text = show(detail).replace(/\s+/g, ' ').slice(0, 900);
  checks.push({ section: current, name, ok, detail: text });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !text ? '' : `\n      ${text}`}`);
  return ok;
}
const note = (text: string) => {
  notes.push(text);
  console.log(`      ${text}`);
};
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const mode = (file: string) => (statSync(file).mode & 0o777).toString(8);

const browser = findBrowser(option('browser'));
const started = Date.now();
let failure: unknown;
let stack: Awaited<ReturnType<typeof startStack>> | undefined;
// The real home: the service reads its state there, and the executor code looks for the desktops there.
const scratch = prepare(option('out'), { home });

try {
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('1. What the installer left');
  const helpers = ['computer.py', 'blocker.py', 'workspace-view.py'];
  check('the bundle, the helpers and the launcher are there, readable by this login only', existsSync(launcher) && mode(bundle) === '700' && mode(launcher) === '700' && helpers.every((h) => existsSync(path.join(installed, h)) && mode(path.join(installed, h)) === '600'), [bundle, launcher, ...helpers].map((f) => (existsSync(f.includes('/') ? f : path.join(installed, f)) ? mode(f.includes('/') ? f : path.join(installed, f)) : 'missing')));
  check('the helpers are the ones of this checkout', helpers.every((h) => readFileSync(path.join(installed, h), 'utf8') === readFileSync(path.join(LX_ROOT, 'apps/clipboard-agent/src/linux', h), 'utf8')));
  const unit = existsSync(unitFile) ? readFileSync(unitFile, 'utf8') : '';
  check('the service is described to systemd: it runs the bundle, and stopping it signals the agent alone', /^ExecStart=.*agent\.cjs" run$/m.test(unit) && /^KillMode=mixed$/m.test(unit) && /^TimeoutStopSec=10$/m.test(unit), unit.split('\n').filter((l) => /^(ExecStart|KillMode|TimeoutStopSec|Restart)=/.test(l)));
  const verified = run('systemd-analyze', ['--user', 'verify', unitFile]);
  // It also speaks of other units of the machine; only what it says about a line of this one counts.
  check('systemd finds nothing wrong with that description', verified.code !== null && !/pocket-clipboard\.service:\d+:/.test(verified.out), verified.out.split('\n').filter((l) => l.includes('pocket-clipboard')).slice(0, 4));
  const unpaired = run(launcher, ['status']);
  check('before it is paired the launcher says so, and the service is not running', /Not paired\./.test(unpaired.out) && run('systemctl', ['--user', 'is-active', '--quiet', SERVICE]).code !== 0, unpaired.out);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('2. The service');
  if (option('browser')) run('systemctl', ['--user', 'set-environment', `POCKET_WORKSPACE_BROWSER=${option('browser')}`]);
  stack = await startStack(scratch, { ...(option('browser') ? { browser: option('browser')! } : {}), agentBundle: bundle, service: SERVICE, personBrowser: false, log: (line) => console.log(`   ${line}`) });
  const { phone, pages, agent } = stack;
  const live = (chat: Chat) => liveRecord(scratch, chat.desktop);
  const computer = (chat: Chat, action: string, more: Record<string, unknown> = {}): Promise<ToolOutcome> => stack!.tool(chat, 'computer', { action, ...more });
  const cli = (...args: string[]) => run(launcher, args).out;
  const cmdline = (pid: number | undefined) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      return '';
    }
  };
  const inService = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(SERVICE);
    } catch {
      return false;
    }
  };
  const lastOf = (page: string, kind: string) => pages.of(page, kind).at(-1);
  const loadsOf = (page: string) => pages.of(page, 'load');
  let requests = 0;
  const requestId = () => `svc-${++requests}`;
  const goneAll = (pids: number[]) => until('the processes to end', () => pids.every((p) => !running(p)), 20_000).then(() => true, () => false);
  const agentLog = path.join(installed, 'agent.log');
  const logged = () => (existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '');

  check('paired through its own pairing question and started by systemd: the main process is the installed bundle', agent.alive && /agent\.cjs run$/.test(cmdline(agent.pid)), cmdline(agent.pid));
  /** The service is up again and its agent has told the brain about its desktops: only then is a chat's step fair. */
  const up = async (firstPid?: number) => {
    await until('the service to run', () => agent.alive && agent.pid !== firstPid && /^running, /.test(cli('status')), 60_000, 500);
    await stack!.waitForDesktops();
    await sleep(1000);
  };
  /** A chat's first step after the service came up: its agent may be running and not yet back at the relay. */
  const firstStep = (chat: Chat) =>
    until('the computer to be reachable again', async () => {
      const outcome = await computer(chat, 'screenshot');
      return /is offline/.test(outcome.text) ? undefined : outcome;
    }, 40_000, 1000);
  // What a person runs once more after pairing, and what an update runs: it enables the service for the next
  // login and starts it again.
  const before = agent.pid;
  const again = cli('install');
  const cameBack = await up(before).then(() => true, () => false);
  check('`PocketClipboard install` on a paired, running installation enables the service and leaves it running, as a new process', /Installed pocket-clipboard\.service/.test(again) && run('systemctl', ['--user', 'is-enabled', SERVICE]).out === 'enabled' && cameBack && agent.pid !== before, [again.split('\n').slice(-3), run('systemctl', ['--user', 'is-active', SERVICE]).out]);
  const status = cli('status');
  check('`PocketClipboard status` reports it running, paired, with chat desktops on', /^running, paired with account /.test(status) && /chat desktops \d+ running/.test(status), status);
  note(`status: ${status}`);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("3. A chat's desktop under the service");
  const A = await stack.newChat('Chat A');
  const first = await firstStep(A);
  const liveA = live(A);
  check('the chat\'s first screenshot starts its desktop, as a process of the service', !first.isError && !!liveA && liveA.generation === 1 && running(liveA.xserver.pid) && inService(liveA.xserver.pid), [first.text.slice(0, 200), liveA?.display]);
  if (!liveA) throw new Error('Chat A has no desktop.');
  await computer(A, 'open', { target: pages.url('A') });
  await until('page A to load', () => loadsOf('A').length > 0, 120_000, 250);
  check('a real browser opens the page in the desktop\'s own profile', lastOf('A', 'load')?.visits === 1 && processesOf(scratch, A.desktop).some((p) => p.cmdline.some((arg) => arg.includes(`${workspaceDir(scratch, A.desktop)}/profiles/`))), lastOf('A', 'load'));
  note(`browser: ${browser ? run(browser.path, ['--version']).out.split('\n')[0] : 'none found'}; ${(processesOf(scratch, A.desktop).find((p) => p.cmdline.some((arg) => arg.includes('/profiles/')))?.cmdline.join(' ') ?? '').slice(0, 220)}`);
  // A page that has loaded is not yet a page on the screen: a browser draws its first picture a moment later.
  const seePage = (name: string, timeoutMs = 60_000) =>
    until('the chat to see its page', async () => {
      const look = await computer(A, 'screenshot');
      if (look.isError || !look.images[0]) return undefined;
      const file = path.join(scratch.out, `${name}.jpg`);
      writeFileSync(file, Buffer.from(look.images[0].data, 'base64'));
      return coloursIn(file).colours.red.count > RED_BANNER ? file : undefined;
    }, timeoutMs, 500).catch(() => undefined);
  const seen = await seePage('service-chat-screenshot');
  check('the chat\'s own screenshot shows the page: its red banner', !!seen, seen ?? 'no red banner within a minute');
  const listed = cli('workspaces');
  check('`PocketClipboard workspaces` lists it: running, start number 1, the chat\'s name', new RegExp(`^${A.desktop}\\s+running\\s+${liveA.display}\\s+gen 1\\s`, 'm').test(listed) && listed.includes('Chat A'), listed);
  const picture = path.join(scratch.out, 'service-desktop.png');
  const shot = cli('workspaces', 'shot', A.desktop.slice(0, 12), picture);
  const shown = existsSync(picture) && readFileSync(picture).subarray(1, 4).toString('latin1') === 'PNG' ? coloursIn(picture).colours.red.count : -1;
  check('`PocketClipboard workspaces shot` saves a picture of that desktop: the page with its red banner is on it', /^Saved /.test(shot) && shown > RED_BANNER, [shot, `red points: ${shown}`]);
  const viaCommand = await stack.tool(A, 'Bash', { command: `xdg-open ${pages.url('A2')}` });
  await until('the page opened from a command', () => loadsOf('A2').length > 0, 90_000, 250).catch(() => undefined);
  check('a command of the chat reaches the same desktop: the executor code and the service share this login', lastOf('A2', 'load')?.visits === 2, [viaCommand.text, lastOf('A2', 'load')]);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('4. Reset from the command line');
  let pids = processesOf(scratch, A.desktop).map((p) => p.pid);
  let mark = logged().length;
  const reset = cli('workspaces', 'reset', 'Chat A');
  check('`PocketClipboard workspaces reset` closes the desktop: every process of it ends, its files stay', (await goneAll(pids)) && !live(A) && existsSync(path.join(workspaceDir(scratch, A.desktop), 'profiles')), [reset, pids.filter(running)]);
  note(`reset answered: ${reset}; the agent logged: ${logged().slice(mark).split('\n').filter((l) => l.includes(A.desktop)).map((l) => l.replace(/^\S+ workspace \S+: /, '')).join(' / ') || 'nothing'}`);
  const second = await computer(A, 'screenshot');
  check('the chat\'s next screenshot starts a fresh desktop: start number 2', !second.isError && live(A)?.generation === 2, second.text.slice(0, 200));
  let loads = loadsOf('A').length;
  await computer(A, 'open', { target: pages.url('A') });
  await until('the page the chat opened to count its visits', () => loadsOf('A').slice(loads).some((e) => e.visits === 3), 120_000, 250).catch(() => undefined);
  check('the browser profile was kept to its last seconds: page A counts 3 visits', Math.max(0, ...loadsOf('A').slice(loads).map((e) => e.visits)) === 3, loadsOf('A').slice(loads));

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('5. systemd stops the service with a browser open on the desktop');
  // A visit a few seconds before the stop: what a browser holds only in memory when it is ended without being asked.
  await stack.tool(A, 'Bash', { command: `xdg-open ${pages.url('A2')}` });
  await until('the visit before the stop', () => lastOf('A2', 'load')?.visits === 4, 90_000, 250).catch(() => undefined);
  await sleep(3000);
  pids = processesOf(scratch, A.desktop).map((p) => p.pid);
  const server = live(A)?.xserver.pid ?? 0;
  mark = logged().length;
  const stopStarted = Date.now();
  await agent.stop();
  const stopMs = Date.now() - stopStarted;
  const result = run('systemctl', ['--user', 'show', '-p', 'Result', '-p', 'ActiveState', SERVICE]).out.replace(/\n/g, ' ');
  const stopLog = logged().slice(mark).split('\n').filter(Boolean).map((l) => l.replace(/^\S+ /, ''));
  check('`systemctl --user stop` ends it within its ten seconds, by itself: systemd had nothing left to kill', stopMs < 10_000 && /Result=success/.test(result) && /ActiveState=inactive/.test(result), { stopMs, result });
  check('no process of the chat\'s desktop is left, its X server and browser included', (await goneAll(pids)) && !running(server) && !live(A), pids.filter(running).map(cmdline));
  check('the agent closed the desktop in order: its programs were asked to close, and did, before it ended', stopLog.some((l) => /its programs closed when asked/.test(l)) && stopLog.some((l) => /closed \(PocketClipboard is closing\)/.test(l)) && stopLog.at(-1) === 'stopped', stopLog.slice(-6));
  note(`the stop took ${stopMs} ms; the agent's log of it: ${stopLog.map((l) => l.replace(/workspace \S+: /, '')).join(' / ')}`);
  const journal = run('journalctl', ['--user', '-u', SERVICE, '--since', `@${Math.floor(stopStarted / 1000) - 1}`, '--no-pager', '-o', 'cat']).out;
  check('systemd\'s own record of the stop has no time-out and no kill', !/timed out|Killing|SIGKILL/i.test(journal), journal.split('\n').slice(-6));
  agent.start();
  await up();
  const third = await firstStep(A);
  check('started again, the chat gets a fresh desktop under the same name: start number 3', !third.isError && live(A)?.generation === 3, third.text.slice(0, 200));
  loads = loadsOf('A').length;
  await computer(A, 'open', { target: pages.url('A') });
  await until('the page the chat opened to count its visits', () => loadsOf('A').slice(loads).some((e) => e.visits === 5), 120_000, 250).catch(() => undefined);
  check('what the browser stored seconds before the stop is there: page A counts 5 visits', Math.max(0, ...loadsOf('A').slice(loads).map((e) => e.visits)) === 5, loadsOf('A').slice(loads));
  // Evidence, not a check: the page as the chat sees it on the desktop that was started after the stop.
  if (!(await seePage('service-after-stop', 30_000))) note('the page did not show on the chat\'s screenshot within 30 s after the service was started again; service-after-stop.jpg is the last look.');

  // For comparison, not a check: the same stop with systemd's default, which signals every process of the service
  // at once. It shows what the KillMode line in the unit is for; the unit is put back afterwards.
  try {
    writeFileSync(unitFile, unit.replace(/^KillMode=mixed\n/m, ''), { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    await stack.tool(A, 'Bash', { command: `xdg-open ${pages.url('A2')}` });
    await until('the visit before the second stop', () => lastOf('A2', 'load')?.visits === 6, 90_000, 250).catch(() => undefined);
    await sleep(3000);
    mark = logged().length;
    const plainStarted = Date.now();
    await agent.stop();
    const plainMs = Date.now() - plainStarted;
    const plainLog = logged().slice(mark).split('\n').filter(Boolean).map((l) => l.replace(/^\S+ /, '').replace(/workspace \S+: /, ''));
    writeFileSync(unitFile, unit, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    agent.start();
    await up();
    await firstStep(A);
    loads = loadsOf('A').length;
    await computer(A, 'open', { target: pages.url('A') });
    await until('page A to load', () => loadsOf('A').length > loads, 120_000, 250).catch(() => undefined);
    await sleep(3000);
    const counted = Math.max(0, ...loadsOf('A').slice(loads).map((e) => e.visits));
    note(`for comparison, the same stop without KillMode=mixed (systemd signals every process of the service at once): ${plainMs} ms; the agent logged: ${plainLog.join(' / ') || 'nothing'}; afterwards page A counted ${counted} visits where 7 is all of them.`);
  } catch (e) {
    writeFileSync(unitFile, unit, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    note(`the comparison without KillMode=mixed did not run to its end: ${e instanceof Error ? e.message : String(e)}`);
    if (!agent.alive) agent.start();
    await up();
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('6. Desktops off and on, and delete, from the command line');
  const capabilities = () => stack!.brain.executor.info(stack!.pcId)?.capabilities ?? [];
  const off = cli('workspaces', 'off');
  const wentOff = await until('the computer to say its desktops are off', () => !capabilities().includes('workspaces') && capabilities().includes('host-desktop'), 60_000).then(() => true, () => false);
  check('`PocketClipboard workspaces off` restarts the service without desktops: the brain is told chats use the real screen', /Per-chat desktops off/.test(off) && wentOff && agent.alive && !live(A), [off, capabilities()]);
  const offStatus = cli('status');
  const refused = await firstStep(A);
  check('a chat\'s step is then an error that says why, and nothing is started for it', refused.isError && !live(A), [refused.text.slice(0, 300), offStatus]);
  const on = cli('workspaces', 'on');
  await up();
  check('`PocketClipboard workspaces on` brings them back', /Per-chat desktops on/.test(on) && capabilities().includes('workspaces'), [on, capabilities()]);
  const fourth = await firstStep(A);
  const dir = workspaceDir(scratch, A.desktop);
  pids = processesOf(scratch, A.desktop).map((p) => p.pid);
  const deleted = cli('workspaces', 'delete', A.desktop);
  check('`PocketClipboard workspaces delete` closes the desktop and removes its files, profile included', !fourth.isError && (await goneAll(pids)) && (await until('the files to go', () => !existsSync(dir), 15_000).then(() => true, () => false)), [deleted, existsSync(dir)]);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('7. Leaving');
  const wiped = await phone.ask({ type: 'session.delete', payload: { sessionId: A.id } }, 'session.deleted').then(() => true, () => false);
  const uninstalled = cli('uninstall');
  check('`PocketClipboard uninstall` stops and removes the service and the pairing', wiped && !agent.alive && !existsSync(unitFile) && !existsSync(path.join(installed, 'state.json')) && run('systemctl', ['--user', 'is-enabled', SERVICE]).code !== 0, uninstalled);
  void requestId;
} catch (e) {
  failure = e;
  console.error(`\nSTOPPED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  const log = path.join(installed, 'agent.log');
  if (existsSync(log)) console.error(`\nLast lines of PocketClipboard's log:\n${readFileSync(log, 'utf8').trim().split('\n').slice(-25).join('\n')}`);
  console.error(`\nsystemd about the service:\n${run('systemctl', ['--user', 'status', SERVICE, '--no-pager', '-n', '15']).out}`);
}
await stack?.stop().catch(() => undefined);
if (!flag('keep')) run(launcher, ['uninstall']);

const failed = checks.filter((c) => !c.ok);
const summary = `${checks.length - failed.length} of ${checks.length} checks passed${failure ? '; the run stopped early' : ''}`;
const sections = [...new Set(checks.map((c) => c.section))];
const report = [
  '# PocketClipboard as installed, under systemd: acceptance run',
  '',
  `- Result: **${failed.length === 0 && !failure ? 'PASS' : 'FAIL'}**, ${summary}`,
  `- When: ${new Date(started).toISOString()}, ${Math.round((Date.now() - started) / 1000)} s`,
  `- Where: ${os.hostname()}, ${os.type()} ${os.release()}, user ${os.userInfo().username} (uid ${process.getuid?.()}), Node ${process.version}, ${run('systemctl', ['--version']).out.split('\n')[0]}`,
  `- PocketClipboard: ${bundle}, installed by scripts/install-linux.sh and run as ${SERVICE}`,
  '',
  'Real in this run: systemd, the installed bundle, helpers and launcher, the desktops (X servers, window managers, session buses, input helpers), the browser, the relay, the brain, the executor\'s dispatcher, placement and shell commands.',
  'Standing in: the phone (a paired client sending the phone\'s messages), the VS Code window around the executor code, the person\'s screen (an X server started for the run), and the model (tool calls are made by this script through the chat\'s tool handlers).',
  '',
  ...notes.map((n) => `- ${n}`),
  ...(failure ? ['', `Stopped early: ${failure instanceof Error ? failure.message : String(failure)}`] : []),
  ...sections.flatMap((s) => ['', `## ${s}`, '', '| Check | Result |', '| --- | --- |', ...checks.filter((c) => c.section === s).map((c) => `| ${c.name.replace(/\|/g, '/')} | ${c.ok ? 'pass' : `**FAIL** ${c.detail.replace(/\|/g, '/')}`} |`)]),
  '',
].join('\n');
writeFileSync(path.join(scratch.out, 'REPORT-service.md'), report);
console.log(`\n${summary}. Evidence: ${scratch.out}`);
process.exit(failed.length === 0 && !failure ? 0 : 1);
