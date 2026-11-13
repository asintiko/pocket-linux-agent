/**
 * Acceptance run for subagents inside a chat: a real Claude Code process (the one the brain starts for a chat on a
 * Linux computer) delegates to real subagents with its Agent tool, and the phone watches their cards. The model
 * behind Claude Code is scripted (acceptance/scripted-model.ts) unless --live is given: no credentials are needed,
 * and what is proven is the runtime (attribution of tool calls to agents, task events, desktops of the children,
 * cancellation, history), not what a model would decide.
 *
 * From lx/:
 *   node --import tsx apps/clipboard-agent/scripts/subagents-acceptance.ts [--out <folder>] [--keep]
 *   node --import tsx apps/clipboard-agent/scripts/subagents-acceptance.ts --serve     keeps everything running for the phone app
 *   ANTHROPIC_API_KEY=… node --import tsx apps/clipboard-agent/scripts/subagents-acceptance.ts --live   a real model (never run so far)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SessionEvent, SubagentEvent } from '@pocket/protocol';
import { startScriptedModel, useScriptedModel, type Script, type ScriptedModel, type ScriptedReply, type ScriptedRequest } from './acceptance/scripted-model.js';
import { liveRecord, prepare, processesOf, running, sleep, startStack, until, workspaceDir, type Device } from './acceptance/stack.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const live = flag('live');

interface Check {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const notes: string[] = [];
let current = '';
const section = (title: string) => {
  current = title;
  console.log(`\n== ${title}`);
};
const show = (detail: unknown): string => (typeof detail === 'string' ? detail : (JSON.stringify(detail) ?? ''));
function check(name: string, ok: boolean, detail: unknown = ''): boolean {
  const text = show(detail).replace(/\s+/g, ' ').slice(0, 900);
  checks.push({ section: current, name, ok, detail: text });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !text ? '' : `\n      ${text}`}`);
  return ok;
}
const note = (text: string) => {
  notes.push(text);
  console.log(`      ${text}`);
};

// What the scripted model does. Subagents are told who they are in their task, so each can be given its own steps.
const TASKS = {
  one: 'Report the display of your desktop',
  two: 'Hold your desktop until you are stopped',
  three: 'Report after a short pause',
} as const;
const named = (request: ScriptedRequest, name: string) => request.tools.find((t) => t === name || t.endsWith(`__${name}`)) ?? name;
const delegate = (request: ScriptedRequest, who: keyof typeof TASKS, more: Record<string, unknown> = {}) => ({
  name: named(request, 'Agent'),
  input: { subagent_type: 'general-purpose', description: TASKS[who], prompt: `[[agent:${who}]] ${TASKS[who]}.`, ...more },
});
const script: Script = (request) => {
  if (request.who === 'main') {
    // Claude Code tells the parent of a subagent that ended with a notification of its own; the parent passes it on.
    const notified = /<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>(?:[\s\S]*?<result>([\s\S]*?)<\/result>)?/.exec(request.last);
    if (notified) return { text: `${notified[1]}${notified[2] ? `: ${notified[2]}` : '.'}` };
    if (request.toolResults.length) return { text: 'The helpers are at work. I will tell you what they report.' };
    const asked = /\[\[do:([a-z-]+)\]\]/.exec(request.last)?.[1];
    if (asked === 'delegate') return { text: 'I will hand this to two subagents.', tools: [delegate(request, 'one'), delegate(request, 'two')] };
    if (asked === 'background') return { text: 'I will start that in the background.', tools: [delegate(request, 'three', { run_in_background: true })] };
    return { text: 'Noted.' };
  }
  const screenshot = { tools: [{ name: named(request, 'computer'), input: { action: 'screenshot' } }] };
  const command = (line: string, timeout?: number) => ({ tools: [{ name: named(request, 'Bash'), input: { command: line, ...(timeout ? { timeout } : {}) } }] });
  const steps: Record<string, ScriptedReply[]> = {
    one: [screenshot, command('sleep 8; echo "subagent one sees display $DISPLAY"'), { text: `Subagent one finished. ${request.last.replace(/\s+/g, ' ').slice(0, 200)}` }],
    // Long enough for a person at the phone to stop it; a command without a time limit of its own ends after two minutes.
    two: [screenshot, command('sleep 900', 600_000), { text: 'Subagent two finished.' }],
    three: [command('sleep 10; echo "three is done"'), { text: 'Subagent three finished after its pause.' }],
  };
  return steps[request.who]?.[request.turn] ?? { text: `Subagent ${request.who} has nothing left to do.` };
};

const scratch = prepare(option('out'));
const started = Date.now();
let model: ScriptedModel | undefined;
if (!live) {
  model = await startScriptedModel(script);
  useScriptedModel(model);
}
const stack = await startStack(scratch, { personBrowser: false, log: (line) => console.log(`   ${line}`) });
const { phone } = stack;

/** What a phone holds of a chat: every event it was sent, and the latest state of each subagent card. */
function watch(device: Device, sessionId: string) {
  const events: SessionEvent[] = [];
  device.onMessage((m) => {
    if (m.type === 'session.event' && m.payload.sessionId === sessionId) events.push(m.payload.event);
  });
  return { events, cards: () => cardsOf(events), of: <K extends SessionEvent['kind']>(kind: K) => events.filter((e): e is Extract<SessionEvent, { kind: K }> => e.kind === kind) };
}
function cardsOf(events: readonly SessionEvent[]): SubagentEvent[] {
  const latest = new Map<string, SubagentEvent>();
  for (const e of events) if (e.kind === 'subagent') latest.set(e.id, e);
  return [...latest.values()];
}
const history = async (device: Device, sessionId: string) => (await device.ask({ type: 'session.history', payload: { sessionId } }, 'session.history.result')).payload.events;
const brief = (c: SubagentEvent | undefined) => (c ? { id: c.id, name: c.name, task: c.task, status: c.status, background: c.background, desktop: c.desktop, steps: c.steps?.length, activity: c.activity, result: c.result, error: c.error } : undefined);
const ended = (c: SubagentEvent | undefined) => !!c && c.status !== 'starting' && c.status !== 'running';
let requests = 0;
const requestId = () => `sub-${++requests}`;

