import { mkdirSync, rmSync } from 'node:fs';
import type { SessionEvent, SessionMeta } from '@pocket/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';

const live = process.env.POCKET_KIMI_LIVE === '1';
const base = `${(process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/pocket-kimi-live-${process.pid}`;
process.env.POCKET_HOME = `${base}/home`;
process.env.POCKET_WORKSPACE = `${base}/workspace`;
process.env.POCKET_LOG_DIR = `${base}/logs`;
process.env.POCKET_SKILLS_DIR = `${base}/no-skills`;
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Host = ConstructorParameters<typeof Session>[1];

function host(events: SessionEvent[]): Host {
  return {
    executorFor: () => ({ id: undefined, online: false, info: null, root: undefined, call: async () => ({ content: '', isError: true }) }),
    pcFor: () => ({ id: undefined, name: undefined, online: false, capabilities: [], clipboardRead: async () => ({}), clipboardWrite: async () => ({}), screenshot: async () => ({}), computer: async () => ({}) }),
    guestRoot: () => undefined,
    userName: () => 'Owner',
    emit: (_id, event) => void events.push(event),
    metaChanged: () => {},
    canUseTool: async (_s, _t, input) => ({ behavior: 'allow', updatedInput: input }),
    claudeOptions: () => ({}),
    ownerChat: () => true,
    onClaudeVersion: () => {},
  };
}

describe.skipIf(!live)('Kimi live Session', () => {
  it('runs a real turn with Pocket MCP and advertises the subscription models', async () => {
    mkdirSync(base, { recursive: true });
    const events: SessionEvent[] = [];
    const now = Date.now();
    const meta: SessionMeta = {
      sessionId: 'kimi-live-test', title: 'Kimi live', state: 'idle', createdAt: now, updatedAt: now,
      model: 'kimi:kimi-code/kimi-for-coding', effort: 'low', userId: 'owner',
    };
    const session = new Session(meta, host(events), false);
    try {
      await session.send({ text: 'Ответь ровно одним словом: OK', from: 'test' });
      expect(events.filter((event) => event.kind === 'error')).toEqual([]);
      expect(events.some((event) => event.kind === 'text' && event.text.includes('OK'))).toBe(true);
      expect(session.meta.state).toBe('idle');
      expect(session.meta.engine?.id).toBeTruthy();
      const models = await session.supportedModels();
      expect(models?.some((model) => model.value === 'kimi:kimi-code/k3')).toBe(true);
      expect(models?.some((model) => model.value === 'kimi:kimi-code/k3.1-pro')).toBe(true);
    } finally {
      session.stop();
    }
  }, 90_000);
});
