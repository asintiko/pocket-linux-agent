import { describe, expect, it } from 'vitest';
import {
  chatCommandEnvironment,
  HUMAN_SESSION_VARIABLES,
  innerMessageBodySchema,
  NO_WAYLAND,
  PEER_FEATURES,
  sessionEventSchema,
  SUBAGENT_MAX_RESULT,
  SUBAGENT_MAX_STEPS,
  WORKSPACE_ID_PATTERN,
  workspaceBindingSchema,
  workspaceLiveSchema,
} from '../src/index.js';

const ID = `ws_${'a'.repeat(26)}`;
const OTHER = `ws_${'b2'.repeat(13)}`;
const ok = (body: unknown) => innerMessageBodySchema.safeParse(body).success;

describe('desktop names and bindings', () => {
  it('accepts only names the brain derives', () => {
    for (const id of [ID, OTHER]) expect(WORKSPACE_ID_PATTERN.test(id)).toBe(true);
    for (const id of ['', ':0', ':101', 'localhost:0', '../ws', `ws_${'A'.repeat(26)}`, `ws_${'a'.repeat(25)}`, `ws_${'a'.repeat(27)}`, `ws_${'a'.repeat(25)}1`, `${ID}/..`, `/home/u/${ID}`]) {
      expect(WORKSPACE_ID_PATTERN.test(id)).toBe(false);
      expect(workspaceBindingSchema.safeParse({ id }).success).toBe(false);
    }
    expect(workspaceBindingSchema.parse({ id: ID, generation: 2, label: 'Fix the build', parent: OTHER })).toEqual({ id: ID, generation: 2, label: 'Fix the build', parent: OTHER });
    // A binding has no room for a display, a cookie or a port: whatever is added to it is dropped.
    expect(workspaceBindingSchema.parse({ id: ID, display: ':0', xauthority: '/home/u/.Xauthority', port: 5900 })).toEqual({ id: ID });
    expect(workspaceBindingSchema.safeParse({ id: ID, generation: 0 }).success).toBe(false);
    expect(workspaceBindingSchema.safeParse({ id: ID, parent: ':0' }).success).toBe(false);
  });

  it('tells a chat request from the phone own request, and accepts what older peers send', () => {
    expect(ok({ type: 'clipboard.read', payload: { requestId: 'r' } })).toBe(true);
    expect(ok({ type: 'clipboard.read', payload: { requestId: 'r', scope: 'host' } })).toBe(true);
    expect(ok({ type: 'clipboard.read', payload: { requestId: 'r', workspace: { id: ID } } })).toBe(true);
    expect(ok({ type: 'clipboard.read', payload: { requestId: 'r', scope: 'chat' } })).toBe(false);
    expect(ok({ type: 'screen.capture', payload: { requestId: 'r', workspace: { id: ':0' } } })).toBe(false);
    expect(ok({ type: 'computer.act', payload: { requestId: 'r', action: { action: 'screenshot' } } })).toBe(true);
    expect(ok({ type: 'computer.act', payload: { requestId: 'r', action: { action: 'screenshot' }, workspace: { id: ID, generation: 3 } } })).toBe(true);
    expect(ok({ type: 'computer.done', payload: { requestId: 'r', error: 'gone', code: 'workspace_stale' } })).toBe(true);
    expect(ok({ type: 'computer.done', payload: { requestId: 'r', error: 'gone', code: 'use_the_real_screen' } })).toBe(false);
    for (const op of ['ensure', 'status', 'capture', 'reset', 'delete', 'list']) expect(ok({ type: 'workspace.control', payload: { requestId: 'r', op, workspace: { id: ID } } })).toBe(true);
    expect(ok({ type: 'workspace.control', payload: { requestId: 'r', op: 'attach', workspace: { id: ID } } })).toBe(false);
    expect(ok({ type: 'workspace.state', payload: { requestId: 'r', workspace: { id: ID, generation: 1, state: 'running', display: ':101', width: 1280, height: 800 } } })).toBe(true);
  });

  it("carries a call's place as an opaque scope and a desktop name", () => {
    expect(ok({ type: 'tool.call', payload: { callId: 'c', name: 'run_command', args: {} } })).toBe(true);
    expect(ok({ type: 'tool.call', payload: { callId: 'c', name: 'run_command', args: {}, context: { scope: 'job_0123456789abcdef01234567', workspace: { id: ID, generation: 1 } } } })).toBe(true);
    expect(ok({ type: 'tool.call', payload: { callId: 'c', name: 'run_command', args: {}, context: { scope: 'job_0123456789abcdef01234567', workspace: { id: ID } } } })).toBe(false);
    expect(ok({ type: 'tool.call', payload: { callId: 'c', name: 'run_command', args: {}, context: { scope: '../other chat' } } })).toBe(false);
    expect(ok({ type: 'jobs.kill', payload: { scope: 'job_0123456789abcdef01234567' } })).toBe(true);
    expect(ok({ type: 'jobs.kill', payload: { scope: 'job_0123456789abcdef01234567', workspace: ID } })).toBe(true);
    expect(ok({ type: 'jobs.kill', payload: { scope: 'x' } })).toBe(false);
    expect(ok({ type: 'executor.status', payload: { workspaces: [], os: 'linux', shell: 'bash', capabilities: ['tools', 'workspace-env'], workspaceHost: 'ab12'.repeat(8) } })).toBe(true);
    expect(ok({ type: 'executor.status', payload: { workspaces: [], os: 'linux', shell: 'bash', workspaceHost: '../../etc/passwd' } })).toBe(false);
  });

  it('describes a running desktop on its own computer', () => {
    const live = { v: 1, id: ID, generation: 1, display: ':101', xserver: { pid: 4242, start: '123456' }, env: { DISPLAY: ':101' }, path: ['/home/u/.pocket-clipboard/workspaces/x/bin'], startedAt: 1 };
    expect(workspaceLiveSchema.safeParse(live).success).toBe(true);
    // A display on another machine or over TCP is not a desktop of this computer.
    for (const display of ['kali:1', 'localhost:10.0', ':1.0', '', 'unix:1']) expect(workspaceLiveSchema.safeParse({ ...live, display }).success).toBe(false);
    expect(workspaceLiveSchema.safeParse({ ...live, id: ':0' }).success).toBe(false);
    expect(workspaceLiveSchema.safeParse({ ...live, xserver: { pid: -1, start: '1' } }).success).toBe(false);
  });
});

