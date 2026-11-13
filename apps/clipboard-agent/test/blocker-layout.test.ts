import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const linuxDir = path.resolve('apps/clipboard-agent/src/linux');
const python = process.env.POCKET_PYTHON ?? 'python3';
type Layout = {
  panel_height: number;
  avatar_size: number;
  card_left: number;
  card_top: number;
  card_right: number;
  card_bottom: number;
  avatar_left: number;
  username_x: number;
  field_left: number;
  field_top: number;
  field_width: number;
  field_height: number;
  field_padding: number;
  field_right: number;
  password_mask_limit: number;
  button_top: number;
  button_right: number;
  button_bottom: number;
};
const hasPython = (() => {
  try {
    execFileSync(python, ['-c', '1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const runBlocker = (body: string) => {
  const code = [
    'import importlib.util, json, sys',
    `sys.path.insert(0, ${JSON.stringify(linuxDir)})`,
    `spec=importlib.util.spec_from_file_location('blocker', ${JSON.stringify(path.join(linuxDir, 'blocker.py'))})`,
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    body,
  ].join('\n');
  return JSON.parse(execFileSync(python, ['-c', code], { encoding: 'utf8' }));
};

describe('Linux blocker greeter layout', () => {
  it.skipIf(!hasPython).each(
    [
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ].flatMap(({ width, height }) => [1, 1.25, 1.5, 2].map((scale) => ({ width, height, scale }))),
  )('fits greeter controls at $width×$height, scale $scale', ({ width, height, scale }) => {
    const layout = runBlocker(`print(json.dumps(module.greeter_layout(${width}, ${height}, ${scale})))`) as Layout;
    expect(layout.panel_height).toBe(Math.round(32 * scale));
    expect(layout.avatar_size).toBe(Math.round(80 * scale));
    expect(layout.field_width).toBe(Math.round(200 * scale));
    expect(layout.password_mask_limit).toBeGreaterThan(0);
    expect(layout.password_mask_limit * Math.round(12 * scale) + 2 * layout.field_padding).toBeLessThanOrEqual(layout.field_width);
    expect(layout.card_left).toBe(Math.floor((width - (layout.card_right - layout.card_left)) / 2));
    expect(layout.card_top).toBeGreaterThanOrEqual(layout.panel_height);
    expect(layout.card_right).toBeLessThanOrEqual(width);
    expect(layout.card_bottom).toBeLessThanOrEqual(height);
    expect(layout.avatar_left + layout.avatar_size).toBeLessThan(layout.field_left);
    expect(layout.username_x).toBe(layout.field_left);
    expect(layout.field_right).toBe(layout.button_right);
    expect(layout.button_bottom).toBeLessThanOrEqual(layout.card_bottom);
    expect(layout.button_top).toBeGreaterThan(layout.field_top + layout.field_height);
  });

  it.skipIf(!hasPython)('keeps escape-word input invisible and PIN submission unchanged', () => {
    const result = runBlocker(`
from types import SimpleNamespace
updates, events = [], []
module.emit = lambda event, **values: events.append({"ev": event, **values})
overlay = module.LockOverlay.__new__(module.LockOverlay)
overlay.primary = {"canvas": SimpleNamespace(itemconfigure=lambda item, **values: updates.append(values))}
overlay.password_text = 1
overlay.password_display_limit = module.greeter_layout(1366, 768)["password_mask_limit"]
overlay.locked, overlay.through = True, False
overlay.pin = overlay.word = ""
for letter in "pocket":
    overlay.on_input({"kind": "letter", "value": letter})
hidden_word = updates[-1]["text"]
overlay.on_input({"kind": "enter"})
for digit in "1805":
    overlay.on_input({"kind": "digit", "value": digit})
mask = updates[-1]["text"]
overlay.on_input({"kind": "backspace"})
backspace_mask = updates[-1]["text"]
overlay.on_input({"kind": "digit", "value": "5"})
overlay.on_input({"kind": "enter"})
print(json.dumps({"hidden_word": hidden_word, "mask": mask, "backspace_mask": backspace_mask, "reset": updates[-1]["text"], "events": events}))
`);
    expect(result).toEqual({
      hidden_word: 'Enter your password',
      mask: '●●●●',
      backspace_mask: '●●●',
      reset: 'Enter your password',
      events: [{ ev: 'word', text: 'pocket' }, { ev: 'pin', text: '1805' }],
    });
  });
});
