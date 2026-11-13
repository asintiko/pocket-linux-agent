/* eslint-disable @typescript-eslint/no-explicit-any */
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, type ComputerAction, type ComputerResult, type Display, type WindowInfo } from '@pocket/protocol';
import { z } from 'zod';
import type { PcHandle } from './pc-tools.js';

export const COMPUTER_TOOL = 'computer';
export const COMPUTER_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${COMPUTER_TOOL}`;

type Rect = { x: number; y: number; width: number; height: number };
type Point = [number, number];

/** What the latest screenshot showed: the display, where it sits on the desktop, and the picture's size. */
export interface ScreenView {
  display: number;
  region: Rect;
  width: number;
  height: number;
  displays: Display[];
}

/** A step as far as repeating it goes: the same action aimed at the same spot with the same words. */
interface Step {
  action: string;
  points: Point[];
  text: string;
}

/** One chat's computer use: the picture Claude's coordinates refer to, and whether a step is running. */
export class ComputerState {
  view: ScreenView | undefined;
  display = 0;
  busy = 0;
  /** The helper waits for the screen to stand still itself, so the pause before a screenshot can be short. */
  settles = false;
  /** The last screenshot, to tell that nothing changed when the helper does not compare pictures itself. */
  lastPicture: string | undefined;
  /** The step that keeps being repeated without the screen reacting, and how many times in a row. */
  stuck: { step: Step; times: number } | undefined;
  /** Whether this chat was told what kind of computer it is on. */
  introduced = false;
  /**
   * On a desktop of the chat's own: which start of that desktop the latest screenshot showed. Steps name it, so one
   * planned on a desktop that has since been closed and started again is refused instead of landing somewhere else.
   */
  generation: number | undefined;
  /** The left button is down since a left_mouse_down that no left_mouse_up followed: stopping the reply lets it go. */
  held = false;
  /** The user closed the desktop this chat was looking at ('deleted': with its files); the next screenshot says so. */
  closed: 'reset' | 'deleted' | undefined;
  /** Steps run one after another: two at once would each look at the other's half-done screen. */
  queue: Promise<unknown> = Promise.resolve();

  reset(): void {
    this.view = undefined;
    this.display = 0;
    this.settles = false;
    this.lastPicture = undefined;
    this.stuck = undefined;
    this.introduced = false;
    this.generation = undefined;
    this.held = false;
  }
}

/** Screenshot pixel → physical desktop pixel (the centre of the area that screenshot pixel covers). */
export function toDesktop(view: ScreenView, [x, y]: readonly [number, number]): { x: number; y: number } {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= view.width || py >= view.height) {
    throw new Error(`[${px}, ${py}] is outside the screenshot, which is ${view.width}x${view.height}: x goes from 0 to ${view.width - 1}, y from 0 to ${view.height - 1}`);
  }
  const kx = view.region.width / view.width;
  const ky = view.region.height / view.height;
  return {
    x: view.region.x + Math.min(view.region.width - 1, Math.floor((px + 0.5) * kx)),
    y: view.region.y + Math.min(view.region.height - 1, Math.floor((py + 0.5) * ky)),
  };
}

/** Physical desktop pixel → screenshot pixel, or undefined when the point is on another display. */
export function fromDesktop(view: ScreenView, p: { x: number; y: number }): Point | undefined {
  const r = view.region;
  if (p.x < r.x || p.y < r.y || p.x >= r.x + r.width || p.y >= r.y + r.height) return undefined;
  return [Math.floor(((p.x - r.x) * view.width) / r.width), Math.floor(((p.y - r.y) * view.height) / r.height)];
}

const ACTIONS = [
  'screenshot', 'zoom', 'cursor_position', 'wait',
  'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
  'type', 'key', 'hold_key',
  'list_windows', 'focus_window', 'minimize_window', 'maximize_window', 'restore_window', 'close_window', 'open', 'switch_display',
] as const;

const point = z.tuple([z.number(), z.number()]);
const SHAPE = {
  action: z.enum(ACTIONS),
  coordinate: point.optional().describe('[x, y] in pixels of the latest screenshot'),
  start_coordinate: point.optional().describe('Where left_click_drag starts, [x, y]'),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('[x1, y1, x2, y2] of the screenshot to look at closely (zoom)'),
  text: z.string().max(5000).optional().describe('type: the text. key / hold_key: keys like "ctrl+s", "Return", "alt+tab", "super+r". Clicks and scroll: a modifier to hold, like "shift" or "ctrl"'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().int().min(1).max(30).optional().describe('Wheel notches, default 3'),
  duration: z.number().min(0).max(30).optional().describe('Seconds, for wait and hold_key'),
  window: z.string().max(300).optional().describe('focus/minimize/maximize/restore/close_window: a handle from list_windows or part of the title or program name'),
  target: z.string().max(2000).optional().describe('open: a program, file, folder or URL, as in the Run dialog: "powershell", "chrome", "notepad", "explorer", "https://…"'),
  args: z.string().max(8000).optional().describe('open: arguments for the program'),
  display: z.number().int().min(0).optional().describe('switch_display: the index of the display to look at'),
};
type Input = { [K in keyof typeof SHAPE]: z.infer<(typeof SHAPE)[K]> };

const DESCRIPTION = [
  "Use the user's computer (Windows or Linux) the way a person at it would: see the screen, move and click the mouse, type, press keys, switch, open and close windows, start programs.",
  'Start with screenshot. Coordinates are [x, y] pixels of the latest screenshot; after every action you get a fresh screenshot and a note on what changed, to check the result.',
  'Actions: screenshot; zoom (region) to read small text; mouse_move, left_click, right_click, middle_click, double_click, triple_click (coordinate, optional; text = modifier); left_click_drag (start_coordinate, coordinate); left_mouse_down, left_mouse_up; scroll (coordinate, scroll_direction, scroll_amount);',
  'type (text); key, hold_key (text, duration); wait (duration); cursor_position; list_windows; focus_window, minimize_window, maximize_window, restore_window, close_window (window); open (target, args); switch_display (display).',
].join(' ');

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

/** What a chat with a Linux desktop of its own is told about it. `commands`: its shell commands run on the same computer and see the desktop. */
export function desktopPrompt(pcName: string | undefined, commands: boolean): string {
  return [
    "# This chat's own desktop",
    `On "${pcName ?? 'the Linux computer'}" this chat has a Linux desktop of its own (X11, one screen), separate from the user's screen and from every other chat's. mcp__pocket__computer operates that desktop like a person sitting at it; pc_screenshot and the pc_clipboard tools address it too. The user's own screen, windows, browser and clipboard are out of reach from here, by design, and nothing you do disturbs them.`,
    '- The desktop starts empty the first time it is used and stays between messages: what you opened is still there in the next turn. If it was closed in the meantime (unused for long, reset by the user), the next screenshot shows a freshly started one and says so; steps aimed at the old one are refused.',
    '- Start with a screenshot. Coordinates are pixels of the latest screenshot; each action returns a new one, so check it before the next step instead of assuming.',
    '- Start programs with open: "browser" or "terminal", a program\'s command ("firefox", "chromium", "xterm"), a path or a URL. The browser there has a profile that belongs to this chat alone; list_windows and focus_window switch windows; key presses shortcuts ("ctrl+l", "alt+tab", "Return").',
    commands
      ? '- Shell commands (Bash) run on the same computer and see this desktop: a graphical program started from a command opens there, and nowhere else. Background commands belong to this chat. A program with one instance per user may need pocket-app in front ("pocket-app libreoffice file.odt") to get this desktop\'s own settings.'
      : '- Start graphical programs with open, not from a shell command: commands of this chat do not run inside this desktop.',
    '- Every result ends with what the step did to the screen. When nothing changed, the step did not work: do not repeat it as it is. Look closer with zoom, check which window is in front, aim at the middle of the control, or use the keyboard.',
    '- If you delegate to subagents, each one that uses the computer tool gets a desktop of its own; they never share this one, and their desktops close when they finish.',
    '- Ask the user first before anything hard to undo outside the desktop: sending a message or mail, buying or paying, submitting a form on a site, deleting files.',
    '- The first action in a chat asks the user for permission on their phone; after that the chat may use its desktop freely. They can look into it from the chat on their phone at any time.',
  ].join('\n');
}