describe('what the phone asks about desktops and subagents', () => {
  it('understands the workspace requests and their answers', () => {
    expect(ok({ type: 'status.get', payload: {} })).toBe(true);
    expect(ok({ type: 'status.get', payload: { features: [PEER_FEATURES.subagents, PEER_FEATURES.workspaces] } })).toBe(true);
    expect(ok({ type: 'workspace.get', payload: { requestId: 'r', sessionId: 's' } })).toBe(true);
    expect(ok({ type: 'workspace.preview', payload: { requestId: 'r', sessionId: 's', key: 'task-1' } })).toBe(true);
    expect(ok({ type: 'workspace.reset', payload: { requestId: 'r', sessionId: 's', wipe: true } })).toBe(true);
    expect(ok({ type: 'subagent.cancel', payload: { sessionId: 's', id: 'task-1' } })).toBe(true);
    expect(ok({ type: 'subagent.cancel', payload: { sessionId: 's', id: '' } })).toBe(false);
    expect(
      ok({
        type: 'workspace.result',
        payload: { requestId: 'r', sessionId: 's', supported: true, computer: { deviceId: 'd', name: 'kali', online: true }, desktops: [{ key: 'main', label: 'Chat', state: 'running', generation: 2, display: ':101' }, { key: 'task-1', label: 'Chat · check the page', state: 'none' }] },
      }),
    ).toBe(true);
    expect(ok({ type: 'workspace.result', payload: { requestId: 'r', sessionId: 's', supported: false, desktops: [], reason: 'This chat has no computer with PocketClipboard.' } })).toBe(true);
    expect(ok({ type: 'workspace.preview.result', payload: { requestId: 'r', sessionId: 's', key: 'main', image: { mime: 'image/jpeg', dataBase64: 'AAAA', width: 1280, height: 800 }, generation: 2 } })).toBe(true);
  });

  it('carries a child agent as a whole card within its limits', () => {
    const card = { kind: 'subagent', id: 'task-1', status: 'running', name: 'general-purpose', task: 'Check the page', toolUseId: 'toolu_1', activity: 'Read index.html', toolUses: 2, steps: [{ id: 'c1', tool: 'Read', summary: 'index.html', status: 'done' }], desktop: true, startedAt: 10 };
    expect(sessionEventSchema.safeParse(card).success).toBe(true);
    for (const status of ['starting', 'running', 'completed', 'failed', 'cancelled']) expect(sessionEventSchema.safeParse({ ...card, status }).success).toBe(true);
    expect(sessionEventSchema.safeParse({ ...card, status: 'done' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ ...card, id: '' }).success).toBe(false);
    const step = { id: 'c', tool: 'Bash', status: 'running' };
    expect(sessionEventSchema.safeParse({ ...card, steps: Array.from({ length: SUBAGENT_MAX_STEPS }, () => step) }).success).toBe(true);
    expect(sessionEventSchema.safeParse({ ...card, steps: Array.from({ length: SUBAGENT_MAX_STEPS + 1 }, () => step) }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ ...card, status: 'completed', result: 'x'.repeat(SUBAGENT_MAX_RESULT) }).success).toBe(true);
    expect(sessionEventSchema.safeParse({ ...card, status: 'completed', result: 'x'.repeat(SUBAGENT_MAX_RESULT + 1) }).success).toBe(false);
    expect(ok({ type: 'session.event', payload: { sessionId: 's', event: card } })).toBe(true);
  });
});

