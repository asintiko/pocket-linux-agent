/**
 * Acceptance run for the per-chat Linux desktops: two chats at once on real X servers with real browsers, through
 * the route a chat's tools really take (brain → relay → PocketClipboard / executor), next to a stand-in for the
 * person's own screen that must come out untouched. See acceptance/stack.ts for what is real and what stands in.
 *
 * Run it as an ordinary user (Chrome refuses to start as root) from lx/:
 *   npx tsx apps/clipboard-agent/scripts/workspaces-acceptance.ts [--out <folder>] [--browser <command>] [--agent <agent.cjs>] [--keep]
 *
 * It needs what install-linux.sh installs (Xvfb, openbox, dbus, xdotool, wmctrl, xclip, xdg-utils, python3 with Tk,
 * Pillow and Xlib), xauth, and a browser. Screenshots and REPORT.md are written to the output folder; the exit code
 * is 0 only when every check passed.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  coloursIn,
  differingPixels,
  findBrowser,
  grab,
  liveRecord,
  pointer,
  prepare,
  parentOf,
  processesOf,
  running,
  sessionOf,
  sleep,
  startStack,
  until,
  windowTitles,
  workspaceDir,
  x,
  type Chat,
  type Colour,
  type Colours,
  type ToolOutcome,
} from './acceptance/stack.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

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
  const text = show(detail).replace(/\s+/g, ' ').slice(0, 700);
  checks.push({ section: current, name, ok, detail: text });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !text ? '' : `\n      ${text}`}`);
  return ok;
}
const note = (text: string) => {
  notes.push(text);
  console.log(`      ${text}`);
};

const browser = findBrowser(option('browser'));
if (!browser) {
  console.error('No browser found (firefox, firefox-esr, chromium, google-chrome). Install one, or name it with --browser.');
  process.exit(2);
}
if (process.getuid?.() === 0 && browser.family === 'chromium') {
  console.error(`${browser.name} refuses to start as root unless its sandbox is switched off, which Pocket never does. Run this as an ordinary user.`);
  process.exit(2);
}

const scratch = prepare(option('out'));
const started = Date.now();
const stack = await startStack(scratch, { ...(option('browser') ? { browser: option('browser')! } : {}), ...(option('agent') ? { agentBundle: option('agent')! } : {}), log: (line) => console.log(`   ${line}`) });
const { phone, pages, human } = stack;

let requests = 0;
const requestId = () => `acc-${++requests}`;
const live = (chat: Chat) => liveRecord(scratch, chat.desktop);
const mustLive = (chat: Chat) => {
  const record = live(chat);
  if (!record) throw new Error(`${chat.title} has no running desktop`);
  return record;
};
const save = (base: string, image: { data: string; mimeType: string }): string => {
  const file = path.join(scratch.out, `${base}.${image.mimeType.includes('png') ? 'png' : 'jpg'}`);
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  return file;
};
const computer = (chat: Chat, action: string, more: Record<string, unknown> = {}): Promise<ToolOutcome> => stack.tool(chat, 'computer', { action, ...more });

/** A screenshot through the chat's computer tool, kept as evidence and read for the colours that name a page. */
async function look(chat: Chat, base: string): Promise<{ outcome: ToolOutcome; file: string; colours: Colours }> {
  const outcome = await computer(chat, 'screenshot');
  if (outcome.isError || !outcome.images[0]) throw new Error(`${chat.title}: screenshot failed: ${outcome.text}`);
  const file = save(base, outcome.images[0]);
  return { outcome, file, colours: coloursIn(file) };
}
const IDENTITIES = ['red', 'blue', 'green'] as const;
type Identity = (typeof IDENTITIES)[number];
/** The picture shows the page named by `own` and nothing of the two others. */
const showsOnly = (c: Colours, own: Identity): boolean => c.colours[own].count > 3000 && IDENTITIES.filter((k) => k !== own).every((k) => c.colours[k].count < 20);
const counted = (c: Colours): string => IDENTITIES.map((k) => `${k} ${c.colours[k].count}`).join(', ');
const centre = (c: Colours, marker: Colour): [number, number] => {
  const box = c.colours[marker].box;
  if (!box || c.colours[marker].count < 50) throw new Error(`the ${marker} marker is not on the screenshot`);
  return [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)];
};
const lastOf = (page: string, kind: string) => pages.of(page, kind).at(-1);
const tcpClosed = (display: string) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(6000 + Number(display.slice(1)), '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
const version = (command: string, args: string[]) => (spawnSync(command, args, { encoding: 'utf8' }).stdout ?? '').trim().split('\n')[0] ?? '';
/** A chat's background job: the executor (this process) started it, not PocketClipboard. */
const startedByExecutor = (pid: number): boolean => {
  for (let p = pid, hops = 0; p > 1 && hops < 64; p = parentOf(p), hops++) {
    if (p === stack.agent.pid) return false;
    if (p === process.pid) return true;
  }
  return false;
};
/** What a desktop consists of and what runs on it; with `jobs`, also the chat's background jobs started inside it. */
const pidsOf = (chat: Chat, jobs = false) => processesOf(scratch, chat.desktop).filter((p) => jobs || !startedByExecutor(p.pid)).map((p) => p.pid);
const goneAll = (pids: number[], ms = 15_000) => until('processes to end', () => pids.every((pid) => !running(pid)), ms).then(() => true, () => false);

let failure: unknown;
const chats: Chat[] = [];
try {
  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("0. The person's own screen before anything is done");
  const still = async () => {
    const one = path.join(scratch.root, 'still-1.png');
    const two = path.join(scratch.root, 'still-2.png');
    grab(human, one);
    await sleep(1200);
    grab(human, two);
    return differingPixels(one, two) === 0;
  };
  await until("the person's screen to be still", still, 90_000, 300);
  const humanBefore = human.state();
  const humanPicture = path.join(scratch.out, '0-person-screen-before.png');
  grab(human, humanPicture);
  const humanEvents = pages.of('H').length;
  check("the stand-in for the person's screen shows the person's page, window and clipboard", showsOnly(coloursIn(humanPicture), 'green') && humanBefore.activeWindow === 'Human notes' && humanBefore.clipboard.startsWith("the person's own clipboard"), humanBefore);
  check('PocketClipboard and the executor run inside that session, as on a real machine', process.env.DISPLAY === human.DISPLAY, process.env.DISPLAY);

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('1. Two chats, two desktops, two browsers');
  const A = await stack.newChat('Chat A');
  const B = await stack.newChat('Chat B');
  chats.push(A, B);
  check('the brain binds the two chats to two different desktops', A.desktop !== B.desktop && /^ws_[a-z2-7]{26}$/.test(A.desktop) && /^ws_[a-z2-7]{26}$/.test(B.desktop), [A.desktop, B.desktop]);
  check('no desktop exists before a chat first needs one', !live(A) && !live(B) && pidsOf(A, true).length + pidsOf(B, true).length === 0);

  const [firstA, firstB] = await Promise.all([look(A, '1-chat-a-first-look'), look(B, '1-chat-b-first-look')]);
  const liveA = mustLive(A);
  const liveB = mustLive(B);
  const asked = stack.consents.filter((c) => c.tool === 'computer');
  check('each chat asks the phone once before it uses a desktop, and says it is not the person\'s screen', asked.length === 2 && asked.every((c) => /separate desktop/.test(show(c.input)) && /Your own screen is not touched/.test(show(c.input))), asked.map((c) => c.input));
  check('both desktops start at the same moment, each its first time', liveA.generation === 1 && liveB.generation === 1);
  check('each has its own X display, access cookie and session bus, none of them the person\'s', new Set([liveA.display, liveB.display, human.DISPLAY]).size === 3 && liveA.env.XAUTHORITY !== liveB.env.XAUTHORITY && liveA.env.DBUS_SESSION_BUS_ADDRESS !== liveB.env.DBUS_SESSION_BUS_ADDRESS && liveA.env.XAUTHORITY !== human.XAUTHORITY, [liveA.display, liveB.display, human.DISPLAY]);
  check('the agent is told that its tools address a desktop of the chat\'s own', /this chat's own Linux desktop/.test(firstA.outcome.text) && /not the user's screen/.test(firstA.outcome.text), firstA.outcome.text);
  check('a fresh desktop is empty: no page of anyone is on it', IDENTITIES.every((k) => firstA.colours.colours[k].count < 20 && firstB.colours.colours[k].count < 20), [counted(firstA.colours), counted(firstB.colours)]);
  const xservers = [liveA, liveB].map((l) => readFileSync(`/proc/${l.xserver.pid}/cmdline`, 'utf8').split('\0'));
  check('the X servers do not listen on TCP', xservers.every((args) => args.join(' ').includes('-nolisten tcp')) && (await tcpClosed(liveA.display)) && (await tcpClosed(liveB.display)), xservers.map((a) => a.join(' ')));
  check(
    'a display lets in only clients that hold its own cookie',
    x(sessionOf(liveA), 'xdpyinfo', []).ok && !x({ DISPLAY: liveA.display, XAUTHORITY: '/dev/null' }, 'xdpyinfo', []).ok && !x({ DISPLAY: liveA.display, XAUTHORITY: liveB.env.XAUTHORITY ?? '' }, 'xdpyinfo', []).ok && !x({ DISPLAY: liveB.display, XAUTHORITY: human.XAUTHORITY }, 'xdpyinfo', []).ok,
  );

  // Two documented ways to start the browser: an address, and the word "browser" with the address as argument.
  const [openedA, openedB] = await Promise.all([computer(A, 'open', { target: pages.url('A') }), computer(B, 'open', { target: 'browser', args: pages.url('B') })]);
  check('each chat opens a browser on its own page', !openedA.isError && !openedB.isError, [openedA.text, openedB.text]);
  await until('page A to load', () => pages.of('A', 'load').length > 0, 180_000, 250);
  await until('page B to load', () => pages.of('B', 'load').length > 0, 180_000, 250);
  await until("chat A's browser window", async () => (await computer(A, 'list_windows')).text.includes('Pocket page A'), 60_000, 500);
  await until("chat B's browser window", async () => (await computer(B, 'list_windows')).text.includes('Pocket page B'), 60_000, 500);
  const [maxA, maxB] = await Promise.all([computer(A, 'maximize_window', { window: 'Pocket page A' }), computer(B, 'maximize_window', { window: 'Pocket page B' })]);
  check('each chat finds and maximizes its own browser window', !maxA.isError && !maxB.isError, [maxA.text, maxB.text]);

  const dirA = workspaceDir(scratch, A.desktop);
  const dirB = workspaceDir(scratch, B.desktop);
  const browserArgs = (chat: Chat) => processesOf(scratch, chat.desktop).filter((p) => p.cmdline.some((a) => a.includes('/profiles/'))).map((p) => p.cmdline.join(' '));
  const argsA = browserArgs(A);
  const argsB = browserArgs(B);
  check('the two browsers are real ones, each with a profile inside its own desktop\'s folder', argsA.length > 0 && argsB.length > 0 && argsA.every((a) => a.includes(`${dirA}/profiles/`) && !a.includes(dirB)) && argsB.every((a) => a.includes(`${dirB}/profiles/`) && !a.includes(dirA)), [argsA[0], argsB[0]]);
  check('neither was started with its sandbox switched off or a debugging port', argsA.length > 0 && argsB.length > 0 && [...argsA, ...argsB].every((a) => !/--no-sandbox|--remote-debugging|--disable-setuid-sandbox/.test(a)));
  note(`browser: ${version(browser.path, ['--version'])}; first process of chat A's: ${(argsA[0] ?? '').slice(0, 200)}`);

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('2. Interleaved screenshots, clicks, typing and clipboards');
  let a = await until('chat A to see its page', async () => {
    const seen = await look(A, '2-chat-a-page');
    return showsOnly(seen.colours, 'red') && seen.colours.colours.magenta.count > 50 ? seen : undefined;
  }, 60_000, 500);
  let b = await until('chat B to see its page', async () => {
    const seen = await look(B, '2-chat-b-page');
    return showsOnly(seen.colours, 'blue') && seen.colours.colours.magenta.count > 50 ? seen : undefined;
  }, 60_000, 500);
  check("chat A's screenshot shows page A and nothing of page B or of the person's screen", showsOnly(a.colours, 'red'), counted(a.colours));
  check("chat B's screenshot shows page B and nothing of page A or of the person's screen", showsOnly(b.colours, 'blue'), counted(b.colours));

  const clickA = await computer(A, 'left_click', { coordinate: centre(a.colours, 'magenta') });
  const clickB = await computer(B, 'left_click', { coordinate: centre(b.colours, 'magenta') });
  check('each chat clicks into the text field of its own page', !clickA.isError && !clickB.isError, [clickA.text, clickB.text]);
  const nonce = Math.random().toString(36).slice(2, 8);
  const partsA = [`alpha-${nonce} `, 'reaches ', 'page A ', 'only'];
  const partsB = [`bravo-${nonce} `, 'arrives ', 'in page B ', 'alone'];
  const typed: ToolOutcome[] = [];
  for (let i = 0; i < partsA.length; i++) {
    // Both chats type at the same moment, then take turns: neither order may mix their keys.
    if (i % 2 === 0) typed.push(...(await Promise.all([computer(A, 'type', { text: partsA[i] }), computer(B, 'type', { text: partsB[i] })])));
    else typed.push(await computer(A, 'type', { text: partsA[i] }), await computer(B, 'type', { text: partsB[i] }));
  }
  const textA = partsA.join('');
  const textB = partsB.join('');
  await until('the typed text to reach both pages', () => lastOf('A', 'input')?.value === textA && lastOf('B', 'input')?.value === textB, 30_000).catch(() => undefined);
  check('typing in both chats at once and in turns: page A received exactly what chat A typed', typed.every((t) => !t.isError) && lastOf('A', 'input')?.value === textA, lastOf('A', 'input')?.value);
  check('and page B exactly what chat B typed', lastOf('B', 'input')?.value === textB, lastOf('B', 'input')?.value);
  check('no key of one chat reached the other page', pages.of('A', 'input').every((e) => !e.value.includes('bravo')) && pages.of('B', 'input').every((e) => !e.value.includes('alpha')));

  a = await look(A, '2-chat-a-typed');
  b = await look(B, '2-chat-b-typed');
  await computer(A, 'left_click', { coordinate: centre(a.colours, 'cyan') });
  await computer(B, 'left_click', { coordinate: centre(b.colours, 'cyan') });
  await computer(B, 'double_click', { coordinate: centre(b.colours, 'cyan') });
  await until('the clicks to reach both pages', () => lastOf('A', 'click')?.value === '1' && lastOf('B', 'click')?.value === '3', 20_000).catch(() => undefined);
  check('mouse clicks land on the button of the chat\'s own page: one in A, three in B', lastOf('A', 'click')?.value === '1' && lastOf('B', 'click')?.value === '3', [lastOf('A', 'click')?.value, lastOf('B', 'click')?.value]);
  const movedA = await computer(A, 'mouse_move', { coordinate: [311, 505] });
  const movedB = await computer(B, 'mouse_move', { coordinate: [907, 613] });
  const pointerA = pointer(sessionOf(liveA));
  const pointerB = pointer(sessionOf(liveB));
  const positionA = await computer(A, 'cursor_position');
  check('each desktop has a pointer of its own, where its chat put it', !movedA.isError && !movedB.isError && pointerA.x === 311 && pointerA.y === 505 && pointerB.x === 907 && pointerB.y === 613 && /\[311, 505\]/.test(positionA.text) && human.state().pointer === humanBefore.pointer, [pointerA, pointerB, positionA.text]);

  const clipA = `clipboard of chat A ${nonce}`;
  const clipB = `clipboard of chat B ${nonce}`;
  const wrote = await Promise.all([stack.tool(A, 'pc_clipboard_write', { text: clipA }), stack.tool(B, 'pc_clipboard_write', { text: clipB })]);
  const [readA, readB] = await Promise.all([stack.tool(A, 'pc_clipboard_read'), stack.tool(B, 'pc_clipboard_read')]);
  check('each chat reads back what it put on its own clipboard, written at the same moment', wrote.every((w) => !w.isError) && readA.text === clipA && readB.text === clipB, [readA.text, readB.text]);
  for (const [chat, seen] of [[A, a], [B, b]] as const) {
    await computer(chat, 'left_click', { coordinate: centre(seen.colours, 'magenta') });
    await computer(chat, 'key', { text: 'ctrl+a' });
    await computer(chat, 'key', { text: 'ctrl+v' });
  }
  await until('the pasted text to reach both pages', () => lastOf('A', 'paste')?.value === clipA && lastOf('B', 'paste')?.value === clipB, 20_000).catch(() => undefined);
  check('ctrl+v in each browser pastes that chat\'s clipboard', lastOf('A', 'paste')?.value === clipA && lastOf('B', 'paste')?.value === clipB && lastOf('A', 'input')?.value === clipA && lastOf('B', 'input')?.value === clipB, [lastOf('A', 'paste')?.value, lastOf('B', 'paste')?.value]);
  for (const [chat, seen] of [[A, a], [B, b]] as const) {
    await computer(chat, 'triple_click', { coordinate: centre(seen.colours, 'yellow') });
    await computer(chat, 'key', { text: 'ctrl+c' });
  }
  await until('the copies to happen', () => pages.of('A', 'copy').length > 0 && pages.of('B', 'copy').length > 0, 20_000).catch(() => undefined);
  const [copiedA, copiedB] = await Promise.all([stack.tool(A, 'pc_clipboard_read'), stack.tool(B, 'pc_clipboard_read')]);
  check('ctrl+c in each browser puts the copied text on that chat\'s clipboard', copiedA.text.trim() === 'COPY-ME-A' && copiedB.text.trim() === 'COPY-ME-B', [copiedA.text, copiedB.text]);
  check("the person's clipboard still holds what the person copied", human.state().clipboard === humanBefore.clipboard, human.state().clipboard);

  a = await look(A, '2-chat-a-after');
  b = await look(B, '2-chat-b-after');
  check('after all of it each screenshot still shows only its own page', showsOnly(a.colours, 'red') && showsOnly(b.colours, 'blue'), [counted(a.colours), counted(b.colours)]);
  const pcShot = await stack.tool(A, 'pc_screenshot');
  const pcShotFile = pcShot.images[0] ? save('2-chat-a-pc-screenshot', pcShot.images[0]) : undefined;
  check("pc_screenshot in chat A shows chat A's desktop too", !!pcShotFile && showsOnly(coloursIn(pcShotFile), 'red'), pcShot.text);
  const [listA, listB] = await Promise.all([computer(A, 'list_windows'), computer(B, 'list_windows')]);
  check('each chat lists only the windows of its own desktop', listA.text.includes('Pocket page A') && !listA.text.includes('Pocket page B') && !listA.text.includes('Human notes') && listB.text.includes('Pocket page B') && !listB.text.includes('Pocket page A'), [listA.text, listB.text]);

  const statusA = await phone.ask({ type: 'workspace.get', payload: { requestId: requestId(), sessionId: A.id } }, 'workspace.result');
  const mainA = statusA.payload.desktops.find((d) => d.key === 'main');
  check('the phone sees chat A\'s desktop as running, with its display and start number', statusA.payload.supported && mainA?.state === 'running' && mainA.generation === 1 && mainA.display === liveA.display, statusA.payload);
  const previewA = await phone.ask({ type: 'workspace.preview', payload: { requestId: requestId(), sessionId: A.id } }, 'workspace.preview.result');
  const previewB = await phone.ask({ type: 'workspace.preview', payload: { requestId: requestId(), sessionId: B.id } }, 'workspace.preview.result');
  const previewFileA = previewA.payload.image ? save('2-phone-preview-chat-a', { data: previewA.payload.image.dataBase64, mimeType: previewA.payload.image.mime }) : undefined;
  const previewFileB = previewB.payload.image ? save('2-phone-preview-chat-b', { data: previewB.payload.image.dataBase64, mimeType: previewB.payload.image.mime }) : undefined;
  check('the phone\'s preview of each chat shows that chat\'s desktop', !!previewFileA && !!previewFileB && showsOnly(coloursIn(previewFileA), 'red') && showsOnly(coloursIn(previewFileB), 'blue'), [previewA.payload.error, previewB.payload.error]);
  const clicksBeforePreview = [pages.of('A', 'mousedown').length, pages.of('A', 'key').length];
  await phone.ask({ type: 'workspace.preview', payload: { requestId: requestId(), sessionId: A.id } }, 'workspace.preview.result');
  check('looking in from the phone sends nothing to the desktop', pages.of('A', 'mousedown').length === clicksBeforePreview[0] && pages.of('A', 'key').length === clicksBeforePreview[1]);
  const hostScreen = await phone.ask({ type: 'screen.get', payload: { requestId: requestId(), deviceId: stack.pcId } }, 'screen.result');
  const hostFile = hostScreen.payload.image ? save('2-phone-host-screenshot', { data: hostScreen.payload.image.dataBase64, mimeType: hostScreen.payload.image.mime }) : undefined;
  const hostClipboard = await phone.ask({ type: 'clipboard.get', payload: { requestId: requestId(), deviceId: stack.pcId } }, 'clipboard.result');
  const hostText = (hostClipboard.payload.items ?? []).map((i) => (i.kind === 'text' ? i.text : '')).join('');
  check("the phone's own screenshot and clipboard requests still mean the person's screen and clipboard, not a chat's", !!hostFile && showsOnly(coloursIn(hostFile), 'green') && hostText === humanBefore.clipboard, [hostScreen.payload.error, hostText]);

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("3. Programs and background jobs started from each chat's commands");
  const env = 'echo "display=$DISPLAY cookie=$XAUTHORITY desktop=$POCKET_WORKSPACE_ID wayland=$WAYLAND_DISPLAY"';
  const [envA, envB] = await Promise.all([stack.tool(A, 'Bash', { command: env }), stack.tool(B, 'Bash', { command: env })]);
  check("a command of chat A runs with chat A's display and cookie, though the executor itself sits in the person's session", envA.text.includes(`display=${liveA.display} cookie=${liveA.env.XAUTHORITY} desktop=${A.desktop} `), envA.text);
  check("and a command of chat B with chat B's", envB.text.includes(`display=${liveB.display} cookie=${liveB.env.XAUTHORITY} desktop=${B.desktop} `), envB.text);
  const windowed = (title: string) => `python3 -c 'import tkinter as t; r = t.Tk(); r.title("${title}"); r.geometry("320x140+90+560"); r.mainloop()'`;
  const [appA, appB] = await Promise.all([stack.tool(A, 'Bash', { command: windowed('cmd-app-A'), run_in_background: true }), stack.tool(B, 'Bash', { command: windowed('cmd-app-B'), run_in_background: true })]);
  const jobOf = (outcome: ToolOutcome) => /with id (\S+?)\./.exec(outcome.text)?.[1] ?? '';
  const appJobA = jobOf(appA);
  const appJobB = jobOf(appB);
  await until('the windows of the two commands', () => windowTitles(sessionOf(liveA)).includes('cmd-app-A') && windowTitles(sessionOf(liveB)).includes('cmd-app-B'), 30_000).catch(() => undefined);
  const titles = { a: windowTitles(sessionOf(liveA)), b: windowTitles(sessionOf(liveB)), person: windowTitles(human) };
  check("a graphical program started from chat A's command opens on chat A's display and on no other", titles.a.includes('cmd-app-A') && !titles.b.includes('cmd-app-A') && !titles.person.includes('cmd-app-A'), titles);
  check("and one from chat B's command on chat B's", titles.b.includes('cmd-app-B') && !titles.a.includes('cmd-app-B') && !titles.person.includes('cmd-app-B'), titles);
  const seenByA = await computer(A, 'list_windows');
  check('the chat sees that window with its computer tool', seenByA.text.includes('cmd-app-A') && !seenByA.text.includes('cmd-app-B'), seenByA.text);

  const [sleeperA, sleeperB] = await Promise.all([stack.tool(A, 'Bash', { command: 'sleep 900', run_in_background: true }), stack.tool(B, 'Bash', { command: 'sleep 900', run_in_background: true })]);
  const sleepJobA = jobOf(sleeperA);
  const sleepJobB = jobOf(sleeperB);
  const jobs = stack.executor.jobs();
  const jobsOf = (chat: Chat) => jobs.filter((j) => j.scope === chat.scope);
  check('background jobs are kept per chat and per desktop', !!appJobA && !!sleepJobA && !!sleepJobB && jobsOf(A).length === 2 && jobsOf(B).length === 2 && jobsOf(A).every((j) => j.workspace === A.desktop && j.running) && jobsOf(B).every((j) => j.workspace === B.desktop && j.running), jobs);
  const peeked = await stack.tool(A, 'BashOutput', { bash_id: sleepJobB });
  const meddled = await stack.tool(A, 'KillShell', { shell_id: sleepJobB });
  check("chat A can neither read nor stop chat B's job", peeked.isError && meddled.isError && stack.executor.jobs(B.scope).some((j) => j.id === sleepJobB && j.running), [peeked.text, meddled.text]);
  const ownOutput = await stack.tool(A, 'BashOutput', { bash_id: sleepJobA });
  const killedOwn = await stack.tool(A, 'KillShell', { shell_id: appJobA });
  await until('cmd-app-A to close', () => !windowTitles(sessionOf(liveA)).includes('cmd-app-A'), 15_000).catch(() => undefined);
  check('chat A reads and stops its own job; its window goes, chat B\'s stays', !ownOutput.isError && !killedOwn.isError && !windowTitles(sessionOf(liveA)).includes('cmd-app-A') && windowTitles(sessionOf(liveB)).includes('cmd-app-B'), [ownOutput.text, killedOwn.text]);

  // Stop, as the button on the phone: chat A holds the mouse button down and waits for a slow command.
  const held = await computer(A, 'left_mouse_down', { coordinate: centre(a.colours, 'red') });
  check('chat A holds the left mouse button down', !held.isError && pointer(sessionOf(liveA)).leftDown, held.text);
  const slowStarted = Date.now();
  const slowA = stack.tool(A, 'Bash', { command: 'sleep 120; echo finished-A' });
  const slowB = stack.tool(B, 'Bash', { command: 'sleep 6; echo finished-B' });
  await sleep(2000);
  phone.send({ type: 'session.interrupt', payload: { sessionId: A.id } });
  const [stoppedA, finishedB] = await Promise.all([slowA, slowB]);
  check("stopping chat A's reply ends the command it was waiting for", !stoppedA.text.includes('finished-A') && Date.now() - slowStarted < 60_000, stoppedA.text);
  const released = await until('the button to be let go', () => !pointer(sessionOf(liveA)).leftDown, 6000).then(() => true, () => false);
  check('and lets go of the mouse button it held', released, pointer(sessionOf(liveA)));
  check("chat B's command runs to its end meanwhile", finishedB.text.includes('finished-B'), finishedB.text);
  const afterStop = mustLive(A);
  check('the desktop stays as it was for the next message: same start, same X server, page still open', afterStop.generation === 1 && afterStop.xserver.pid === liveA.xserver.pid && running(liveA.xserver.pid) && windowTitles(sessionOf(liveA)).some((t) => t.includes('Pocket page A')));
  check("chat A's background job is not ended by Stop", stack.executor.jobs(A.scope).some((j) => j.id === sleepJobA && j.running));
  if (!released) await computer(A, 'left_mouse_up');
  // Stop once more, this time in the middle of a step of the computer tool itself: a long text half typed. The step
  // ends by replacing the input helper, and what the helper opened on the desktop, the browser, must not go with it.
  const browserOf = (chat: Chat) => processesOf(scratch, chat.desktop).find((p) => p.cmdline.some((arg) => arg.includes('/profiles/')))?.pid;
  const browserBefore = browserOf(A);
  const typingStarted = Date.now();
  const longText = computer(A, 'type', { text: 'stoppedhalfway'.repeat(300) });
  await sleep(1500);
  phone.send({ type: 'session.interrupt', payload: { sessionId: A.id } });
  const cutShort = await longText;
  await sleep(1500);
  check(
    'stopping in the middle of a computer step ends the step and leaves what the chat opened: the same browser, its page still open',
    cutShort.isError && Date.now() - typingStarted < 25_000 && browserBefore !== undefined && browserOf(A) === browserBefore && running(browserBefore) && windowTitles(sessionOf(liveA)).some((t) => t.includes('Pocket page A')),
    { step: cutShort.text, browserBefore, browserAfter: browserOf(A), windows: windowTitles(sessionOf(liveA)) },
  );
  // A command that opens an address the way scripts do. The system's xdg-open would hand it to whatever browser the
  // machine calls its default, started outside the desktop's wrappers.
  const viaCommand = await stack.tool(A, 'Bash', { command: `xdg-open ${pages.url('A2')}` });
  await until('the page opened from a command', () => pages.of('A2', 'load').length > 0, 90_000, 250).catch(() => undefined);
  check("xdg-open in a chat's command opens the address in that chat's own browser and profile", pages.of('A2', 'load').length === 1 && lastOf('A2', 'load')?.visits === 2 && browserArgs(A).every((args) => args.includes(`${dirA}/profiles/`)), [viaCommand.text, lastOf('A2', 'load')]);

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("4. The person's own screen after all of that");
  const humanAfter = human.state();
  const humanPictureAfter = path.join(scratch.out, '4-person-screen-after.png');
  grab(human, humanPictureAfter);
  check('the same window has the focus', humanAfter.activeWindow === humanBefore.activeWindow, humanAfter.activeWindow);
  check('the pointer is where it was', humanAfter.pointer === humanBefore.pointer, humanAfter.pointer);
  check('the clipboard holds what it held', humanAfter.clipboard === humanBefore.clipboard, humanAfter.clipboard);
  check('the same windows are open, none added', JSON.stringify(humanAfter.windows) === JSON.stringify(humanBefore.windows), humanAfter.windows);
  check("the person's browser page received no key, click, focus change or reload", pages.of('H').length === humanEvents, pages.of('H').slice(humanEvents));
  const changed = differingPixels(humanPicture, humanPictureAfter);
  check('not one pixel of the screen changed', changed === 0, `${changed} pixels differ`);

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('5. Looking in from the computer itself');
  const status = stack.agent.cli(['status']);
  check('PocketClipboard status counts the chat desktops', /chat desktops 2 running/.test(status), status);
  const listing = stack.agent.cli(['workspaces']);
  check('PocketClipboard workspaces lists both, with display, start number and chat name', [A, B].every((chat) => new RegExp(`${chat.desktop}\\s+running\\s+${mustLive(chat).display}\\s+gen 1 .*${chat.title}`).test(listing)), listing);
  const shotFile = path.join(scratch.out, '5-local-shot-chat-b.png');
  const shot = stack.agent.cli(['workspaces', 'shot', 'chat b', shotFile]);
  check('PocketClipboard workspaces shot saves a picture of the named desktop', shot.includes(`Saved ${shotFile}`) && existsSync(shotFile) && showsOnly(coloursIn(shotFile), 'blue'), shot);
  const viewer = stack.agent.spawnCli(['workspaces', 'view', 'chat b']);
  const viewerUp = await until('the viewer window', () => windowTitles(human).some((t) => t.includes('Pocket desktop: Chat B (view only)')), 30_000).then(() => true, () => false);
  await sleep(3500);
  const viewerPicture = path.join(scratch.out, '5-viewer-on-person-screen.png');
  grab(human, viewerPicture);
  const viewerColours = coloursIn(viewerPicture);
  check("PocketClipboard workspaces view shows the desktop in a window on the person's screen", viewerUp && viewerColours.colours.blue.count > 500, counted(viewerColours));
  const before = pages.of('B').length;
  const viewerWindow = x(human, 'xdotool', ['search', '--name', 'Pocket desktop: Chat B']);
  const poked = viewerWindow.ok && x(human, 'xdotool', ['mousemove', '--window', viewerWindow.out.split('\n')[0] ?? '', '200', '200', 'click', '1', 'key', 'x']).ok;
  await sleep(1500);
  check('the viewer only shows: a click and a key in it do not reach the desktop', viewerUp && poked && pages.of('B').length === before, pages.of('B').slice(before));
  x(human, 'wmctrl', ['-c', 'Pocket desktop: Chat B']);
  await until('the viewer to close', () => viewer.exitCode !== null, 15_000).catch(() => viewer.kill('SIGKILL'));
  // The person opened and closed a window on their own screen just now; what counts from here on is what follows.
  await sleep(1500);
  const personEvents = pages.of('H').length;

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('6. Reset, failures, restart');
  const stale = async (chat: Chat, seen: { colours: Colours }) => computer(chat, 'left_click', { coordinate: centre(seen.colours, 'cyan') });

  // 6a. Reset from the phone.
  let oldA = pidsOf(A, true);
  // Where the browser keeps what pages store, file by file: when the profile check below fails, this tells "never
  // written down" from "written down and not found again".
  const storedIn = (dir: string): string => {
    const found: string[] = [];
    const walk = (folder: string, depth: number) => {
      let names: string[] = [];
      try {
        names = depth < 9 ? readdirSync(folder) : [];
      } catch {}
      for (const name of names) {
        const file = path.join(folder, name);
        try {
          const stat = statSync(file);
          if (stat.isDirectory()) walk(file, depth + 1);
          else if (/\/storage\/default\/[^/]+\/ls\/|\/Local Storage\/leveldb\//.test(file)) found.push(`${path.relative(path.join(dir, 'profiles'), file)} ${stat.size} B written ${Math.round((Date.now() - stat.mtimeMs) / 1000)} s ago`);
        } catch {}
      }
    };
    walk(path.join(dir, 'profiles'), 0);
    return found.join('; ') || 'no such file';
  };
  const agentLog = path.join(scratch.home, '.pocket-clipboard', 'agent.log');
  const loggedSoFar = existsSync(agentLog) ? readFileSync(agentLog, 'utf8').length : 0;
  const storedBefore = storedIn(dirA);
  const reset = await phone.ask({ type: 'workspace.reset', payload: { requestId: requestId(), sessionId: A.id } }, 'workspace.result');
  check('reset from the phone closes chat A\'s desktop: every process of it ends', !reset.payload.error && (await goneAll(oldA)) && !live(A), [reset.payload.error, oldA.filter(running)]);
  const resetLogged = existsSync(agentLog) ? readFileSync(agentLog, 'utf8').slice(loggedSoFar).split('\n').filter((line) => line.includes(A.desktop)).map((line) => line.replace(/^\S+ workspace \S+: /, '')) : [];
  note(`the reset of chat A's desktop, as PocketClipboard logged it: ${resetLogged.join(' / ') || 'nothing'}`);
  // The chat's jobs in that desktop are stopped once it has closed, a moment after the phone has its answer.
  await until("chat A's job in that desktop to be stopped", () => !stack.executor.jobs(A.scope).some((j) => j.running), 15_000).catch(() => undefined);
  check("it stops chat A's background job in that desktop and leaves chat B's alone", !stack.executor.jobs(A.scope).some((j) => j.running) && stack.executor.jobs(B.scope).filter((j) => j.running).length === 2, stack.executor.jobs());
  b = await look(B, '6a-chat-b-after-reset-of-a');
  await computer(B, 'left_click', { coordinate: centre(b.colours, 'magenta') });
  await computer(B, 'key', { text: 'ctrl+a' });
  await computer(B, 'type', { text: 'still here' });
  await until('chat B to type', () => lastOf('B', 'input')?.value === 'still here', 15_000).catch(() => undefined);
  check('chat B goes on working in its desktop', showsOnly(b.colours, 'blue') && lastOf('B', 'input')?.value === 'still here' && mustLive(B).generation === 1, lastOf('B', 'input')?.value);
  const staleA = await stale(A, a);
  check('a click chat A planned on the closed desktop is refused, with what to do instead', staleA.isError && /screenshot/i.test(staleA.text), staleA.text);
  check("and is not carried out anywhere: no desktop was started for it, the person's screen got nothing", !live(A) && pages.of('H').length === personEvents, { desktop: !!live(A), person: pages.of('H').slice(personEvents) });
  const again = await look(A, '6a-chat-a-fresh-desktop');
  check('the next screenshot starts a fresh, empty desktop and says so: start number 2', mustLive(A).generation === 2 && IDENTITIES.every((k) => again.colours.colours[k].count < 20) && /freshly started desktop/.test(again.outcome.text), again.outcome.text);
  const loads = pages.of('A', 'load').length;
  await computer(A, 'open', { target: pages.url('A') });
  const loadedAgain = () => pages.of('A', 'load').slice(loads);
  await until('page A to load again', () => loadedAgain().length > 0, 120_000, 250);
  // Firefox loads a page it knows once more by itself, for the thumbnail it keeps of it: a private copy that finds
  // nothing stored and counts one visit, before or after the page the chat opened. That one is the one that counts on.
  await until('the page the chat opened to count its visits', () => loadedAgain().some((e) => e.visits === 3), 20_000, 250).catch(() => undefined);
  const kept = Math.max(0, ...loadedAgain().map((e) => e.visits));
  // 3 is everything: its first visit, the one a command opened seconds before the reset, and this one. The desktop
  // asks its programs to close before anything ends them; a browser that was given that moment wrote all of it down.
  if (!check('the browser profile was kept to its last seconds: page A counts its first visit, the one a command opened before the reset, and this one', kept === 3, loadedAgain())) {
    note(`the profile check failed. Where the browser keeps what pages store, just before the reset: ${storedBefore}`);
    note(`and after the page was opened again on the fresh desktop: ${storedIn(dirA)}`);
  }
  const copies = loadedAgain().filter((e) => e.visits !== kept);
  if (copies.length) note(`after the reset the browser also loaded page A by itself, without the profile's storage (${copies.map((e) => `${e.visits} visit`).join(', ')}): Firefox does that for the thumbnail of a page it knows. It is not the page the chat opened and is not counted.`);
  await until("chat A's browser window", async () => (await computer(A, 'list_windows')).text.includes('Pocket page A'), 60_000, 500);
  await computer(A, 'maximize_window', { window: 'Pocket page A' });
  a = await until('chat A to see its page again', async () => {
    const seen = await look(A, '6a-chat-a-page-again');
    return showsOnly(seen.colours, 'red') ? seen : undefined;
  }, 60_000, 500);

  // 6b. The input helper of chat B dies.
  const helperOf = (chat: Chat) => processesOf(scratch, chat.desktop).find((p) => p.cmdline.some((arg) => arg.endsWith('computer.py')));
  const helper = helperOf(B);
  if (helper) process.kill(helper.pid, 'SIGKILL');
  await sleep(500);
  b = await look(B, '6b-chat-b-after-helper-died');
  const helperNow = helperOf(B);
  check("chat B's input helper is killed: the next step gets a new one on the same desktop, windows and all", !!helper && !!helperNow && helperNow.pid !== helper.pid && mustLive(B).generation === 1 && mustLive(B).xserver.pid === liveB.xserver.pid && showsOnly(b.colours, 'blue'), [helper?.pid, helperNow?.pid]);
  check('chat A is not affected', showsOnly((await look(A, '6b-chat-a-meanwhile')).colours, 'red'));

  // 6c. The X server of chat B dies.
  let oldB = pidsOf(B);
  process.kill(liveB.xserver.pid, 'SIGKILL');
  await until("chat B's desktop to be gone", () => !live(B), 15_000).catch(() => undefined);
  const failedB = (await phone.ask({ type: 'workspace.get', payload: { requestId: requestId(), sessionId: B.id } }, 'workspace.result')).payload.desktops.find((d) => d.key === 'main');
  check("chat B's X server is killed: the phone shows the desktop as failed, with the reason", failedB?.state === 'failed' && !!failedB.error, failedB);
  check('everything that ran on it ends, including its browser', await goneAll(oldB), oldB.filter(running));
  note(`after chat B's X server died, its background jobs: ${stack.executor.jobs(B.scope).map((j) => `${j.command.slice(0, 24)} ${j.running ? 'running' : 'ended'}`).join('; ')}`);
  const staleB = await stale(B, b);
  check('a click chat B planned on it is refused', staleB.isError && /new screenshot/i.test(staleB.text), staleB.text);
  check('chat A still works', showsOnly((await look(A, '6c-chat-a-meanwhile')).colours, 'red') && mustLive(A).generation === 2);
  await look(B, '6c-chat-b-fresh-desktop');
  check('chat B gets a fresh desktop on its next screenshot: start number 2', mustLive(B).generation === 2 && mustLive(B).xserver.pid !== liveB.xserver.pid);

  // 6d. PocketClipboard is stopped and started again, as on logout and login or an update.
  oldA = pidsOf(A);
  oldB = pidsOf(B);
  await stack.agent.stop('SIGTERM');
  check('PocketClipboard stops: both desktops close with it, nothing of them is left running', (await goneAll([...oldA, ...oldB])) && !live(A) && !live(B) && pidsOf(A).length + pidsOf(B).length === 0, [...oldA, ...oldB].filter(running));
  const offline = await computer(A, 'screenshot');
  check("while it is down a chat's step fails with the reason; nothing falls back to the person's screen", offline.isError && /offline/i.test(offline.text) && pages.of('H').length === personEvents, [offline.text, pages.of('H').slice(personEvents)]);
  stack.agent.start();
  const backA = await until('PocketClipboard to be back', async () => {
    const seen = await computer(A, 'left_click', { coordinate: centre(a.colours, 'cyan') });
    return /offline/i.test(seen.text) ? undefined : seen;
  }, 90_000, 500);
  check('after the restart a step planned before it is refused', backA.isError && /screenshot/i.test(backA.text) && !live(A), backA.text);
  await Promise.all([look(A, '6d-chat-a-after-restart'), look(B, '6d-chat-b-after-restart')]);
  check('and each chat gets a fresh desktop under the same name: start number 3', mustLive(A).generation === 3 && mustLive(B).generation === 3 && mustLive(A).id === A.desktop);

  // 6e. PocketClipboard is killed outright.
  oldA = pidsOf(A);
  oldB = pidsOf(B);
  const setpriv = spawnSync('setpriv', ['--pdeathsig', 'TERM', '--', 'true']).status === 0;
  await stack.agent.stop('SIGKILL');
  const diedWithIt = await goneAll([...oldA, ...oldB], 10_000);
  if (setpriv) check('PocketClipboard is killed outright: the kernel ends the desktops with it', diedWithIt, [...oldA, ...oldB].filter(running));
  else note('setpriv is missing here: desktops of a killed PocketClipboard are ended when it next starts.');
  stack.agent.start();
  await until('PocketClipboard to be back', async () => !(await computer(B, 'screenshot')).isError, 120_000, 1000);
  check('after the next start nothing of the old desktops is left and the chats work again', (await goneAll([...oldA, ...oldB], 20_000)) && mustLive(B).generation === 4, [...oldA, ...oldB].filter(running));

  // 6f. Delete from the phone, and a chat that is deleted.
  await look(A, '6f-chat-a-before-delete');
  oldA = pidsOf(A, true);
  const wiped = await phone.ask({ type: 'workspace.reset', payload: { requestId: requestId(), sessionId: A.id, wipe: true } }, 'workspace.result');
  check("\"Delete desktop data\" on the phone closes chat A's desktop and removes its files, profile included", !wiped.payload.error && (await goneAll(oldA)) && !existsSync(dirA) && existsSync(dirB), [wiped.payload.error, existsSync(dirA)]);
  const afterDelete = await look(A, '6f-chat-a-after-delete');
  check('the agent is told with its next screenshot that the user deleted the desktop', /the user deleted the one from before together with its files/.test(afterDelete.outcome.text), afterDelete.outcome.text);
  check('a desktop that comes back under the same name counts on: steps planned on the deleted one can never fit it', mustLive(A).generation > 4, mustLive(A).generation);
  oldB = pidsOf(B, true);
  await phone.ask({ type: 'session.delete', payload: { sessionId: B.id } }, 'session.deleted');
  check('deleting chat B removes its desktop and files and stops its jobs; chat A keeps its own', (await goneAll(oldB)) && (await until('the files to go', () => !existsSync(dirB), 15_000).then(() => true, () => false)) && !stack.executor.jobs(B.scope).some((j) => j.running) && running(mustLive(A).xserver.pid), stack.executor.jobs(B.scope));

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('7. Leaving');
  const lastPids = pidsOf(A);
  await stack.stop();
  check('when PocketClipboard stops, no process of any chat desktop is left on the computer', (await goneAll(lastPids)) && pidsOf(A).length + pidsOf(B).length === 0, lastPids.filter(running));
} catch (e) {
  failure = e;
  console.error(`\nSTOPPED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  const log = path.join(scratch.home, '.pocket-clipboard', 'agent.log');
  if (existsSync(log)) console.error(`\nLast lines of PocketClipboard's log:\n${readFileSync(log, 'utf8').trim().split('\n').slice(-25).join('\n')}`);
  // What each desktop looked like when the run stopped: usually the answer to why.
  for (const chat of chats) {
    const record = live(chat);
    if (!record) continue;
    try {
      grab(sessionOf(record), path.join(scratch.out, `stopped-${chat.title.toLowerCase().replace(/\W+/g, '-')}.png`));
      console.error(`${chat.title} (${record.display}) had these windows: ${windowTitles(sessionOf(record)).join(' | ') || 'none'}`);
    } catch {}
  }
  await stack.stop().catch(() => undefined);
}

const failed = checks.filter((c) => !c.ok);
const summary = `${checks.length - failed.length} of ${checks.length} checks passed${failure ? '; the run stopped early' : ''}`;
const sections = [...new Set(checks.map((c) => c.section))];
const report = [
  '# Per-chat Linux desktops: acceptance run',
  '',
  `- Result: **${failed.length === 0 && !failure ? 'PASS' : 'FAIL'}**, ${summary}`,
  `- When: ${new Date(started).toISOString()}, ${Math.round((Date.now() - started) / 1000)} s`,
  `- Where: ${os.hostname()}, ${os.type()} ${os.release()}, user ${os.userInfo().username} (uid ${process.getuid?.()}), Node ${process.version}`,
  `- Programs: ${version('Xvfb', ['-version']) || 'Xvfb'}; ${version('openbox', ['--version'])}; ${version(browser.path, ['--version'])}`,
  `- PocketClipboard: ${option('agent') ? `installed bundle ${option('agent')}` : 'src/main.ts, run as its own process'}`,
  '',
  'Real in this run: the relay, the brain, PocketClipboard with its desktops (X servers, window managers, session buses, input helpers, clipboards), the browsers, the executor\'s dispatcher, placement and shell commands.',
  'Standing in: the phone (a paired client sending the phone\'s messages), the VS Code window around the executor code, the person\'s screen (an X server started for the run), and the model (tool calls are made by this script through the chat\'s tool handlers, after the same question to the phone that Claude Code triggers).',
  '',
  ...notes.map((n) => `- ${n}`),
  ...(failure ? ['', `Stopped early: ${failure instanceof Error ? failure.message : String(failure)}`] : []),
  ...sections.flatMap((s) => ['', `## ${s}`, '', '| Check | Result |', '| --- | --- |', ...checks.filter((c) => c.section === s).map((c) => `| ${c.name.replace(/\|/g, '/')} | ${c.ok ? 'pass' : `**FAIL** ${c.detail.replace(/\|/g, '/')}`} |`)]),
  '',
].join('\n');
writeFileSync(path.join(scratch.out, 'REPORT.md'), report);
writeFileSync(path.join(scratch.out, 'report.json'), JSON.stringify({ ok: failed.length === 0 && !failure, summary, checks, notes }, null, 2));
console.log(`\n${summary}. Evidence: ${scratch.out}`);
if (!flag('keep')) spawnSync('rm', ['-rf', path.join(scratch.root, 'home'), path.join(scratch.root, 't'), path.join(scratch.root, 'brain'), path.join(scratch.root, 'project'), path.join(scratch.root, 'human-profile')]);
process.exit(failed.length === 0 && !failure ? 0 : 1);