/** What Claude is told about computer use, in every mode. `desktop`: the chat works in a Linux desktop of its own instead of on the user's screen. */
export function computerToolsPrompt(pcName: string | undefined, desktop?: { commands: boolean }): string {
  if (desktop) return desktopPrompt(pcName, desktop.commands);
  const who = pcName ? `"${pcName}"` : "the user's Windows computer";
  return [
    "# Using the user's computer",
    `mcp__pocket__computer lets you see and operate ${who} like a person sitting at it. Use it when the user asks you to do something there: open a program or a site, type into a window, click, look at what is on the screen and fix it.`,
    '- Start with a screenshot. Coordinates are pixels of the latest screenshot; each action returns a new one, so check it before the next step instead of assuming.',
    '- Prefer keys and the window actions to hunting with the mouse: open starts programs and URLs (target "powershell", "chrome" with args "https://…", "notepad", "explorer"); list_windows and focus_window switch windows; key presses shortcuts ("ctrl+l", "alt+tab", "Return").',
    '- To run a command in an open PowerShell or terminal: focus_window it, type the command, then key "Return", then read the output on the next screenshot.',
    '- Every result ends with what the step did to the screen. When nothing changed, the step did not work: do not repeat it as it is. Look closer with zoom, check which window is in front (list_windows, focus_window), aim at the middle of the control, or use the keyboard.',
    '- The pointer is drawn in the screenshot: when a click missed, see where it landed and correct by that much.',
    '- zoom reads small text; switch_display looks at another monitor.',
    '- Ask the user first before anything hard to undo: sending a message or mail, deleting, buying or paying, submitting a form, closing a window with unsaved work, changing system settings.',
    '- The first action in a chat asks the user for permission on their phone; after that the chat may use the computer freely.',
  ].join('\n');
}