describe('the environment of a chat command on Linux', () => {
  const person = { PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8', DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', SESSION_MANAGER: 'local/kali:@/tmp/.ICE-unix/1', SWAYSOCK: '/run/user/1000/sway.sock', UNSET: undefined };

  it("takes the person's session out and forces X11, so a program without a desktop cannot open a window", () => {
    const env = chatCommandEnvironment(person);
    for (const name of HUMAN_SESSION_VARIABLES) {
      if (name in env) expect(['WAYLAND_DISPLAY', 'GDK_BACKEND', 'QT_QPA_PLATFORM', 'SDL_VIDEODRIVER', 'CLUTTER_BACKEND', 'MOZ_ENABLE_WAYLAND', 'ELECTRON_OZONE_PLATFORM_HINT']).toContain(name);
    }
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8', WAYLAND_DISPLAY: NO_WAYLAND, GDK_BACKEND: 'x11', QT_QPA_PLATFORM: 'xcb', SDL_VIDEODRIVER: 'x11', CLUTTER_BACKEND: 'x11', MOZ_ENABLE_WAYLAND: '0', ELECTRON_OZONE_PLATFORM_HINT: 'x11' });
    // The caller's environment object is not changed: nothing is set process-wide.
    expect(person.DISPLAY).toBe(':0');
  });

  it("puts the command inside the desktop it is given, with the desktop's programs first on PATH", () => {
    const env = chatCommandEnvironment(person, { env: { DISPLAY: ':104', XAUTHORITY: '/w/Xauthority', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/w/bus' }, path: ['/w/bin'] });
    expect(env).toMatchObject({ DISPLAY: ':104', XAUTHORITY: '/w/Xauthority', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/w/bus', PATH: '/w/bin:/usr/bin', WAYLAND_DISPLAY: NO_WAYLAND, HOME: '/home/u' });
    expect(chatCommandEnvironment({}, { env: { DISPLAY: ':104' }, path: ['/w/bin'] }).PATH).toBe('/w/bin');
  });
});
