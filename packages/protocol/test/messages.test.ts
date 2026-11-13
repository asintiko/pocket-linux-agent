import { describe, expect, it } from 'vitest';
import { innerMessageBodySchema, innerMessageSchema, MAX_SYSTEM_PROMPT_LENGTH } from '../src/index.js';

const session = { sessionId: 's', title: 't', state: 'idle', createdAt: 1, updatedAt: 2 };

describe('innerMessageBodySchema', () => {
  it.each([
    { type: 'session.create', payload: {} },
    { type: 'session.create', payload: { systemPrompt: 'Reply in concise bullets' } },
    { type: 'session.configure', payload: { sessionId: 's', systemPrompt: '' } },
    { type: 'session.configure', payload: { sessionId: 's', requestId: 'configure-1' } },
    { type: 'error', payload: { code: 'configure_failed', message: 'Could not update', sessionId: 's', requestId: 'configure-1' } },
    { type: 'message.send', payload: { sessionId: 's', text: 'x', attachments: [{ mime: 'image/png', dataBase64: 'AA==' }] } },
    { type: 'permission.respond', payload: { requestId: 'r', decision: 'allow_session' } },
    { type: 'session.created', payload: { session } },
    { type: 'session.updated', payload: { session: { ...session, systemPrompt: 'Reply in concise bullets' } } },
    { type: 'session.event', payload: { sessionId: 's', event: { kind: 'tool_result', id: 'i', content: 'c', isError: false } } },
    { type: 'tool.call', payload: { callId: 'c', name: 'read_file', args: { path: 'a' } } },
    { type: 'tool.output', payload: { callId: 'c', chunk: 'x', stream: 'stderr' } },
    { type: 'control.kill', payload: { scope: 'all' } },
  ])('accepts $type', (msg) => {
    expect(innerMessageBodySchema.safeParse(msg).success).toBe(true);
  });

  it('negotiates Ultra in the catalog and keeps the legacy session effort field compatible', () => {
    const model = 'codex/gpt-6-astra';
    const request = { type: 'models.get', payload: { supportsUltra: true } };
    const catalog = { type: 'models.result', payload: { models: [{ value: model, displayName: 'GPT-6 Astra', description: 'Codex', efforts: ['ultra'] }] } };
    const configure = { type: 'session.configure', payload: { sessionId: 's', effort: 'ultra' } };
    const update = { type: 'session.updated', payload: { session: { ...session, model, codexEffort: 'ultra' } } };
    for (const message of [request, catalog, configure, update]) expect(innerMessageBodySchema.parse(message)).toEqual(message);
    expect(innerMessageBodySchema.safeParse({ type: 'session.updated', payload: { session: { ...session, effort: 'ultra' } } }).success).toBe(false);
  });

  it('rejects unknown type', () => {
    expect(innerMessageBodySchema.safeParse({ type: 'nope', payload: {} }).success).toBe(false);
  });

  it('rejects invalid payloads', () => {
    expect(innerMessageBodySchema.safeParse({ type: 'message.send', payload: { sessionId: 's' } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'session.configure', payload: { sessionId: 's', systemPrompt: 1 } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'control.kill', payload: { scope: 'one' } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'permission.respond', payload: { requestId: 'r', decision: 'maybe' } }).success).toBe(false);
  });

  it('trims bounded prompts while preserving explicit clears', () => {
    expect(innerMessageBodySchema.parse({ type: 'session.create', payload: { systemPrompt: '  Use bullets  ' } })).toEqual({
      type: 'session.create',
      payload: { systemPrompt: 'Use bullets' },
    });
    expect(innerMessageBodySchema.parse({ type: 'session.configure', payload: { sessionId: 's', systemPrompt: '   ' } })).toEqual({
      type: 'session.configure',
      payload: { sessionId: 's', systemPrompt: '' },
    });
    expect(innerMessageBodySchema.safeParse({ type: 'session.configure', payload: { sessionId: 's', systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH) } }).success).toBe(true);
  });

  it('rejects system prompts over the shared limit', () => {
    const systemPrompt = 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1);
    expect(innerMessageBodySchema.safeParse({ type: 'session.create', payload: { systemPrompt } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'session.configure', payload: { sessionId: 's', systemPrompt } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'session.updated', payload: { session: { ...session, systemPrompt } } }).success).toBe(false);
  });

  it('accepts optional event timestamps and leaves legacy events undated', () => {
    const legacy = innerMessageBodySchema.parse({
      type: 'session.event',
      payload: { sessionId: 's', event: { kind: 'user', text: 'old', from: 'phone' } },
    });
    const dated = innerMessageBodySchema.parse({
      type: 'session.event',
      payload: { sessionId: 's', event: { kind: 'user', text: 'new', from: 'phone', at: 123 } },
    });
    expect(legacy.type === 'session.event' && legacy.payload.event).not.toHaveProperty('at');
    expect(dated.type === 'session.event' && dated.payload.event.at).toBe(123);
  });

  it('inner message requires ts and counter', () => {
    expect(innerMessageSchema.safeParse({ ts: 1, counter: 2, type: 'status.get', payload: {} }).success).toBe(true);
    expect(innerMessageSchema.safeParse({ type: 'status.get', payload: {} }).success).toBe(false);
  });
});

