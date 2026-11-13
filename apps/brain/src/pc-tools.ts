/* eslint-disable @typescript-eslint/no-explicit-any */
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, type ClipboardItem, type ComputerAction, type ComputerResult, type ScreenImage, type WorkspaceErrorCode, type WorkspaceInfo } from '@pocket/protocol';
import { z } from 'zod';

/** The user's own Windows computer with PocketClipboard on it, as a chat sees it; resolved on every use. */
export interface PcHandle {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly online: boolean;
  readonly capabilities: readonly string[];
  /** What the computer runs, as it reported it: "win32 10.0.22631", "linux 6.6.9-amd64". */
  readonly os?: string;
  /**
   * Set when the chat does not work on the person's own screen there but in a desktop of its own (a Linux computer
   * with per-chat desktops): everything below then addresses that desktop and nothing else. Which desktop that is,
   * is decided by the brain from the chat; no tool argument has a say in it.
   */
  readonly desktop?: { readonly key: string };
  /** Why the chat may not use this computer at all; every tool then says so instead of acting. */
  readonly blocked?: string;
  clipboardRead(): Promise<{ items?: ClipboardItem[]; error?: string; workspace?: WorkspaceInfo }>;
  clipboardWrite(item: ClipboardItem): Promise<{ error?: string; workspace?: WorkspaceInfo }>;
  screenshot(): Promise<{ image?: ScreenImage; error?: string; workspace?: WorkspaceInfo }>;
  /**
   * One computer-use step, in physical desktop pixels (the 'computer' capability). `generation` names the start of
   * the chat's desktop the step was planned on: if the desktop was started again since, the step comes back as
   * 'workspace_stale' and was not carried out.
   */
  computer(action: ComputerAction, opts?: { generation?: number }): Promise<ComputerResult & { error?: string; code?: WorkspaceErrorCode; workspace?: WorkspaceInfo }>;
}

export const PC_TOOL_NAMES = ['pc_clipboard_read', 'pc_clipboard_write', 'pc_screenshot'] as const;
export const PC_ALLOWED_TOOLS = PC_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`);

const isImageMime = (mime: string): mime is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' => /^image\/(png|jpeg|gif|webp)$/.test(mime);
const TEXT_LIMIT = 100_000;

type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });

/** What Claude is told about these tools, for every chat that has them. `desktop`: the chat works in a Linux desktop of its own there. */
export function pcToolsPrompt(pcName: string | undefined, desktop = false): string {
  if (desktop) {
    return [
      "# The screen and clipboard of this chat's desktop",
      `On "${pcName ?? 'the Linux computer'}" this chat works in a Linux desktop of its own (described below). mcp__pocket__pc_screenshot shows that desktop; mcp__pocket__pc_clipboard_read and mcp__pocket__pc_clipboard_write use its clipboard. None of them reaches the user's own screen or clipboard.`,
      'To hand the user a command or text for their own computer, put exactly that text in a single code block in your reply: their phone copies it to their computer with one tap. Use pc_clipboard_write for text you are about to paste inside the desktop yourself (ctrl+v, in terminals ctrl+shift+v).',
    ].join('\n');
  }
  const who = pcName ? `"${pcName}"` : 'their Windows computer (none is online right now)';
  return [
    '# The user\'s own computer',
    `The user has PocketClipboard on ${who}. mcp__pocket__pc_clipboard_read shows what they copied there, mcp__pocket__pc_clipboard_write puts text there for them to paste with Ctrl+V, mcp__pocket__pc_screenshot shows you their screens.`,
    'When they ask you to put a command or text "in the clipboard" / "in the buffer", call pc_clipboard_write with exactly the text to paste (no markdown fences) and confirm in one short sentence. When they ask what is on their screen or to look at something, take a screenshot and describe what matters.',
  ].join('\n');
}

/**
 * `pc` is asked on every call, with what the tool call came with: a chat whose subagents have desktops of their own
 * tells from that which desktop the call is for.
 */
