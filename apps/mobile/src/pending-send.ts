import type { ChatItem } from '@pocket/client-core';

export interface PendingSend {
  text: string;
  item: Extract<ChatItem, { type: 'user' }>;
  previousCount: number;
  phase: 'sending' | 'unconfirmed';
}

function receiptCount(thread: readonly ChatItem[], text: string, from: string): number {
  return thread.filter((item) => item.type === 'user' && item.text === text && item.from === from).length;
}

export function beginSend(text: string, thread: readonly ChatItem[], attachments: { mime: string; name?: string }[] = [], from = 'local'): PendingSend {
  const at = Date.now();
  const images = attachments.filter((attachment) => attachment.mime.startsWith('image/')).length;
  const files = attachments.filter((attachment) => !attachment.mime.startsWith('image/')).map((attachment) => attachment.name ?? 'File');
  return {
    text,
    item: { key: `pending:${at}`, type: 'user', text, from, at, ...(images ? { images } : {}), ...(files.length ? { files } : {}) },
    previousCount: receiptCount(thread, text, from),
    phase: 'sending',
  };
}

export function sendConfirmed(pending: PendingSend, thread: readonly ChatItem[]): boolean {
  return receiptCount(thread, pending.text, pending.item.from) > pending.previousCount;
}
