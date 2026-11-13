import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComputerBackend } from '../src/computer.js';
import { parseUriList } from '../src/linux/clipboard.js';
import { linuxScreen, linuxThroughMsFor } from '../src/linux/computer.js';

const linuxDir = path.resolve('apps/clipboard-agent/src/linux');
const python = process.env.POCKET_PYTHON ?? 'python3';
const hasPython = (() => {
  try {
    execFileSync(python, ['-c', '1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const runPython = (code: string) => execFileSync(python, ['-c', code], { encoding: 'utf8' }).trim();
const loader = (name: string) => `import importlib.util,sys\nsys.path.insert(0, ${JSON.stringify(linuxDir)})\nspec=importlib.util.spec_from_file_location('${name}', ${JSON.stringify(path.join(linuxDir, `${name}.py`))})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n`;

describe('Linux computer use', () => {
  it('steps the X11 lock aside for injected keyboard input and screenshots', () => {
    expect(linuxThroughMsFor({ op: 'screenshot', display: -1, maxWidth: 1280, maxHeight: 800, settleMs: 0 })).toBe(1000);
    // Waiting for the screen to stand still, a triple click, a long scroll and a drag all take longer than one click.
    expect(linuxThroughMsFor({ op: 'screenshot', display: -1, maxWidth: 1280, maxHeight: 800, settleMs: 2500 })).toBe(3500);
    expect(linuxThroughMsFor({ op: 'click', x: 1, y: 2, at: true, button: 'left', count: 1, mods: [], modNames: [] })).toBe(560);
    expect(linuxThroughMsFor({ op: 'click', x: 1, y: 2, at: true, button: 'left', count: 3, mods: [], modNames: [] })).toBe(780);
    expect(linuxThroughMsFor({ op: 'scroll', x: 1, y: 2, at: true, dx: 0, dy: -30, mods: [], modNames: [] })).toBe(1400);
    expect(linuxThroughMsFor({ op: 'drag', path: [1, 2, 3, 4, 5, 6], button: 'left' })).toBe(2900);
    expect(linuxThroughMsFor({ op: 'type', text: 'hi' })).toBe(1524);
    expect(linuxThroughMsFor({ op: 'keys', combos: [[17, 67]], holdMs: 0, names: [['ctrl', 'c']] })).toBe(1000);
    expect(linuxThroughMsFor({ op: 'cursor' })).toBeUndefined();
    expect(linuxThroughMsFor({ op: 'release' })).toBe(0);
  });

  it('uses the same helper for the small screenshot tool', async () => {
    const image = { mime: 'image/jpeg', dataBase64: 'QUJD', width: 10, height: 20 };
    let action = '';
    const backend: ComputerBackend = {
      act: async (a) => {
        action = a.action;
        return { image };
      },
      release: () => {},
      close: () => {},
    };
    expect(await linuxScreen(backend).capture()).toEqual(image);
    expect(action).toBe('screenshot');
  });

  it('parses X11 clipboard file lists', () => {
    expect(parseUriList('# comment\nfile:///home/user/a%20b.txt\nfile:///tmp/x.pdf\nhttps://example.com\n/plain/path\n')).toEqual(['/home/user/a b.txt', '/tmp/x.pdf', '/plain/path']);
  });

  /** Runs Python against the helper module `m` and reads back what it printed as JSON. */
  const helper = <T>(code: string): T => JSON.parse(runPython(`${loader('computer')}import json\n${code}`)) as T;

  it.skipIf(!hasPython)('parses xrandr, xwininfo and xprop output without an X server', () => {
    const monitors = helper<{ index: number; primary: boolean; width: number }[]>(`print(json.dumps(m.parse_monitors('''Monitors: 2\n 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1\n 1: +HDMI-1 1280/520x1024/290+1920+0  HDMI-1\n''')))`);
    expect(monitors).toHaveLength(2);
    expect(monitors[0]).toMatchObject({ index: 0, primary: true, width: 1920 });
    expect(monitors[1]).toMatchObject({ index: 1, primary: false });

    // A title with quotes and a class with a space in it, both of which used to shift wmctrl's columns.
    const tree = `     0x600003 "GTK проба": ("gtkapp.py" "Gtkapp.py")  520x300+1+20  +301+520\n        0x20001a "say \\"hi\\" 10x20+1+2": ("tkapp #2" "Tkapp")  500x400+1+20  +-1500+120\n     0x40000a (has no name): ()  1x1+0+0  +0+0`;
    const places = helper<Record<string, { x: number; y: number; width: number; height: number }>>(`print(json.dumps(m.parse_tree(${JSON.stringify(tree)})))`);
    expect(places[String(0x600003)]).toEqual({ x: 301, y: 520, width: 520, height: 300 });
    expect(places[String(0x20001a)]).toEqual({ x: -1500, y: 120, width: 500, height: 400 });
    // The frame the window manager adds counts as the window; a toolkit's own shadow does not.
    expect(helper(`print(json.dumps([m.outline({'x':301,'y':520,'width':520,'height':300},[1,1,20,5],[]), m.outline({'x':10,'y':10,'width':100,'height':100},[],[26,26,23,29])]))`)).toEqual([
      { x: 300, y: 500, width: 522, height: 325 },
      { x: 36, y: 33, width: 48, height: 48 },
    ]);

    const props = `_NET_WM_NAME(UTF8_STRING) = "Отчёт \\"Q3\\" — Mousepad"\nWM_CLASS(STRING) = "tkapp #2", "Tkapp"\n_NET_WM_PID(CARDINAL) = 1234\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ\n_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x40001a, 0x60001a\nWM_TRANSIENT_FOR:  not found.`;
    const parsed = helper<{ props: Record<string, string>; title: string; octal: string; ids: number[] }>(
      `p=m.parse_xprop(${JSON.stringify(props)})\nprint(json.dumps({'props':p,'title':m.unquote(p['_NET_WM_NAME']),'octal':m.unquote('"\\\\320\\\\221\\\\320\\\\265\\\\321\\\\202\\\\320\\\\260"'),'ids':m.window_ids(p['_NET_CLIENT_LIST_STACKING'])}, ensure_ascii=False))`,
    );
    expect(parsed.title).toBe('Отчёт "Q3" — Mousepad');
    // In a locale without UTF-8 xprop prints the bytes in octal.
    expect(parsed.octal).toBe('Бета');
    expect(parsed.ids).toEqual([0x40001a, 0x60001a]);
    expect(parsed.props.WM_CLASS).toBe('"tkapp #2", "Tkapp"');
    expect(parsed.props.WM_TRANSIENT_FOR).toBeUndefined();
  });

  it.skipIf(!hasPython)('turns every way of writing a key into the name X11 knows it by', () => {
    const names = ['backspace', 'Backspace', 'ESC', 'Tab', 'f5', 'F12', 'up', 'ArrowDown', 'Space', 'page-down', 'PgUp', 'kp_enter', 'KP_7', 'Ctrl', 'altgr', 'cmd', 'A', 'z', '7', '+', '/', 'plus', 'ё', 'volume_up', 'hyper'];
    expect(helper(`print(json.dumps([m.key_name(n) for n in ${JSON.stringify(names)}]))`)).toEqual([
      'BackSpace', 'BackSpace', 'Escape', 'Tab', 'F5', 'F12', 'Up', 'Down', 'space', 'Next', 'Prior', 'KP_Enter', 'KP_7', 'Control_L', 'ISO_Level3_Shift', 'Super_L', 'a', 'z', '7', 'plus', 'slash', 'plus', 'U0451',
      'XF86AudioRaiseVolume', null,
    ]);
    // Names first; a name this table lacks falls back to the code the agent sent with it; codes alone work too.
    const combos = helper(`print(json.dumps([m.combos_for({'names':[['Ctrl','A'],['nosuch']],'combos':[[17,65],[0x2e|0x100]]}), m.combos_for({'combos':[[0x5b|0x100,0x45],[0x10000|0x2f]]}), m.modifiers_for({'modNames':['Shift'],'mods':[16]})]))`);
    expect(combos).toEqual([[['Control_L', 'a'], ['Delete']], [['Super_L', 'e'], ['slash']], ['Shift_L']]);
    expect(() => runPython(`${loader('computer')}m.combos_for({'names':[['nosuch']]})`)).toThrow(/Unknown key/);
  });

  it.skipIf(!hasPython)('puts characters the layout lacks on spare keys, two to a key, and reuses its own', () => {
    const dump = 'keycode   8 =\nkeycode  38 = a A Cyrillic_ef Cyrillic_EF\nkeycode  93 =\nkeycode 248 =\nkeycode 250 = U0436 U044F U0436 U044F\nkeycode 255 =';
    const plan = helper<{ layout: Record<string, string>; free: number[]; first: [number, string][]; again: [number, string][]; chunks: [string, string[]][]; native: boolean[] }>(
      [
        `layout=m.keyboard_layout(${JSON.stringify(dump)})`,
        `borrowed={250:('жя','U0436 U044F U0436 U044F')}`,
        `print(json.dumps({'layout':layout,'free':m.free_keys(layout),`,
        ` 'first':m.assign_keys(set('жмир'),layout,borrowed),`,
        ` 'again':m.assign_keys(set('эюя'),layout,borrowed),`,
        ` 'chunks':[[c,sorted(n)] for c,n in m.typing_chunks('ab жж мир!',2)],`,
        ` 'native':[m.needs_key('ф',{'ф'}),m.needs_key('ж',{'ф'}),m.needs_key('a'),m.needs_key('\\n')]}))`,
      ].join('\n'),
    );
    expect(plan.layout['38']).toBe('a A Cyrillic_ef Cyrillic_EF');
    // The lowest free key stays free: xdotool needs one to work with itself.
    expect(plan.free).toEqual([255, 248, 93]);
    // "ж" is on a borrowed key already, but that key also holds "я", which is not wanted: it is rewritten last.
    expect(plan.first).toEqual([[255, 'жи'], [248, 'мр']]);
    // A borrowed key counts only while everything on it is wanted; otherwise its characters are placed anew.
    expect(plan.again).toEqual([[255, 'эю'], [248, 'я']]);
    expect(plan.chunks).toEqual([['ab жж м', ['ж', 'м']], ['ир!', ['и', 'р']]]);
    expect(plan.native).toEqual([false, true, false, false]);
  });

  it.skipIf(!hasPython)('finds programs by the name on their menu entry', () => {
    const found = helper<{ exact: [string[], boolean]; word: [string[], boolean]; hidden: [string[], boolean]; none: null; rank: (number | null)[] }>(
      [
        'import tempfile, os',
        'd=tempfile.mkdtemp()',
        `open(os.path.join(d,'org.telegram.desktop.desktop'),'w').write('[Desktop Entry]\\nName=Telegram Desktop\\nName[ru]=Телеграм\\nExec=telegram-desktop -- %u\\n[Desktop Action Quit]\\nExec=telegram-desktop -quit\\n')`,
        `open(os.path.join(d,'htop.desktop'),'w').write('[Desktop Entry]\\nName=Htop\\nExec=htop\\nTerminal=true\\n')`,
        `open(os.path.join(d,'telegram-helper.desktop'),'w').write('[Desktop Entry]\\nName=Telegram\\nExec=tg-helper %F\\nNoDisplay=true\\n')`,
        `print(json.dumps({'exact':m.find_desktop_entry('телеграм',[d]),'word':m.find_desktop_entry('htop',[d]),'hidden':m.find_desktop_entry('Telegram',[d]),'none':m.find_desktop_entry('excel',[d]),`,
        ` 'rank':[m.match_rank('code',['Code']),m.match_rank('code',['Code - OSS']),m.match_rank('code',['Visual Studio Code']),m.match_rank('code',['Files'])]}, ensure_ascii=False))`,
      ].join('\n'),
    );
    // Field codes for files and addresses are dropped; the entry's other sections do not count.
    expect(found.exact).toEqual([['telegram-desktop', '--'], false]);
    expect(found.word).toEqual([['htop'], true]);
    // An entry kept off the menu loses to one that is on it.
    expect(found.hidden).toEqual([['telegram-desktop', '--'], false]);
    expect(found.none).toBeNull();
    expect(found.rank[0]).toBeLessThan(found.rank[1]!);
    expect(found.rank[1]).toBeLessThan(found.rank[2]!);
    expect(found.rank[3]).toBeNull();
  });

  it.skipIf(!hasPython)('reads KDE video wallpaper sources and handles Return across Xlib versions', () => {
    const kde = `${loader('blocker')}import tempfile,json\nfrom pathlib import Path\nwith tempfile.TemporaryDirectory() as d:\n p=Path(d)/'.config/plasma-org.kde.plasma.desktop-appletsrc'\n p.parent.mkdir(parents=True)\n p.write_text('[Containments][1][Wallpaper][smart][General]\\nLastVideo=file:///home/user/Видео/a b.mp4\\nVideoUrls=[{"filename":"file:///home/user/v.webm","enabled":true}]\\nImage=file:///home/user/p.png\\n')\n print(json.dumps(list(m.kde_wallpaper_candidates(d)),ensure_ascii=False))`;
    expect(JSON.parse(runPython(kde))).toEqual(['/home/user/Видео/a b.mp4', '/home/user/v.webm', '/home/user/p.png']);

    const enter = `${loader('blocker')}import queue,json\nfrom types import SimpleNamespace\nevents=queue.Queue()\nxi=m.XInput(events)\nxi.locked=True\nxi.x=SimpleNamespace(keycode_to_keysym=lambda code,index:0xff0d)\nxi.X=SimpleNamespace(KeyPress=2,KeyRelease=3,ShiftMask=1,Mod1Mask=8)\nxi.XK=SimpleNamespace(keysym_to_string=lambda sym:'\\r',string_to_keysym=lambda name:32)\nxi.handle(SimpleNamespace(type=2,detail=36,state=0))\nprint(events.get_nowait()[1]['kind'])`;
    expect(runPython(enter)).toBe('enter');
  });

  it.skipIf(!hasPython)('keeps both Python helpers syntactically valid and importable without GUI libraries', () => {
    for (const name of ['computer', 'blocker']) {
      const file = path.join(linuxDir, `${name}.py`);
      runPython(`import ast,pathlib\nast.parse(pathlib.Path(${JSON.stringify(file)}).read_text())\n${loader(name)}print('ok')`);
    }
  });

  it('has a syntactically valid Kali installer', () => {
    const file = path.resolve('apps/clipboard-agent/scripts/install-linux.sh');
    expect(readFileSync(file, 'utf8')).toContain('systemd');
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  });
});
