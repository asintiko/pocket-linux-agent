import type { WorkspaceStatus } from '@pocket/client-core';
import type { Desktop } from '@pocket/protocol';
import { colors } from './theme';

export type DesktopState = Desktop['state'];

/** Key of the chat's own desktop; the others belong to its subagents and are keyed by their task id. */
export const MAIN_DESKTOP = 'main';

const NO_MAIN: Desktop = { key: MAIN_DESKTOP, label: 'This chat', state: 'none' };

/** The chat's own desktop first (it always exists, even before one has started), then its subagents'. */
export function listDesktops(desktops: readonly Desktop[] = []): Desktop[] {
  return [desktops.find((d) => d.key === MAIN_DESKTOP) ?? NO_MAIN, ...desktops.filter((d) => d.key !== MAIN_DESKTOP)];
}

/** The desktop with this key, else the chat's own. */
export function pickDesktop(desktops: readonly Desktop[] | undefined, key: string): Desktop {
  const list = listDesktops(desktops);
  return list.find((d) => d.key === key) ?? list[0] ?? NO_MAIN;
}

export function desktopStateLabel(state: DesktopState): string {
  switch (state) {
    case 'none':
      return 'None yet';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'stopped':
      return 'Closed';
    case 'failed':
      return 'Failed';
  }
}

export function desktopStateColor(state: DesktopState): string {
  switch (state) {
    case 'running':
      return colors.ok;
    case 'starting':
      return colors.accent;
    case 'failed':
      return colors.danger;
    case 'none':
    case 'stopped':
      return colors.textMuted;
  }
}

/** ":101 · start #3": where the desktop is on its computer and how often it was started; nothing before its first start. */
export function desktopDetail(desktop: Pick<Desktop, 'display' | 'generation'>): string {
  return [desktop.display, desktop.generation ? `start #${desktop.generation}` : undefined].filter(Boolean).join(' · ');
}

/** What the sheet says in place of a picture. */
export function desktopNote(desktop: Pick<Desktop, 'key' | 'state'>): string {
  const own = desktop.key === MAIN_DESKTOP;
  switch (desktop.state) {
    case 'running':
      return '';
    case 'starting':
      return 'The desktop is starting. The picture appears when it is ready.';
    case 'failed':
      return own
        ? 'The desktop stopped working. Close it to start over; the chat gets a fresh one when the agent next needs it.'
        : 'This desktop stopped working.';
    case 'stopped':
      return own ? 'This chat’s desktop is closed. A fresh one starts when the agent next needs it.' : 'This desktop is closed.';
    case 'none':
      return own ? 'This chat has no desktop running. One starts when the agent first needs it.' : 'This subagent has no desktop running.';
  }
}

/** "updated 3s ago" for a picture taken at `at`. */
export function previewAge(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function barLabel(state: DesktopState): string {
  switch (state) {
    case 'none':
      return 'Desktop not started';
    case 'starting':
      return 'Desktop starting';
    case 'running':
      return 'Desktop running';
    case 'stopped':
      return 'Desktop closed';
    case 'failed':
      return 'Desktop failed';
  }
}

export interface DesktopBar {
  /** The computer the desktops run on. */
  name: string | undefined;
  /** The chat's own desktop in words; a computer that is offline says so instead. */
  label: string;
  color: string;
  /** How many desktops besides the chat's own exist (its subagents'). */
  more: number;
}

/** What the chip under a chat's header shows. */
export function desktopBar(status: Pick<WorkspaceStatus, 'computer' | 'desktops'>): DesktopBar {
  const [main, ...others] = listDesktops(status.desktops);
  const state = main?.state ?? 'none';
  const offline = status.computer?.online === false;
  return {
    name: status.computer?.name,
    label: offline ? 'Computer offline' : barLabel(state),
    color: offline ? colors.textMuted : desktopStateColor(state),
    more: others.length,
  };
}