/** Said once with the first screenshot of a Linux computer: the prompt and the examples assume Windows. */
const LINUX_NOTE =
  'This computer runs Linux (an X11 desktop), not Windows: open takes a program\'s command ("firefox", "xfce4-terminal"), "terminal", "browser" or "files", a path or a URL; terminals paste with ctrl+shift+v.';

/** Said with the first screenshot of a chat's own desktop. */
const desktopNote = (name: string | undefined) =>
  `This is this chat's own Linux desktop on "${name ?? 'the computer'}" (X11), not the user's screen: nothing here is shared with them or with other chats. open takes "browser", "terminal", a program's command ("firefox", "xterm"), a path or a URL; terminals paste with ctrl+shift+v.`;

const FRESH_DESKTOP =
  'This is a freshly started desktop: the one from before was closed (unused for long, reset by the user, or the computer restarted), so the windows and programs that were open are gone. Its browser profile is kept.';

/** The same after the user removed the desktop with what it stored. */
const DELETED_DESKTOP =
  'This is a freshly started desktop: the user deleted the one from before together with its files, so the windows and programs that were open are gone and its browser starts with a new profile.';

type Pace = 'pointer' | 'click' | 'keys' | 'window' | 'open';
/** The pause before the screenshot for a helper that takes it at once. */
const SETTLE_MS: Record<Pace, number> = { pointer: 300, click: 600, keys: 500, window: 800, open: 1500 };
/** With a helper that waits for the screen itself: a short pause, then at most this long for the screen to stand still. */
const QUICK_MS: Record<Pace, number> = { pointer: 100, click: 250, keys: 200, window: 200, open: 300 };
const WAIT_MS: Record<Pace, number> = { pointer: 1000, click: 2500, keys: 2000, window: 2500, open: 5000 };

/** A step that left the screen as it was this many times in a row is not run again as it is. */
const REFUSE_AFTER = 3;
const STEPS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'scroll', 'type', 'key', 'hold_key', 'focus_window', 'minimize_window', 'maximize_window', 'restore_window', 'close_window', 'open']);

function stepOf(input: Input): Step | undefined {
  if (!STEPS.has(input.action)) return undefined;
  const points = [input.start_coordinate, input.coordinate].filter((p): p is Point => !!p);
  const text = [input.text, input.scroll_direction, input.scroll_amount, input.duration, input.window, input.target, input.args].map((v) => v ?? '').join('\u0001');
  return { action: input.action, points, text };
}

/** A click a few pixels beside the last one is the same click. */
const sameStep = (a: Step, b: Step) =>
  a.action === b.action && a.text === b.text && a.points.length === b.points.length && a.points.every((p, i) => Math.abs(p[0] - b.points[i]![0]) <= 12 && Math.abs(p[1] - b.points[i]![1]) <= 12);

/** A screenshot next to the one before it. */
type Seen = { kind: 'same' | 'little' | 'changed' | 'unknown'; box?: Rect };

