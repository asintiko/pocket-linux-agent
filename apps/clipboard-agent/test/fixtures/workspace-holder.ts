// Stands in for a PocketClipboard that is killed outright while a chat's desktop is running: it starts one desktop,
// prints the record of it, and waits to be killed. Bundled and run as its own process by workspaces.test.ts.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { WORKSPACE_LIVE_FILE } from '@pocket/protocol';
import { WorkspaceManager } from '../../src/linux/workspaces.js';

const [root, helperScript, id, mode, open] = process.argv.slice(2);
if (!root || !helperScript || !id) throw new Error('usage: workspace-holder <root> <helper> <desktop> [orphan|tied] [program to open on the desktop]');

const manager = new WorkspaceManager({
  root,
  helperScript,
  log: () => {},
  // 'orphan': without setpriv the kernel does not end the desktop with this process, as on a system that lacks it.
  ...(mode === 'orphan' ? { commands: { setpriv: '/nonexistent/setpriv' } } : {}),
});
manager
  .use({ id })
  // What a chat does with its computer tool: a program opened on the desktop, started by the desktop's helper.
  .then(async (desktop) => void (open && (await desktop.computer.act({ action: 'open', target: open }))))
  .then(
    () => process.stdout.write(`${readFileSync(path.join(root, id, WORKSPACE_LIVE_FILE), 'utf8')}\n`),
    (e: unknown) => {
      process.stdout.write(`${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n`);
      process.exit(1);
    },
  );
setInterval(() => {}, 1000);
