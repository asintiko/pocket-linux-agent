import type { SessionEvent, SubagentEvent, SubagentStatus } from '@pocket/protocol';

const MAX_TOOL_OUTPUT = 20_000;

/** A child agent's card: the latest `subagent` event with its id, minus the event's own fields. */
export type SubagentCard = Omit<SubagentEvent, 'kind' | 'at'>;

export type ChatItem =
  | { type: 'user'; key: string; at?: number; text: string; from: string; images?: number; files?: string[]; voice?: boolean }
  | { type: 'assistant'; key: string; at?: number; text: string; streaming: boolean }
  | {
      type: 'tool';
      key: string;
      at?: number;
      id: string;
      name: string;
      input: unknown;
      output: string;
      result?: { content: string; isError: boolean };
    }
  | ({ type: 'subagent'; key: string; at?: number } & SubagentCard)
  | { type: 'result'; key: string; at?: number; durationMs?: number; costUsd?: number; inputTokens?: number; outputTokens?: number }
  | { type: 'error'; key: string; at?: number; message: string };

export type SubagentItem = Extract<ChatItem, { type: 'subagent' }>;

let seq = 0;
const key = () => `i${++seq}`;

/** A child agent that is done, whatever way it ended. */
export const subagentEnded = (status: SubagentStatus): boolean => status === 'completed' || status === 'failed' || status === 'cancelled';

function finalizeStreaming(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.type === 'assistant' && last.streaming) return [...items.slice(0, -1), { ...last, streaming: false }];
  return items;
}

/** Pure reducer from Claude activity events to renderable chat items. */
export function applyEvent(items: ChatItem[], event: SessionEvent): ChatItem[] {
  const at = event.at === undefined ? {} : { at: event.at };
  switch (event.kind) {
    case 'user':
      return [...finalizeStreaming(items), { type: 'user', key: key(), ...at, text: event.text, from: event.from, ...(event.images ? { images: event.images } : {}), ...(event.files?.length ? { files: event.files } : {}), ...(event.voice ? { voice: true } : {}) }];
    case 'text_delta': {
      const last = items[items.length - 1];
      if (last?.type === 'assistant' && last.streaming) return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      return [...items, { type: 'assistant', key: key(), ...at, text: event.text, streaming: true }];
    }
    case 'text': {
      const last = items[items.length - 1];
      if (last?.type === 'assistant' && last.streaming) return [...items.slice(0, -1), { ...last, text: event.text, streaming: false }];
      return [...items, { type: 'assistant', key: key(), ...at, text: event.text, streaming: false }];
    }
    case 'tool_use':
      return [...finalizeStreaming(items), { type: 'tool', key: key(), ...at, id: event.id, name: event.name, input: event.input, output: '' }];
    case 'tool_output':
      return items.map((it) =>
        it.type === 'tool' && it.id === event.id ? { ...it, output: (it.output + event.chunk).slice(-MAX_TOOL_OUTPUT) } : it,
      );
    case 'tool_result':
      return items.map((it) => (it.type === 'tool' && it.id === event.id ? { ...it, result: { content: event.content, isError: event.isError } } : it));
    case 'subagent': {
      const { kind: _kind, at: _at, ...card } = event;
      const index = items.findIndex((it) => it.type === 'subagent' && it.id === event.id);
      // The first event of a child puts its card where the child started; later ones change that card in place, so
      // replaying history or receiving an event twice never makes a second card.
      if (index < 0) return [...finalizeStreaming(items), { type: 'subagent', key: key(), ...at, ...card }];
      const shown = items[index] as SubagentItem;
      // A card that ended stays ended: a progress line that was still on its way must not set it running again.
      if (subagentEnded(shown.status) && !subagentEnded(event.status)) return items;
      const next = [...items];
      next[index] = { type: 'subagent', key: shown.key, ...(shown.at !== undefined ? { at: shown.at } : {}), ...card };
      return next;
    }
    case 'result':
      return [
        ...finalizeStreaming(items),
        {
          type: 'result',
          key: key(),
          ...at,
          durationMs: event.durationMs,
          costUsd: event.costUsd,
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
        },
      ];
    case 'error':
      return [...finalizeStreaming(items), { type: 'error', key: key(), ...at, message: event.message }];
    case 'state':
      return event.state === 'idle' ? finalizeStreaming(items) : items;
  }
}

export function buildThread(events: SessionEvent[]): ChatItem[] {
  return events.reduce(applyEvent, [] as ChatItem[]);
}