function compare(r: ComputerResult, previous: string | undefined): Seen {
  if (r.change) return r.change.box ? { kind: r.change.fraction < 0.005 ? 'little' : 'changed', box: r.change.box } : { kind: 'same' };
  // A helper that does not compare: the very same picture still means nothing changed.
  return previous !== undefined && r.image?.dataBase64 === previous ? { kind: 'same' } : { kind: 'unknown' };
}

/** Whether the screen answered the step. A caret blinking or a clock ticking somewhere else is not an answer to a click. */
function reacted(seen: Seen, step: Step): boolean {
  if (seen.kind === 'same') return false;
  const b = seen.box;
  const p = step.points.at(-1);
  if (seen.kind !== 'little' || !b || !p || b.width * b.height > 2500) return true;
  return p[0] >= b.x - 80 && p[0] <= b.x + b.width + 80 && p[1] >= b.y - 80 && p[1] <= b.y + b.height + 80;
}

function advice(step: Step): string {
  if (step.action.endsWith('_click')) return 'Check the target first: zoom in on it, make sure its window is in front (list_windows, focus_window) and nothing covers it, then click its middle; or use the keyboard (Tab, Return, a shortcut).';
  if (step.action === 'left_click_drag') return 'Check both ends with zoom; some things only move with left_mouse_down, mouse_move, left_mouse_up.';
  if (step.action === 'scroll') return 'The view is at its end in that direction, or the pointer is not over the part that scrolls: scroll with coordinate inside the list or page, or use Page_Down, End or Home.';
  if (step.action === 'open') return 'It may still be starting, or be open behind another window: list_windows and focus_window it rather than opening it again.';
  if (step.action.endsWith('_window')) return 'list_windows shows the windows and their state; pick the window by its handle.';
  return 'Keys go to the window and the field that have the focus: click the field first, or focus_window the right window.';
}

const short = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const pt = (c: unknown) => (Array.isArray(c) && c.length === 2 ? `[${c.map((n) => Math.round(Number(n))).join(', ')}]` : '');

/** One line for the chat, the activity screen and a call: what this step does, e.g. "left click at [640, 360]". */
export function describeComputerStep(input: Record<string, unknown>): string {
  const a = String(input.action ?? '');
  const text = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ') : '';
  const at = input.coordinate ? ` at ${pt(input.coordinate)}` : '';
  switch (a) {
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
      return `${a.replace('_', ' ')}${at}${text ? ` with ${text}` : ''}`;
    case 'mouse_move':
      return `move the pointer${at.replace(' at', ' to')}`;
    case 'left_click_drag':
      return `drag ${pt(input.start_coordinate)} → ${pt(input.coordinate)}`;
    case 'left_mouse_down':
    case 'left_mouse_up':
      return `${a === 'left_mouse_down' ? 'press' : 'release'} the left button${at}`;
    case 'scroll':
      return `scroll ${input.scroll_direction ?? 'down'} ${input.scroll_amount ?? 3}${at}`;
    case 'type':
      return `type "${short(text)}"`;
    case 'key':
      return `press ${text}`;
    case 'hold_key':
      return `hold ${text} for ${input.duration ?? 1} s`;
    case 'wait':
      return `wait ${input.duration ?? 1} s`;
    case 'zoom':
      return `zoom in on ${Array.isArray(input.region) ? `[${input.region.join(', ')}]` : 'a region'}`;
    case 'cursor_position':
      return 'where is the pointer';
    case 'list_windows':
      return 'list windows';
    case 'open':
      return `open ${short(`${input.target ?? ''}${input.args ? ` ${input.args}` : ''}`)}`;
    case 'switch_display':
      return `look at display ${input.display ?? 0}`;
    default:
      return a.endsWith('_window') ? `${a.replace('_window', '')} window "${short(String(input.window ?? ''), 40)}"` : a;
  }
}

/** Consent text shown on the phone (and read out on a call) the first time a chat wants the computer. `desktop`: it asks for a desktop of its own there, not for the person's screen. */
export function computerConsent(pcName: string | undefined, desktop = false): string {
  if (desktop) return `Use a separate desktop on ${pcName ? `"${pcName}"` : 'your Linux computer'} in this chat: open programs there, see them, use the mouse and keyboard. Your own screen is not touched`;
  return `Control ${pcName ? `"${pcName}"` : 'your computer'} in this chat: see the screen, use the mouse and keyboard, open and close windows`;
}

