import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface WindowHostOptions<TOp, TEvent> {
  /** PowerShell script to run; the caller writes it to disk. */
  script: string;
  /** What the log calls this window: "overlay", "blocker". */
  label: string;
  /** Full redraw sent to every fresh window process. */
  snapshot: () => TOp;
  log: (m: string) => void;
  onEvent?: (e: TEvent) => void;
  spawn?: typeof nodeSpawn;
  /** Interpreter and its leading arguments; the script path is appended. Defaults to Windows PowerShell 5.1. */
  shell?: { command: string; args: string[] };
  /** How many crashes in a row before giving up. A lock screen comes back however often it is killed. */
  maxCrashes?: number;
}

const POWERSHELL = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File'] };
const HEALTHY_MS = 60_000;

/** Runs a window process and keeps it alive: ops go in as JSON lines on stdin, events come back on stdout. */
export class JsonWindow<TOp extends { op: string }, TEvent extends { ev: string }> {
  private child: ChildProcess | undefined;
  private stopped = false;
  private crashes = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: WindowHostOptions<TOp, TEvent>) {}

  start(): void {
    if (this.child || this.stopped) return;
    const spawn = this.opts.spawn ?? nodeSpawn;
    const shell = this.opts.shell ?? POWERSHELL;
    const child = spawn(shell.command, [...shell.args, this.opts.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.startedAt = Date.now();
    child.on('error', (e) => this.opts.log(`${this.opts.label}: ${e.message}`));
    child.stdin?.on('error', () => {});
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    if (child.stderr) createInterface({ input: child.stderr }).on('line', (line) => line.trim() && this.opts.log(`${this.opts.label}: ${line.trim()}`));
    child.on('exit', (code) => this.onExit(code));
    this.send(this.opts.snapshot());
  }

  send(op: TOp): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(op)}\n`);
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    this.send({ op: 'quit' } as TOp);
    const killer = setTimeout(() => child.kill(), 2000);
    child.once('exit', () => clearTimeout(killer));
  }

  private onLine(line: string): void {
    let ev: TEvent;
    try {
      ev = JSON.parse(line) as TEvent;
    } catch {
      this.opts.log(`${this.opts.label}: ${line}`);
      return;
    }
    if (ev.ev === 'error') this.opts.log(`${this.opts.label} error: ${(ev as unknown as { message?: string }).message ?? ''}`);
    this.opts.onEvent?.(ev);
  }

  private onExit(code: number | null): void {
    this.child = undefined;
    if (this.stopped) return;
    this.crashes = Date.now() - this.startedAt > HEALTHY_MS ? 1 : this.crashes + 1;
    if (this.crashes > (this.opts.maxCrashes ?? 5)) {
      this.opts.log(`${this.opts.label} keeps exiting (code ${code}); giving up until the agent restarts`);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (this.crashes - 1));
    this.opts.log(`${this.opts.label} exited (code ${code}); restarting in ${delay} ms`);
    this.restartTimer = setTimeout(() => this.start(), delay);
  }
}
