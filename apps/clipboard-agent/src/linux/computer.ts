import type { ComputerBackend } from '../computer.js';
import type { HostCommand } from '../computer.js';
import type { ScreenBackend } from '../screenshot.js';

/** The Linux helpers speak the same JSON-line protocol as the Windows PowerShell host. */
export const LINUX_PYTHON = { command: 'python3', args: ['-u'] };

/**
 * X11 screenshots are taken with the overlay still visible. For synthetic input, the overlay's X11 input regions
 * become transparent briefly while its pixels stay mapped; the keyboard grab is released for the same interval.
 */
export function linuxThroughMsFor(c: HostCommand): number | undefined {
  switch (c.op) {
    case 'screenshot':
      return 1000 + (c.settleMs ?? 0);
    case 'zoom':
      return undefined;
    case 'click':
      return 450 + 110 * Math.max(1, c.count);
    case 'button':
      return c.down ? 15_000 : 400;
    case 'scroll':
      return 500 + 30 * (Math.abs(c.dx) + Math.abs(c.dy));
    case 'drag':
      return 900 + 1000 * Math.max(1, c.path.length / 2 - 1);
    case 'type':
      // Characters the layout lacks are put on spare keys first, a pause each time.
      return Math.min(120_000, 1500 + c.text.length * 12);
    case 'keys':
      return Math.min(240_000, Math.max(1000, c.combos.length * (c.holdMs + 150) + 500));
    case 'release':
      return 0;
    default:
      return undefined;
  }
}

/** The small pc_screenshot tool shares the persistent Linux computer helper. */
export function linuxScreen(computer: ComputerBackend): ScreenBackend {
  return {
    capture: async () => {
      const result = await computer.act({ action: 'screenshot' });
      if (!result.image) throw new Error('The Linux screenshot helper returned no picture.');
      return result.image;
    },
  };
}