function describeView(v: ScreenView): string {
  const d = v.displays[v.display];
  const count = v.displays.length;
  const where = count > 1 ? `display ${v.display} of ${count}${d?.primary ? ' (main)' : ''}` : 'the screen';
  const scale = d?.scale && d.scale !== 1 ? ` at ${Math.round(d.scale * 100)} %` : '';
  return `Screenshot of ${where}: ${v.width}x${v.height} px (the screen is ${v.region.width}x${v.region.height}${scale}). Coordinates are pixels of this picture.`;
}

export function formatWindows(windows: readonly WindowInfo[], displays: readonly Display[] | undefined): string {
  if (!windows.length) return 'No open windows.';
  const shown = windows.slice(0, 40);
  const lines = shown.map((w) => {
    const flags = [w.focused ? 'in front' : '', w.minimized ? 'minimized' : '', w.maximized ? 'maximized' : '', w.display !== undefined && (displays?.length ?? 0) > 1 ? `display ${w.display}` : '']
      .filter(Boolean)
      .join(', ');
    return `- "${w.title}" (${w.process || 'unknown'}), window ${w.handle}${flags ? `, ${flags}` : ''}`;
  });
  return [`${windows.length} windows, front to back:`, ...lines, ...(windows.length > shown.length ? [`… ${windows.length - shown.length} more`] : [])].join('\n');
}

/** Titles as people retype them: any dash is a hyphen, any space a space, case does not matter. */
const plain = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The window a user means: a handle (decimal, or hex as Linux tools print it), else the best fit by title and
 * program, the frontmost of equals: the exact title, the program by name, part of the title, part of the program
 * name, all the words in any order.
 */