describe('computer use messages', () => {
  it.each([
    { action: 'screenshot' },
    { action: 'screenshot', display: 1, maxWidth: 1280, maxHeight: 800 },
    { action: 'zoom', x: -1920, y: 0, width: 400, height: 300 },
    { action: 'click', x: 10, y: 20, button: 'left', count: 2, modifiers: ['ctrl'] },
    { action: 'click', button: 'right', count: 1 },
    { action: 'drag', path: [[0, 0], [100, 50]] },
    { action: 'scroll', x: 5, y: 5, dx: 0, dy: -3 },
    { action: 'type', text: 'Привет, dir\n' },
    { action: 'key', keys: 'ctrl+shift+esc', holdMs: 500 },
    { action: 'window', handle: '1312342', op: 'focus' },
    { action: 'open', target: 'chrome', args: 'https://example.com' },
    { action: 'release' },
  ])('accepts computer.act $action', (action) => {
    expect(innerMessageBodySchema.safeParse({ type: 'computer.act', payload: { requestId: 'r', action } }).success).toBe(true);
  });

  it.each([
    { action: 'click', x: 1.5, y: 2, button: 'left', count: 1 },
    { action: 'click', x: 1, y: 2, button: 'left', count: 4 },
    { action: 'drag', path: [[0, 0]] },
    { action: 'type', text: '' },
    { action: 'window', handle: 'abc', op: 'focus' },
    { action: 'window', handle: '1', op: 'explode' },
    { action: 'teleport' },
  ])('rejects a bad computer.act %#', (action) => {
    expect(innerMessageBodySchema.safeParse({ type: 'computer.act', payload: { requestId: 'r', action } }).success).toBe(false);
  });

  it('carries screenshots with their place on the desktop, windows and errors back', () => {
    const done = {
      requestId: 'r',
      image: { mime: 'image/jpeg', dataBase64: 'QUJD', width: 1280, height: 720 },
      region: { x: 0, y: 0, width: 2560, height: 1440 },
      displays: [{ index: 0, x: 0, y: 0, width: 2560, height: 1440, primary: true, scale: 1.5 }],
      cursor: { x: 10, y: 10 },
      windows: [{ handle: '42', title: 'Windows PowerShell', process: 'powershell', x: 0, y: 0, width: 800, height: 600, minimized: false, maximized: false, focused: true, display: 0 }],
    };
    expect(innerMessageBodySchema.safeParse({ type: 'computer.done', payload: done }).success).toBe(true);
    expect(innerMessageBodySchema.safeParse({ type: 'computer.done', payload: { requestId: 'r', error: 'blocked' } }).success).toBe(true);
  });
});
