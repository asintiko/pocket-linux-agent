import { z } from 'zod';
import { workspaceIdSchema } from './messages.js';

/**
 * What PocketClipboard and the VS Code extension agree on, on one Linux login, about that login's per-chat desktops.
 * PocketClipboard owns the desktops and writes these files; the extension only reads them, to run a chat's commands
 * inside the chat's desktop. Nothing here travels over the relay: a display number or a cookie path is never taken
 * from a message.
 */

/** Under the home directory; the folder and everything in it is the owner's alone (0700 / 0600). */
export const WORKSPACE_ROOT_SEGMENTS = ['.pocket-clipboard', 'workspaces'] as const;
/** In the root: the random name of this login that both devices report as `workspaceHost`. */
export const WORKSPACE_HOST_FILE = 'host-id';
/** In a desktop's folder while it runs. */
export const WORKSPACE_LIVE_FILE = 'live.json';

export const workspaceProcessSchema = z.object({
  pid: z.number().int().positive(),
  /** Start time from /proc/<pid>/stat: a recycled pid has another one. */
  start: z.string().regex(/^\d{1,20}$/),
});
export type WorkspaceProcess = z.infer<typeof workspaceProcessSchema>;

export const workspaceLiveSchema = z.object({
  v: z.literal(1),
  id: workspaceIdSchema,
  generation: z.number().int().positive(),
  display: z.string().regex(/^:\d{1,5}$/),
  /** The X server: the desktop lives exactly as long as this process does. */
  xserver: workspaceProcessSchema,
  /** Other processes the desktop consists of (session bus, window manager), for cleaning up after a crash. */
  processes: z.array(workspaceProcessSchema.extend({ role: z.string().max(20) })).max(8).optional(),
  /** Set on top of a command's own environment once the person's session variables are taken out of it. */
  env: z.record(z.string(), z.string()),
  /** Folders put in front of PATH: the desktop's browser wrappers. */
  path: z.array(z.string()).max(4),
  startedAt: z.number(),
});
export type WorkspaceLive = z.infer<typeof workspaceLiveSchema>;

/**
 * Variables that tie a process to the person's own graphical session. A chat's programs never inherit them: with
 * these gone a program can only reach a display it is given.
 */
export const HUMAN_SESSION_VARIABLES = [
  'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET',
  'SESSION_MANAGER', 'DESKTOP_STARTUP_ID', 'XDG_ACTIVATION_TOKEN', 'WINDOWID', 'WINDOWPATH',
  'XDG_SESSION_ID', 'XDG_SESSION_TYPE', 'XDG_SESSION_DESKTOP', 'XDG_CURRENT_DESKTOP', 'XDG_SEAT', 'XDG_VTNR',
  'DESKTOP_SESSION', 'GDMSESSION', 'KDE_FULL_SESSION', 'KDE_SESSION_VERSION', 'KDE_SESSION_UID', 'GNOME_DESKTOP_SESSION_ID',
  'GNOME_SETUP_DISPLAY', 'GNOME_TERMINAL_SCREEN', 'GNOME_TERMINAL_SERVICE',
  'KONSOLE_DBUS_SERVICE', 'KONSOLE_DBUS_SESSION', 'KONSOLE_DBUS_WINDOW', 'KONSOLE_VERSION',
  'SWAYSOCK', 'I3SOCK', 'HYPRLAND_INSTANCE_SIGNATURE', 'NIRI_SOCKET',
  'GDK_BACKEND', 'QT_QPA_PLATFORM', 'SDL_VIDEODRIVER', 'CLUTTER_BACKEND', 'MOZ_ENABLE_WAYLAND', 'ELECTRON_OZONE_PLATFORM_HINT',
] as const;

/** A socket name no compositor can have: toolkits that would look for the default Wayland socket find nothing. */
export const NO_WAYLAND = '/nonexistent/pocket-no-wayland';

/**
 * Makes toolkits use X11 only. Without a DISPLAY that means a graphical program cannot start at all, which is what a
 * command without a desktop must get: an error, never a window on the person's screen.
 */
export const X11_ONLY: Readonly<Record<string, string>> = {
  WAYLAND_DISPLAY: NO_WAYLAND,
  GDK_BACKEND: 'x11',
  QT_QPA_PLATFORM: 'xcb',
  SDL_VIDEODRIVER: 'x11',
  CLUTTER_BACKEND: 'x11',
  MOZ_ENABLE_WAYLAND: '0',
  ELECTRON_OZONE_PLATFORM_HINT: 'x11',
};

type Env = Record<string, string | undefined>;

/** The environment for a chat's command on Linux: the process's own, cut off from the person's session, inside `live` when there is one. */
export function chatCommandEnvironment(base: Env, live?: Pick<WorkspaceLive, 'env' | 'path'>): Record<string, string> {
  const drop = new Set<string>(HUMAN_SESSION_VARIABLES);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !drop.has(name)) env[name] = value;
  Object.assign(env, X11_ONLY);
  if (!live) return env;
  Object.assign(env, live.env);
  if (live.path.length) env.PATH = [...live.path, ...(env.PATH ? [env.PATH] : [])].join(':');
  return env;
}