export function pickWindow(windows: readonly WindowInfo[], query: string): WindowInfo | undefined {
  const raw = query.trim();
  if (!raw) return undefined;
  const handle = /^(?:window\s+)?(0x[0-9a-f]+|\d+)$/i.exec(raw)?.[1];
  if (handle) {
    const id = String(parseInt(handle, /^0x/i.test(handle) ? 16 : 10));
    const byHandle = windows.find((w) => w.handle === id);
    if (byHandle) return byHandle;
  }
  const q = plain(raw).replace(/^["'«“]+|["'»”]+$/g, '');
  if (!q) return undefined;
  const program = q.replace(/\.exe$/, '');
  const words = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let best: WindowInfo | undefined;
  let bestScore = 0;
  for (const w of windows) {
    const title = plain(w.title);
    const process = plain(w.process);
    const score =
      title === q ? 5
      : process === program ? 4
      : title.includes(q) ? 3
      : process.includes(program) ? 2
      : words.length && words.every((word) => title.includes(word) || process.includes(word)) ? 1
      : 0;
    if (score > bestScore) {
      best = w;
      bestScore = score;
    }
  }
  return best;
}

function unavailable(p: PcHandle): Result | null {
  if (!p.id) return fail('No computer with PocketClipboard is paired to this person. They can install PocketClipboard.exe on their Windows computer and pair it from the app.');
  if (!p.online) return fail(`The computer "${p.name}" is offline: PocketClipboard is not running or the computer is asleep.`);
  if (p.blocked) return fail(p.blocked);
  if (!p.capabilities.includes('computer')) return fail(`PocketClipboard on "${p.name}" is too old for computer use: the user needs to run the current PocketClipboard.exe there once.`);
  return null;
}

/** The computer and the screenshot bookkeeping one call works with. */
export interface ComputerTarget {
  pc: PcHandle;
  state: ComputerState;
}

/**
 * `opts.route` picks the computer and the bookkeeping for a call from what the call came with. A chat whose subagents
 * have desktops of their own uses it: each agent's steps then go to its own desktop and queue only behind its own.
 * It may refuse (throw): a call that cannot be attributed is not run on somebody's desktop on a guess.
 */
export function computerTools(
  pc: () => PcHandle,
  state: ComputerState,
  opts: { sleep?: (ms: number) => Promise<void>; route?: (extra: unknown) => Promise<ComputerTarget> } = {},
): SdkMcpToolDefinition<any>[] {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const run = async (p: PcHandle, state: ComputerState, input: Input): Promise<Result> => {
    let fresh = false;
    const act = async (action: ComputerAction): Promise<ComputerResult> => {
      // On a desktop of the chat's own, every step after the first look is meant for the desktop that look showed.
      const planned = p.desktop && action.action !== 'screenshot' && state.generation !== undefined ? { generation: state.generation } : undefined;
      const r = await p.computer(action, planned);
      if (r.code === 'workspace_stale') {
        // What the coordinates referred to is gone: the next step has to start from a new screenshot.
        state.reset();
        throw new Error(r.error ?? 'The desktop was started again since the last screenshot. Take a new screenshot first.');
      }
      if (r.error) throw new Error(r.error);
      const generation = p.desktop ? r.workspace?.generation : undefined;
      if (generation !== undefined) {
        if (state.generation !== undefined && state.generation !== generation) {
          // A screenshot (or the first step) started the desktop anew: nothing remembered of the old one applies.
          fresh = true;
          state.view = undefined;
          state.lastPicture = undefined;
          state.stuck = undefined;
          state.held = false;
        }
        state.generation = generation;
      }
      return r;
    };
    const picture = (r: { image: NonNullable<ComputerResult['image']> }, text: string): Result => ({
      content: [{ type: 'image', data: r.image.dataBase64, mimeType: r.image.mime }, { type: 'text', text }],
    });
    /**
     * Takes a screenshot and says what it shows next to the one before: `what` was just done, `pace` is how long that
     * kind of step takes to show, `step` is the step to hold to account when the screen did not answer it.
     */
    const look = async (what: string, pace?: Pace, step?: Step): Promise<Result> => {
      if (pace) await sleep(state.settles ? QUICK_MS[pace] : SETTLE_MS[pace]);
      const r = await act({ action: 'screenshot', display: state.display, ...(pace ? { settleMs: WAIT_MS[pace] } : {}) });
      if (!r.image || !r.region) throw new Error('The computer sent no picture');
      if (pace) state.settles = r.settled !== undefined;
      // The first look at a display has nothing to be compared with, whatever the helper remembers of it.
      const seen: Seen = state.view?.display === state.display ? compare(r, state.lastPicture) : { kind: 'unknown' };
      state.view = { display: state.display, region: r.region, width: r.image.width, height: r.image.height, displays: r.displays ?? state.view?.displays ?? [] };
      state.lastPicture = r.image.dataBase64;
      const notes: string[] = [];
      if (seen.kind === 'same') notes.push(step ? 'Nothing on the screen changed.' : 'Nothing on the screen changed since the last screenshot.');
      else if (seen.kind === 'little' && seen.box) notes.push(`Only a small part of the screen changed, around [${seen.box.x}, ${seen.box.y}, ${seen.box.x + seen.box.width}, ${seen.box.y + seen.box.height}].`);
      if (r.settled === false) notes.push('The screen was still changing when this picture was taken: wait and look again if it shows something half done.');
      if (step && !reacted(seen, step)) {
        const times = state.stuck && sameStep(state.stuck.step, step) ? state.stuck.times + 1 : 1;
        state.stuck = { step, times };
        notes.push(
          times === 1
            ? 'If the program may only be slow, wait and look again before repeating the step.'
            : `That is ${times} times in a row that this same step changed nothing${times >= REFUSE_AFTER ? ', so it will not be run again as it is' : ''}. ${advice(step)}`,
        );
      } else if (step || seen.kind === 'changed') {
        state.stuck = undefined;
      }
      if (fresh || state.closed) {
        notes.push(state.closed === 'deleted' ? DELETED_DESKTOP : FRESH_DESKTOP);
        fresh = false;
        state.closed = undefined;
      }
      if (!state.introduced) {
        state.introduced = true;
        if (p.desktop) notes.push(desktopNote(p.name));
        else if (/^linux/i.test(p.os ?? '')) notes.push(LINUX_NOTE);
      }
      return picture({ image: r.image }, [what, describeView(state.view), ...notes].filter(Boolean).join(' '));
    };
    const view = (): ScreenView => {
      if (!state.view) throw new Error('Take a screenshot first: coordinates are pixels of the latest screenshot.');
      return state.view;
    };
    const at = (c: Point | undefined, name = 'coordinate') => {
      if (!c) throw new Error(`${input.action} needs ${name} [x, y]`);
      return toDesktop(view(), c);
    };
    const needText = (what: string) => {
      if (!input.text) throw new Error(`${input.action} needs text: ${what}`);
      return input.text;
    };
    const modifiers = input.text ? input.text.split('+').map((s) => s.trim()).filter(Boolean) : undefined;
    const where = (c: Point | undefined) => (c ? `at [${Math.round(c[0])}, ${Math.round(c[1])}]` : 'where the pointer is');
    /** Looks at the display a window is on, so the screenshot after focusing it shows it. */
    const follow = async (handle: string | undefined): Promise<string> => {
      const r = await act({ action: 'windows' });
      if ((r.displays?.length ?? 0) < 2) return '';
      const w = handle ? r.windows?.find((x) => x.handle === handle) : r.windows?.find((x) => x.focused);
      if (!w || w.display === undefined || w.display === state.display) return '';
      state.display = w.display;
      return ` It is on display ${w.display}, which the screenshot now shows.`;
    };

    const step = stepOf(input);
    if (step && state.stuck && state.stuck.times >= REFUSE_AFTER && sameStep(state.stuck.step, step)) {
      return fail(
        `Not run: "${describeComputerStep(input)}" was done ${state.stuck.times} times in a row and the screen did not react to any of them, so once more will not help. ${advice(step)} If the step did work and only shows nowhere on this screen, go on with the next one.`,
      );
    }

    switch (input.action) {
      case 'screenshot':
        return look('');
      case 'zoom': {
        const v = view();
        if (!input.region) throw new Error('zoom needs region [x1, y1, x2, y2]');
        const [x1, y1, x2, y2] = input.region;
        // The region's edges, not pixel centres: [0, 0, width, height] is the whole screenshot.
        const left = Math.max(0, Math.min(x1, x2));
        const right = Math.min(v.width, Math.max(x1, x2));
        const top = Math.max(0, Math.min(y1, y2));
        const bottom = Math.min(v.height, Math.max(y1, y2));
        if (right - left < 2 || bottom - top < 2) throw new Error('zoom needs a region at least a few pixels across, inside the screenshot');
        const kx = v.region.width / v.width;
        const ky = v.region.height / v.height;
        const r = await act({
          action: 'zoom',
          x: v.region.x + Math.floor(left * kx),
          y: v.region.y + Math.floor(top * ky),
          width: Math.max(4, Math.ceil(right * kx) - Math.floor(left * kx)),
          height: Math.max(4, Math.ceil(bottom * ky) - Math.floor(top * ky)),
        });
        if (!r.image) throw new Error('The computer sent no picture');
        const times = Math.round((r.image.width / (right - left)) * 10) / 10;
        return picture(
          { image: r.image },
          `Close-up of [${x1}, ${y1}, ${x2}, ${y2}] of the screenshot, ${r.image.width}x${r.image.height} px, ${times} times larger. Keep using coordinates of the full screenshot for actions: a point at [a, b] of this close-up is at [${Math.round(left)} + a / ${times}, ${Math.round(top)} + b / ${times}] there.`,
        );
      }
      case 'cursor_position': {
        const r = await act({ action: 'cursor' });
        if (!r.cursor) throw new Error('The computer did not say where the pointer is');
        const inShot = state.view ? fromDesktop(state.view, r.cursor) : undefined;
        return ok(inShot ? `The pointer is at [${inShot[0]}, ${inShot[1]}] in the screenshot.` : 'The pointer is not on the display of the latest screenshot; take a screenshot to find it.');
      }
      case 'wait': {
        const s = Math.min(30, input.duration ?? 1);
        await sleep(s * 1000);
        return look(`Waited ${s} s.`);
      }
      case 'mouse_move': {
        await act({ action: 'move', ...at(input.coordinate) });
        return look(`Moved the pointer ${where(input.coordinate)}.`, 'pointer');
      }
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        const button = input.action === 'right_click' ? 'right' : input.action === 'middle_click' ? 'middle' : 'left';
        const count = input.action === 'double_click' ? 2 : input.action === 'triple_click' ? 3 : 1;
        const target = input.coordinate ? at(input.coordinate) : undefined;
        await act({ action: 'click', ...(target ?? {}), button, count, ...(modifiers ? { modifiers } : {}) });
        return look(`${input.action.replace('_', ' ')} ${where(input.coordinate)}${modifiers ? ` with ${input.text}` : ''}.`, 'click', step);
      }
      case 'left_click_drag': {
        const from = at(input.start_coordinate, 'start_coordinate');
        const to = at(input.coordinate);
        await act({ action: 'drag', path: [[from.x, from.y], [to.x, to.y]], button: 'left' });
        return look(`Dragged from ${where(input.start_coordinate).slice(3)} to ${where(input.coordinate).slice(3)}.`, 'click', step);
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        if (input.coordinate) await act({ action: 'move', ...at(input.coordinate) });
        const down = input.action === 'left_mouse_down';
        await act({ action: 'button', button: 'left', down });
        state.held = down;
        return down ? ok('The left button is held down; move with mouse_move, then left_mouse_up.') : look('Let go of the left button.', 'click');
      }
      case 'scroll': {
        const dir = input.scroll_direction ?? 'down';
        const n = input.scroll_amount ?? 3;
        const target = input.coordinate ? at(input.coordinate) : undefined;
        await act({ action: 'scroll', ...(target ?? {}), dx: dir === 'right' ? n : dir === 'left' ? -n : 0, dy: dir === 'down' ? n : dir === 'up' ? -n : 0, ...(modifiers ? { modifiers } : {}) });
        return look(`Scrolled ${dir} by ${n} ${where(input.coordinate)}.`, 'pointer', step);
      }
      case 'type': {
        const text = needText('what to type');
        await act({ action: 'type', text });
        return look(`Typed ${text.length} characters.`, 'keys', step);
      }
      case 'key': {
        const keys = needText('keys such as "ctrl+s" or "Return"');
        await act({ action: 'key', keys });
        return look(`Pressed ${keys}.`, 'keys', step);
      }
      case 'hold_key': {
        const keys = needText('keys to hold');
        const ms = Math.min(10_000, Math.round((input.duration ?? 1) * 1000));
        await act({ action: 'key', keys, holdMs: ms });
        return look(`Held ${keys} for ${ms / 1000} s.`, 'pointer', step);
      }
      case 'list_windows': {
        const r = await act({ action: 'windows' });
        return ok(formatWindows(r.windows ?? [], r.displays));
      }
      case 'focus_window':
      case 'minimize_window':
      case 'maximize_window':
      case 'restore_window':
      case 'close_window': {
        if (!input.window) throw new Error(`${input.action} needs window: a handle from list_windows or part of the title`);
        const list = (await act({ action: 'windows' })).windows ?? [];
        const w = pickWindow(list, input.window);
        if (!w) throw new Error(`No window matches "${input.window}". ${formatWindows(list, undefined)}`);
        const op = input.action.replace('_window', '') as 'focus' | 'minimize' | 'maximize' | 'restore' | 'close';
        const r = await act({ action: 'window', handle: w.handle, op });
        const moved = op === 'minimize' || op === 'close' ? '' : await follow(w.handle);
        return look(`${op} "${w.title}": ${r.text ?? 'done.'}${moved}`, 'window', step);
      }
      case 'open': {
        if (!input.target) throw new Error('open needs target: a program, file, folder or URL');
        const r = await act({ action: 'open', target: input.target, ...(input.args ? { args: input.args } : {}) });
        // Only worth a question when there is, or may be, a second display for the new window to be on.
        const moved = (state.view?.displays.length ?? 2) > 1 ? await follow(undefined) : '';
        return look(`${r.text ?? `Opened ${input.target}.`}${moved}`, 'open', step);
      }
      case 'switch_display': {
        if (input.display === undefined) throw new Error('switch_display needs display: the index of a display');
        const count = state.view?.displays.length ?? 0;
        if (count && input.display >= count) throw new Error(`There is no display ${input.display}: this computer has ${count} (0 to ${count - 1}).`);
        const before = state.display;
        state.display = input.display;
        try {
          return await look('');
        } catch (e) {
          state.display = before;
          throw e;
        }
      }
    }
  };

  return [
    tool(COMPUTER_TOOL, DESCRIPTION, SHAPE, (input, extra) => {
      /** Steps of one desktop run one after another; another desktop's steps do not wait for them. */
      const queued = (own: ComputerState, target: () => PcHandle): Promise<Result> => {
        const turn = async (): Promise<Result> => {
          const p = target();
          const down = unavailable(p);
          if (down) return down;
          try {
            return await run(p, own, input as Input);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        };
        own.busy++;
        const result = own.queue.then(turn, turn).finally(() => {
          own.busy--;
        });
        own.queue = result.catch(() => undefined);
        return result;
      };
      if (!opts.route) return queued(state, pc);
      return opts.route(extra).then(
        (target) => queued(target.state, () => target.pc),
        (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
      );
    }),
  ];
}
