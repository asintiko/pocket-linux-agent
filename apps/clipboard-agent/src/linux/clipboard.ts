import { execFile, spawn } from 'node:child_process';
import type { ClipboardItem } from '@pocket/protocol';
import { filesToItems, MAX_ITEM_BYTES, type ClipboardBackend } from '../clipboard.js';

/** Converts a copied text/uri-list into local file names, ignoring comments and non-file URIs. */
export function parseUriList(text: string): string[] {
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const url = new URL(line);
      if (url.protocol !== 'file:') continue;
      paths.push(decodeURIComponent(url.pathname));
    } catch {
      // Some file managers write plain paths instead of URIs.
      if (line.startsWith('/')) paths.push(line);
    }
  }
  return paths;
}

function xclip(args: string[], input: Buffer | string | undefined, env: NodeJS.ProcessEnv | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'xclip',
      args,
      { maxBuffer: MAX_ITEM_BYTES + 1024 * 1024, encoding: 'buffer', ...(env ? { env } : {}) },
      (error, stdout) => (error ? reject(new Error(error.message)) : resolve(stdout)),
    );
    child.on('error', (e) => reject(new Error(`Could not run xclip: ${e.message}`)));
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/**
 * Puts data on the clipboard. xclip then stays behind as the owner of the selection, with the error pipe still open,
 * so this waits for the first xclip to exit, not for the pipes to close: that would only happen when something else
 * is copied.
 */
function xclipWrite(args: string[], input: Buffer | string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('xclip', args, { stdio: ['pipe', 'ignore', 'pipe'], ...(env ? { env } : {}) });
    let errors = '';
    child.stderr.on('data', (d: Buffer) => (errors = `${errors}${d.toString('utf8')}`.slice(-2000)));
    child.on('error', (e) => reject(new Error(`Could not run xclip: ${e.message}`)));
    child.stdin.on('error', () => {});
    child.on('exit', (code) => {
      child.stderr.destroy();
      if (code === 0) resolve();
      else reject(new Error(errors.trim().split('\n').pop() || `xclip exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

const selection = ['-selection', 'clipboard'];

/**
 * X11 clipboard: text, pictures and file-manager file lists. `env` names the display whose clipboard it is: a
 * per-chat desktop passes its own, and nothing given means the display this process was started in.
 */
export function createLinuxClipboard(env?: NodeJS.ProcessEnv): ClipboardBackend {
  const run = (args: string[]) => xclip(args, undefined, env);
  return {
    async read() {
      let targets: string;
      try {
        targets = (await run([...selection, '-t', 'TARGETS', '-o'])).toString('utf8');
      } catch (e) {
        // Nothing has been copied on this display yet: xclip reports that there is no owner of the selection.
        if (/target TARGETS not available|There is no owner/i.test(e instanceof Error ? e.message : String(e))) return [];
        throw e;
      }
      if (targets.includes('text/uri-list')) {
        const items = await filesToItems(parseUriList((await run([...selection, '-t', 'text/uri-list', '-o'])).toString('utf8')));
        if (items.length) return items;
      }
      const mime = targets.includes('image/png') ? 'image/png' : targets.includes('image/jpeg') ? 'image/jpeg' : undefined;
      if (mime) {
        const data = await run([...selection, '-t', mime, '-o']);
        return [{ kind: 'image', mime, dataBase64: data.toString('base64') }];
      }
      const text = (await run([...selection, '-t', 'UTF8_STRING', '-o'])).toString('utf8');
      return text ? [{ kind: 'text', text }] : [];
    },

    async write(item) {
      if (item.kind === 'text') {
        if (!item.text) throw new Error('Nothing to copy');
        await xclipWrite([...selection, '-i', '-t', 'UTF8_STRING'], item.text, env);
        return;
      }
      if (item.kind === 'file' && !item.mime.startsWith('image/')) throw new Error('Only text and pictures can go to the clipboard');
      const mime = item.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      await xclipWrite([...selection, '-i', '-t', mime], Buffer.from(item.dataBase64, 'base64'), env);
    },
  };
}

/** The clipboard of the display PocketClipboard itself runs in: the person's own. */
export const linuxClipboard: ClipboardBackend = createLinuxClipboard();
