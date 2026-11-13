import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ChatItem } from '@pocket/client-core';
import { formatMessageTime } from '../chat-timeline';
import { formatResult } from '../format';
import { CopyToPc } from '../pc-clipboard';
import { colors, ownBubble, radius } from '../theme';
import type { Persona } from '../persona';
import { ClaudeAvatar } from './ClaudeAvatar';
import { Markdown } from './Markdown';
import { MessageActions } from './MessageActions';
import { SubagentCard } from './SubagentCard';
import { ToolCard } from './ToolCard';

const AVATAR = 28;
const INDENT = AVATAR + 8;

export type ChatRowProps = {
  item: ChatItem;
  persona?: Persona;
  delivery?: 'sending' | 'unconfirmed';
  /** Stops one child agent by its id. Pass a stable function: the row only re-renders when its props change. */
  onCancelSubagent?: (id: string) => void;
  /** Opens a desktop picture: `key` is the child's id. */
  onOpenDesktop?: (key: string) => void;
};

function ChatRowImpl({ item, persona, delivery, onCancelSubagent, onOpenDesktop }: ChatRowProps) {
  const time = formatMessageTime(item.at);

  switch (item.type) {
    case 'user':
      return (
        <View style={styles.userWrap}>
          <MessageActions text={item.text} accessibilityLabel={'Your message: ' + item.text} style={styles.userTarget}>
            <LinearGradient colors={ownBubble} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.userBubble}>
              {item.images ? (
                <View style={styles.photos}>
                  <Ionicons name="image" size={14} color={colors.userText} />
                  <Text style={styles.photosText}>{item.images === 1 ? 'Photo' : item.images + ' photos'}</Text>
                </View>
              ) : null}
              {item.files?.map((f) => (
                <View key={f} style={styles.photos}>
                  <Ionicons name="document-attach" size={14} color={colors.userText} />
                  <Text style={styles.photosText} numberOfLines={1}>
                    {f}
                  </Text>
                </View>
              ))}
              <Text selectable style={styles.userText}>
                {item.text}
              </Text>
              {time || delivery ? (
                <View style={styles.userMeta}>
                  {delivery ? (
                    <View style={styles.delivery}>
                      <Ionicons
                        name={delivery === 'sending' ? 'time-outline' : 'alert-circle-outline'}
                        size={12}
                        color={delivery === 'sending' ? styles.userTime.color : colors.warn}
                      />
                      <Text style={[styles.userTime, delivery === 'unconfirmed' && styles.unconfirmedText]}>
                        {delivery === 'sending' ? 'Sending…' : 'Not confirmed'}
                      </Text>
                    </View>
                  ) : null}
                  {time ? <Text style={styles.userTime}>{time}</Text> : null}
                </View>
              ) : null}
            </LinearGradient>
          </MessageActions>
        </View>
      );
    case 'assistant':
      return (
        <View>
          <View style={styles.assistantWrap}>
            <ClaudeAvatar size={AVATAR} persona={persona} />
            <MessageActions
              text={item.text}
              disabled={item.streaming}
              accessibilityLabel={'Claude message: ' + item.text}
              style={styles.assistantTarget}
            >
              <View style={styles.assistantBubble}>
                <Markdown text={item.text} caret={item.streaming} />
                {time ? <Text style={styles.assistantTime}>{time}</Text> : null}
              </View>
            </MessageActions>
          </View>
          {item.streaming ? null : (
            <View style={styles.replyActions}>
              <CopyToPc text={item.text} />
            </View>
          )}
        </View>
      );
    case 'tool':
      return (
        <View style={styles.toolWrap}>
          <ToolCard item={item} />
        </View>
      );
    case 'subagent':
      return (
        <View style={styles.toolWrap}>
          <SubagentCard item={item} onCancel={onCancelSubagent} onOpenDesktop={onOpenDesktop} />
        </View>
      );
    case 'result':
      return (
        <Text style={styles.result}>
          {formatResult(item.durationMs, item.costUsd, item.inputTokens, item.outputTokens)}
        </Text>
      );
    case 'error':
      return (
        <View style={styles.error}>
          <Text selectable style={styles.errorText}>
            {item.message}
          </Text>
        </View>
      );
  }
}

export const ChatRow = memo(ChatRowImpl);

const styles = StyleSheet.create({
  userWrap: { alignItems: 'flex-end', paddingLeft: 64 },
  userTarget: { maxWidth: '100%' },
  userBubble: { borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '100%' },
  userText: { color: colors.userText, fontSize: 15, lineHeight: 21 },
  userMeta: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 4 },
  delivery: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  userTime: { color: 'rgba(255,255,255,0.72)', fontSize: 10, lineHeight: 14 },
  unconfirmedText: { color: '#FFD27A' },
  photos: { flexDirection: 'row', alignItems: 'center', gap: 5, opacity: 0.85, marginBottom: 2 },
  photosText: { color: colors.userText, fontSize: 12.5, fontWeight: '600' },
  assistantWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingRight: 40 },
  assistantTarget: { flexShrink: 1 },
  assistantBubble: {
    flexShrink: 1,
    backgroundColor: colors.bubble,
    borderRadius: radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  assistantTime: { color: colors.textMuted, fontSize: 10, lineHeight: 14, alignSelf: 'flex-end', marginTop: 4 },
  replyActions: { flexDirection: 'row', gap: 8, paddingLeft: INDENT, paddingTop: 4 },
  toolWrap: { paddingLeft: INDENT, paddingRight: 24 },
  result: { color: colors.textMuted, fontSize: 11, textAlign: 'center', opacity: 0.8 },
  error: {
    marginLeft: INDENT,
    backgroundColor: colors.dangerSoft,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(237,73,86,0.4)',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: { color: '#F6A5AC', fontSize: 14, lineHeight: 20 },
});
