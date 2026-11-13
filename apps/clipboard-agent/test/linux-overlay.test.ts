import { execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const python = process.env.POCKET_PYTHON ?? 'python3';
const testDir = path.resolve('apps/clipboard-agent/test');
const fixture = path.join(testDir, 'fixtures/linux-overlay-regression.py');
const workspace = path.resolve(testDir, '../../../..');
const requiredCommands = ['Xvfb', 'xdotool', 'wmctrl', 'xrandr', 'xprop', 'xwininfo'];

function commandAvailable(command: string): boolean {
  return spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], { timeout: 1000 }).status === 0;
}

const skipReason = (() => {
  if (process.platform !== 'linux') return 'requires Linux/X11';

  const missingCommands = requiredCommands.filter((command) => !commandAvailable(command));
  if (missingCommands.length) return `missing commands: ${missingCommands.join(', ')}`;

  const modules = spawnSync(
    python,
    ['-B', '-c', 'import tkinter; from PIL import Image, ImageChops, ImageGrab, ImageTk; from Xlib import X, display; from Xlib.ext import composite, shape'],
    { encoding: 'utf8', timeout: 3000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  if (modules.error && 'code' in modules.error && modules.error.code === 'ENOENT') return `Python interpreter not found: ${python}`;
  if (modules.status !== 0) return `Python needs Tk, Pillow, and PyXlib (${modules.stderr.trim() || 'imports failed'})`;
  return undefined;
})();

describe('native Linux privacy overlay', () => {
  const nativeTest = skipReason ? it.skip : it;

  nativeTest(
    `keeps the locked overlay visible while input and screenshots reach the desktop${skipReason ? ` (skipped: ${skipReason})` : ''}`,
    () => {
      const output = execFileSync(python, ['-B', fixture], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 12_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      const result = JSON.parse(output) as {
        typedText: string;
        overlayMappedBeforeThrough: boolean;
        overlayMappedDuringThrough: boolean;
        overlayMappedAfterThrough: boolean;
        passesInputDuringThrough: boolean;
        interceptsInputAfterThrough: boolean;
        throughElapsedMs: number;
        dispatcherScreenshotUnderlay: boolean;
        underlayPixelBefore: number[];
        underlayPixelAfter: number[];
        overlayPixelBefore: number[];
        overlayPixelAfter: number[];
        inputOnlyRootChildMapped: boolean;
        entryChangedPixels: number;
        errorEvents: unknown[];
      };

      expect(result.typedText).toBe('Automation remains active');
      expect(result.overlayMappedBeforeThrough).toBe(true);
      expect(result.overlayMappedDuringThrough).toBe(true);
      expect(result.overlayMappedAfterThrough).toBe(true);
      expect(result.passesInputDuringThrough).toBe(true);
      expect(result.interceptsInputAfterThrough).toBe(true);
      expect(result.throughElapsedMs).toBeLessThan(6000);
      expect(result.dispatcherScreenshotUnderlay).toBe(true);
      expect(result.underlayPixelAfter).toEqual(result.underlayPixelBefore);
      expect(result.overlayPixelAfter).toEqual(result.overlayPixelBefore);
      expect(result.inputOnlyRootChildMapped).toBe(true);
      expect(result.entryChangedPixels).toBeGreaterThan(100);
      expect(result.errorEvents).toEqual([]);
    },
    15_000,
  );
});