if (flag('serve')) {
  // For the phone app: everything stays up, a chat exists, and a line of JSON says how to pair with it.
  const chat = await stack.newChat('Delegation');
  // Something to look at in the chat's own desktop: a page in its browser (a browser needs an ordinary user). The
  // tool is called directly, without the question to the phone: no reply is running that the chat could wait in.
  if (stack.browser && !(process.getuid?.() === 0 && stack.browser.family === 'chromium')) {
    const computer = chat.tools.get('computer')!;
    await computer.handler({ action: 'screenshot' }, {});
    await computer.handler({ action: 'open', target: stack.pages.url('A') }, {});
  }
  const serve = { relay: stack.relayUrl, pairing: stack.pairingUri(), chat: chat.id, say: ['[[do:delegate]]', '[[do:background]]'] };
  writeFileSync(path.join(scratch.out, 'serve.json'), JSON.stringify(serve, null, 2));
  console.log(`\nSERVING ${JSON.stringify(serve)}\nA fresh pairing link each time: touch ${path.join(scratch.out, 'again')}\nStop with Ctrl+C.`);
  const stop = async () => {
    await stack.stop().catch(() => undefined);
    await model?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  for (;;) {
    await sleep(500);
    const again = path.join(scratch.out, 'again');
    if (!existsSync(again)) continue;
    spawnSync('rm', ['-f', again]);
    writeFileSync(path.join(scratch.out, 'serve.json'), JSON.stringify({ ...serve, pairing: stack.pairingUri() }, null, 2));
  }
}

let failure: unknown;
const sdk: Record<string, unknown>[] = [];
try {
  section('1. A chat delegates to two subagents');
  const chat = await stack.newChat('Delegation');
  const seen = watch(phone, chat.id);
  // Every message of the Claude Code process, as the brain receives it: kept as the record of what the runtime sends.
  const session = stack.session(chat);
  const handle = session.handle.bind(session);
  session.handle = (message) => {
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') {
      sdk.push({ type: m.type, ...(m.subtype ? { subtype: m.subtype } : {}), ...(m.parent_tool_use_id ? { child_of: m.parent_tool_use_id } : {}), ...(m.task_id ? { task_id: m.task_id } : {}), ...(m.status ? { status: m.status } : {}), ...(m.tool_use_id ? { tool_use_id: m.tool_use_id } : {}), ...(m.is_backgrounded !== undefined ? { is_backgrounded: m.is_backgrounded } : {}), ...(m.patch ? { patch: m.patch } : {}), ...(m.tasks ? { tasks: m.tasks } : {}) });
    }
    return handle(message);
  };

  const say = (text: string) => phone.send({ type: 'message.send', payload: { sessionId: chat.id, text } });
  say(live ? 'Use the Agent tool twice in one step: one subagent takes a screenshot of its desktop and reports which display its shell sees (echo $DISPLAY); the other takes a screenshot and then runs "sleep 900". Wait for both.' : 'Split this between two helpers, please. [[do:delegate]]');
  const byTask = (words: string) => seen.cards().find((c) => c.task.toLowerCase().includes(words));
  const one = () => byTask(live ? 'display' : TASKS.one.toLowerCase());
  const two = () => byTask(live ? 'sleep' : TASKS.two.toLowerCase());

  await until('two subagent cards with desktops of their own', () => !!one()?.desktop && !!two()?.desktop, 240_000, 250);
  const first = { one: one()!, two: two()! };
  check('two subagent cards appear in the chat, both at work', seen.cards().length === 2 && !ended(first.one) && !ended(first.two), seen.cards().map(brief));
  check('each card names its role, its task and the Agent call of the parent that started it', [first.one, first.two].every((c) => !!c.name && !!c.task && !!c.toolUseId && !c.parentId) && first.one.toolUseId !== first.two.toolUseId, [brief(first.one), brief(first.two)]);
  const agentCalls = seen.of('tool_use').filter((e) => e.name === 'Agent' || e.name === 'Task');
  check("the parent's two Agent calls are in the chat as its own tool calls, and the cards point at them", agentCalls.length === 2 && new Set(agentCalls.map((e) => e.id)).size === 2 && [first.one, first.two].every((c) => agentCalls.some((e) => e.id === c.toolUseId)), agentCalls.map((e) => e.id));
  // This Claude Code starts every subagent as a background task: the reply that delegated ends at once and the
  // parent hears of each outcome later. A runtime that makes the reply wait would end it after the children.
  const repliedEarly = await until("the parent's reply to end", () => seen.of('result').length > 0, 20_000, 100).then(() => true, () => false);
  if (repliedEarly) check("the parent's reply ends while both are at work, and that closes neither card", !ended(one()) && !ended(two()), [brief(one()), brief(two())]);
  else note('the reply that delegated waits for its subagents here.');
  note(`the runtime started the subagents ${first.one.background ? 'as background tasks' : 'in the foreground'}.`);

  const desktops = async () => (await phone.ask({ type: 'workspace.get', payload: { requestId: requestId(), sessionId: chat.id } }, 'workspace.result')).payload.desktops;
  const listed = await until('both desktops to be running', async () => {
    const all = await desktops();
    return [first.one.id, first.two.id].every((id) => all.find((d) => d.key === id)?.state === 'running') ? all : undefined;
  }, 60_000, 500).catch(() => desktops());
  const refused = (model?.log ?? []).flatMap((entry) => entry.toolResults).filter((t) => /could not be matched|not known yet|already ended/.test(t.text));
  check('no tool call of a subagent was refused for lack of attribution', refused.length === 0, refused);
  const deskOne = listed.find((d) => d.key === first.one.id);
  const deskTwo = listed.find((d) => d.key === first.two.id);
  check('each subagent that used the computer has a running desktop of its own, listed under the chat', deskOne?.state === 'running' && deskTwo?.state === 'running' && !!deskOne.display && deskOne.display !== deskTwo.display, listed);
  const idOne = stack.desktopOf(chat, first.one.id);
  const idTwo = stack.desktopOf(chat, first.two.id);
  const liveOne = liveRecord(scratch, idOne);
  const liveTwo = liveRecord(scratch, idTwo);
  check('those are the desktops the brain derives from chat and task, and the main agent, which used no computer, has none', !!liveOne && !!liveTwo && liveOne.display === deskOne?.display && liveTwo.display === deskTwo?.display && !liveRecord(scratch, stack.desktopOf(chat)), [idOne, idTwo]);
  const previewOne = await phone.ask({ type: 'workspace.preview', payload: { requestId: requestId(), sessionId: chat.id, key: first.one.id } }, 'workspace.preview.result');
  if (previewOne.payload.image) writeFileSync(path.join(scratch.out, 'subagent-one-desktop.jpg'), Buffer.from(previewOne.payload.image.dataBase64, 'base64'));
  check("the phone can look into a subagent's desktop", !!previewOne.payload.image && !previewOne.payload.error, previewOne.payload.error);
  const mainTools = seen.of('tool_use').map((e) => e.name);
  check("the subagents' own tool calls are on their cards, not in the chat as the main agent's", mainTools.every((n) => n === 'Agent' || n === 'Task') && (one()?.steps?.length ?? 0) >= 1 && (two()?.steps?.length ?? 0) >= 1, { mainTools, one: one()?.steps, two: two()?.steps });
  const asks = () => stack.consents.filter((c) => c.sessionId === chat.id).map((c) => c.tool);
  check('the phone was asked before a subagent used the computer, once for the chat though two reached for it at the same moment', asks().filter((t) => t === 'computer').length === 1, asks());

  section('2. The phone is closed and opened again while they work');
  const second = await stack.newPhone('acceptance-phone-reopened');
  const midway = cardsOf(await history(second, chat.id));
  check('a phone that joins now finds both cards, each once, both still at work', midway.length === 2 && midway.every((c) => !ended(c)) && new Set(midway.map((c) => c.id)).size === 2, midway.map(brief));
  const secondSeen = watch(second, chat.id);

  section('3. One subagent is stopped from the phone, the other goes on');
  await until("subagent two to be waiting in its command", () => processesOf(scratch, idTwo).some((p) => p.cmdline.join(' ').includes('sleep 900')), 60_000, 250).catch(() => undefined);
  const twoPids = processesOf(scratch, idTwo).map((p) => p.pid);
  phone.send({ type: 'subagent.cancel', payload: { sessionId: chat.id, id: first.two.id } });
  await until('subagent two to end', () => ended(two()), 60_000, 100);
  check("the stopped subagent's card says cancelled", two()?.status === 'cancelled', brief(two()));
  check('the other subagent is still running at that moment', !ended(one()), brief(one()));
  const goneTwo = await until("subagent two's desktop and command to end", () => twoPids.every((pid) => !running(pid)) && !existsSync(workspaceDir(scratch, idTwo)), 30_000).then(() => true, () => false);
  check('its desktop is closed and removed, and the command it was waiting for is stopped', goneTwo, twoPids.filter(running));
  await until('subagent one to finish', () => ended(one()), 120_000, 100);
  check('the other subagent finishes its work and reports', one()?.status === 'completed' && (live || /Subagent one finished/.test(one()?.result ?? '')), brief(one()));
  check("its shell command ran inside its own desktop: it saw that desktop's display", live || (!!liveOne && (one()?.result ?? '').includes(`sees display ${liveOne.display}`)), [one()?.result, liveOne?.display]);
  check('the phone was asked before a subagent ran a command, too: delegation bypasses no consent', asks().some((t) => t === 'Bash' || t === 'run_command'), asks());
  const said = () => seen.of('text').map((e) => e.text);
  const told = await until('the parent to hear of both outcomes', () => (live ? seen.of('result').length >= 2 : said().some((t) => /was stopped/.test(t)) && said().some((t) => /Subagent one finished/.test(t))), 120_000, 100).then(() => true, () => false);
  check('the parent is told of each outcome when it happens and says so in the chat', told, said());
  await until("subagent one's desktop to be removed", () => !existsSync(workspaceDir(scratch, idOne)), 30_000).catch(() => undefined);
  check('a finished subagent leaves no desktop behind', !existsSync(workspaceDir(scratch, idOne)) && processesOf(scratch, idOne).length === 0);

  section('4. After the reply: what the chat keeps');
  const kept = cardsOf(await history(phone, chat.id));
  check('the history holds each card once, in its final state: one completed, one cancelled, none running', kept.length === 2 && kept.find((c) => c.id === first.one.id)?.status === 'completed' && kept.find((c) => c.id === first.two.id)?.status === 'cancelled', kept.map(brief));
  check('the phone that joined in between saw the same end live', secondSeen.cards().length === 2 && secondSeen.cards().every(ended), secondSeen.cards().map(brief));
  const third = await stack.newPhone('acceptance-phone-later');
  const later = cardsOf(await history(third, chat.id));
  check('a phone that opens the chat afterwards gets the same two cards, nothing running', later.length === 2 && later.every(ended), later.map(brief));
  third.close();

  section('5. A subagent sent to the background outlives the reply that started it');
  const repliesBefore = seen.of('result').length;
  say(live ? 'Start one subagent in the background (run_in_background) that runs "sleep 10; echo done" and reports; do not wait for it.' : 'One more, but do not wait for it. [[do:background]]');
  const three = () => seen.cards().find((c) => c.id !== first.one.id && c.id !== first.two.id);
  await until('the reply that started it to end', () => seen.of('result').length > repliesBefore, 180_000, 100);
  const atReplyEnd = three();
  check('when the parent\'s reply ends, the background subagent\'s card is still running, not completed', !!atReplyEnd && !ended(atReplyEnd) && atReplyEnd.background === true, brief(atReplyEnd));
  const whileRunning = cardsOf(await history(second, chat.id)).find((c) => c.id === atReplyEnd?.id);
  check('a reload at that moment shows it running too', !!whileRunning && !ended(whileRunning), brief(whileRunning));
  await until('the background subagent to finish', () => ended(three()), 180_000, 100);
  check('it finishes later and its card says so, with its report', three()?.status === 'completed' && (live || /three finished/.test(three()?.result ?? '')), brief(three()));
  await sleep(3000);
  const final = cardsOf(await history(phone, chat.id));
  check('in the end the chat holds three cards, each once, none running', final.length === 3 && final.every(ended) && new Set(final.map((c) => c.id)).size === 3, final.map(brief));
  note(`statuses seen for the three cards, in order: ${seen.of('subagent').map((e) => `${e.id.slice(0, 6)}:${e.status}`).join(' ')}`);

  section('6. Leaving');
  await stack.stop();
  check('nothing of any subagent desktop is left running', [idOne, idTwo].every((id) => processesOf(scratch, id).length === 0));
} catch (e) {
  failure = e;
  console.error(`\nSTOPPED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  const log = path.join(scratch.brain, 'logs');
  if (existsSync(log)) console.error(spawnSync('sh', ['-c', `tail -n 30 ${log}/*.log`], { encoding: 'utf8' }).stdout);
  await stack.stop().catch(() => undefined);
}
await model?.close();

writeFileSync(path.join(scratch.out, 'sdk-messages.json'), JSON.stringify(sdk, null, 1));
if (model) writeFileSync(path.join(scratch.out, 'model-requests.json'), JSON.stringify(model.log, null, 1));
const failed = checks.filter((c) => !c.ok);
const summary = `${checks.length - failed.length} of ${checks.length} checks passed${failure ? '; the run stopped early' : ''}`;
const sections = [...new Set(checks.map((c) => c.section))];
const sdkKinds = [...new Set(sdk.map((m) => `${String(m.type)}${m.subtype ? `/${String(m.subtype)}` : ''}`))];
writeFileSync(
  path.join(scratch.out, 'REPORT-subagents.md'),
  [
    '# Subagents in a chat: acceptance run',
    '',
    `- Result: **${failed.length === 0 && !failure ? 'PASS' : 'FAIL'}**, ${summary}`,
    `- When: ${new Date(started).toISOString()}, ${Math.round((Date.now() - started) / 1000)} s`,
    `- Where: ${os.hostname()}, ${os.type()} ${os.release()}, user ${os.userInfo().username} (uid ${process.getuid?.()}), Node ${process.version}`,
    `- Model: ${live ? 'a real model (--live)' : 'scripted (acceptance/scripted-model.ts): no model and no credentials were involved'}`,
    '',
    'Real in this run: the Claude Code process the brain starts for the chat, its Agent tool and the subagents it runs, their calls to the chat\'s tools, the brain, the relay, PocketClipboard with the desktops of the subagents, the executor code and its shell commands.',
    `Standing in: ${live ? '' : 'the model (every reply comes from a script), '}the phone (paired clients sending the phone's messages), the VS Code window around the executor code.`,
    '',
    `Kinds of messages the Claude Code process sent: ${sdkKinds.join(', ')}`,
    ...notes.map((n) => `- ${n}`),
    ...(failure ? ['', `Stopped early: ${failure instanceof Error ? failure.message : String(failure)}`] : []),
    ...sections.flatMap((s) => ['', `## ${s}`, '', '| Check | Result |', '| --- | --- |', ...checks.filter((c) => c.section === s).map((c) => `| ${c.name.replace(/\|/g, '/')} | ${c.ok ? 'pass' : `**FAIL** ${c.detail.replace(/\|/g, '/')}`} |`)]),
    '',
  ].join('\n'),
);
console.log(`\n${summary}. Evidence: ${scratch.out}`);
if (!flag('keep')) spawnSync('rm', ['-rf', scratch.home, scratch.tmp, scratch.brain, scratch.project]);
process.exit(failed.length === 0 && !failure ? 0 : 1);
