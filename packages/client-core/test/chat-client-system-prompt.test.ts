import { b64, deriveDeviceId, generateIdentity, MAX_SYSTEM_PROMPT_LENGTH, type InnerMessageBody, type SessionMeta } from '@pocket/protocol';
import { describe, expect, it } from 'vitest';
import { ChatClient } from '../src/chat-client.js';

function client() {
  const identity = generateIdentity();
  const brain = generateIdentity();
  const brainDeviceId = deriveDeviceId(brain.signPub);
  const c = new ChatClient({
    relayUrl: 'http://127.0.0.1:1',
    accountId: 'acc',
    deviceId: deriveDeviceId(identity.signPub),
    identity,
    brainDeviceId,
    brainEncPub: b64.encode(brain.encPub),
  });
  const sent: InnerMessageBody[] = [];
  (c as unknown as { request: (body: InnerMessageBody) => boolean }).request = (body) => (sent.push(body), true);
  const inject = (message: InnerMessageBody) =>
    (c as unknown as { onMessage: (input: { from: string; message: InnerMessageBody }) => void }).onMessage({ from: brainDeviceId, message });
  return { c, sent, inject };
}

function session(systemPrompt?: string): SessionMeta {
  return { sessionId: 's', title: 'Draft', state: 'idle', createdAt: 1, updatedAt: 1, ...(systemPrompt ? { systemPrompt } : {}) };
}

describe('ChatClient system prompts', () => {
  it('normalizes prompts and waits for the brain to confirm configuration', async () => {
    const { c, sent, inject } = client();
    const created = c.createSession('Draft', '  Use short sentences  ');
    expect(sent[0]).toEqual({ type: 'session.create', payload: { title: 'Draft', systemPrompt: 'Use short sentences' } });

    inject({ type: 'session.created', payload: { session: session('Use short sentences') } });
    await expect(created).resolves.toBe('s');
    expect(c.getState().sessions[0]?.systemPrompt).toBe('Use short sentences');

    expect(c.configure('s', { systemPrompt: '   ' })).toBe(true);
    expect(sent[1]).toEqual({ type: 'session.configure', payload: { sessionId: 's', requestId: expect.any(String), systemPrompt: '' } });
    expect(c.getState().sessions[0]?.systemPrompt).toBe('Use short sentences');

    inject({ type: 'session.updated', payload: { session: session() } });
    expect(c.getState().sessions[0]?.systemPrompt).toBeUndefined();

    expect(c.configure('s', { systemPrompt: '  Use a checklist  ' })).toBe(true);
    expect(sent[2]).toEqual({ type: 'session.configure', payload: { sessionId: 's', requestId: expect.any(String), systemPrompt: 'Use a checklist' } });
    expect(c.getState().sessions[0]?.systemPrompt).toBeUndefined();
    inject({ type: 'session.updated', payload: { session: session('Use a checklist') } });
    expect(c.getState().sessions[0]?.systemPrompt).toBe('Use a checklist');

    inject({ type: 'error', payload: { code: 'configure_failed', message: 'Could not update', sessionId: 's' } });
    expect(c.getState().configureErrors.s).toBe('Could not update');

    const sentCount = sent.length;
    expect(c.configure('s', { systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1) })).toBe(false);
    expect(sent).toHaveLength(sentCount);
    expect(c.getState().configureErrors.s).toContain(`${MAX_SYSTEM_PROMPT_LENGTH}`);
    await expect(c.createSession('Draft', 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1))).rejects.toThrow();
    c.close();
  });

  it('ignores a delayed configure failure after a newer request', () => {
    const { c, sent, inject } = client();
    expect(c.configure('s', { model: 'opus' })).toBe(true);
    expect(c.configure('s', { effort: 'high' })).toBe(true);

    const requests = sent.filter((message): message is Extract<InnerMessageBody, { type: 'session.configure' }> => message.type === 'session.configure');
    const firstRequestId = requests[0]?.payload.requestId;
    const secondRequestId = requests[1]?.payload.requestId;
    if (firstRequestId === undefined || secondRequestId === undefined) throw new Error('Configure requests must carry IDs');
    expect(firstRequestId).not.toBe(secondRequestId);

    inject({ type: 'error', payload: { code: 'configure_failed', message: 'Old request failed', sessionId: 's', requestId: firstRequestId } });
    expect(c.getState().configureErrors.s).toBeUndefined();

    inject({ type: 'error', payload: { code: 'configure_failed', message: 'Current request failed', sessionId: 's', requestId: secondRequestId } });
    expect(c.getState().configureErrors.s).toBe('Current request failed');
    c.close();
  });
});