export function pcTools(pc: (extra?: unknown) => PcHandle | Promise<PcHandle>): SdkMcpToolDefinition<any>[] {
  const offline = (p: PcHandle): Result | null => {
    if (!p.id) return fail('No computer with PocketClipboard is paired to this person. They can install PocketClipboard.exe and pair it from the app.');
    if (!p.online) return fail(`The computer "${p.name}" is offline: PocketClipboard is not running or the laptop is asleep.`);
    if (p.blocked) return fail(p.blocked);
    return null;
  };
  /** The computer the call is for, or the reason there is none: an unknown caller gets nothing rather than somebody's desktop. */
  const target = async (extra: unknown): Promise<PcHandle | Result> => {
    try {
      return await pc(extra);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
  const where = (p: PcHandle) => (p.desktop ? `this chat's desktop on "${p.name}"` : `"${p.name}"`);
  return [
    tool(
      'pc_clipboard_read',
      "Read what is on the clipboard of the user's Windows computer right now: text, an image (you will see it) or copied files.",
      {},
      async (_args, extra) => {
        const p = await target(extra);
        if ('content' in p) return p;
        const down = offline(p);
        if (down) return down;
        const r = await p.clipboardRead();
        if (r.error) return fail(`Clipboard read on ${where(p)} failed: ${r.error}`);
        const items = r.items ?? [];
        if (!items.length) return ok(`The clipboard of ${where(p)} is empty.`);
        const content: Result['content'] = [];
        for (const item of items) {
          if (item.kind === 'text') content.push({ type: 'text', text: item.text.length > TEXT_LIMIT ? `${item.text.slice(0, TEXT_LIMIT)}\n…[${item.text.length - TEXT_LIMIT} more characters]` : item.text });
          else if (item.kind === 'image' && isImageMime(item.mime)) content.push({ type: 'image', data: item.dataBase64, mimeType: item.mime });
          else if (item.kind === 'file') content.push({ type: 'text', text: `[Copied file: ${item.name}, ${item.mime}, ${item.size} bytes]` });
        }
        return { content: content.length ? content : [{ type: 'text', text: 'The clipboard holds data of a kind that cannot be shown.' }] };
      },
    ),
    tool(
      'pc_clipboard_write',
      "Put text on the clipboard of the user's Windows computer so they can paste it with Ctrl+V: a terminal command, code, a link. Pass exactly the text to paste, without markdown fences.",
      { text: z.string().min(1).max(1_000_000).describe('The exact text to put on the clipboard') },
      async ({ text }, extra) => {
        const p = await target(extra);
        if ('content' in p) return p;
        const down = offline(p);
        if (down) return down;
        const r = await p.clipboardWrite({ kind: 'text', text });
        if (r.error) return fail(`Clipboard write on ${where(p)} failed: ${r.error}`);
        if (p.desktop) return ok(`Put ${text.length} characters on the clipboard of ${where(p)}: paste them there with ctrl+v (in a terminal ctrl+shift+v). The user's own clipboard is untouched.`);
        return ok(`Put ${text.length} characters on the clipboard of "${p.name}". The user can paste them with Ctrl+V.`);
      },
    ),
    tool(
      'pc_screenshot',
      "Take a screenshot of all screens of the user's Windows computer and look at it. Use it when the user asks what is on their screen or wants you to check something they see.",
      {},
      async (_args, extra) => {
        const p = await target(extra);
        if ('content' in p) return p;
        const down = offline(p);
        if (down) return down;
        if (!p.capabilities.includes('screenshot')) return fail(`PocketClipboard on "${p.name}" is too old to take screenshots; the user needs to install the current PocketClipboard.exe.`);
        const r = await p.screenshot();
        if (r.error || !r.image) return fail(`Screenshot of ${where(p)} failed: ${r.error ?? 'no image'}`);
        return {
          content: [
            { type: 'image', data: r.image.dataBase64, mimeType: r.image.mime },
            {
              type: 'text',
              text: p.desktop
                ? `Screenshot of ${where(p)}, ${r.image.width}x${r.image.height}: the desktop of this chat alone, not the user's screen.`
                : `Screenshot of "${p.name}", ${r.image.width}x${r.image.height}, all monitors side by side.`,
            },
          ],
        };
      },
    ),
  ];
}
