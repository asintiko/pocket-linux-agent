import type { ChatItem } from '@pocket/client-core';
import { describe, expect, it } from 'vitest';
import { beginSend, sendConfirmed } from '../src/pending-send';

const old: Extract<ChatItem, { type: 'user' }> = { key: 'user:1', type: 'user', text: 'Hello', from: 'local', at: 100 };

describe('message sending confirmation', () => {
  it('does not mistake an existing identical message for delivery', () => {
    const pending = beginSend('Hello', [old]);
    expect(pending.phase).toBe('sending');
    expect(sendConfirmed(pending, [old])).toBe(false);
  });

  it('waits for a new user echo, not unrelated events or streamed text', () => {
    const pending = beginSend('Hello', [old]);
    expect(sendConfirmed(pending, [old, { key: 'text:2', type: 'assistant', text: 'Hello', streaming: true }])).toBe(false);
    expect(sendConfirmed(pending, [old, { ...old, key: 'user:3', text: 'Other message' }])).toBe(false);
    expect(sendConfirmed(pending, [old, { ...old, key: 'user:4' }])).toBe(true);
  });

  it('can confirm a late delivery without discarding the pending message', () => {
    const pending = { ...beginSend('Hello', []), phase: 'unconfirmed' as const };
    expect(sendConfirmed(pending, [old])).toBe(true);
  });

  it('does not mistake reloaded history or another device for a receipt', () => {
    const pending = beginSend('Hello', [old]);
    expect(sendConfirmed(pending, [{ ...old, key: 'rebuilt-history' }])).toBe(false);
    expect(sendConfirmed(pending, [old, { ...old, key: 'user:other', from: 'another-device' }])).toBe(false);
  });

  it('keeps attachment labels available while delivery is pending', () => {
    const pending = beginSend('See attachments', [], [{ mime: 'image/png' }, { mime: 'text/plain', name: 'notes.txt' }], 'phone');
    expect(pending.item).toMatchObject({ type: 'user', text: 'See attachments', from: 'phone', images: 1, files: ['notes.txt'] });
  });
});
