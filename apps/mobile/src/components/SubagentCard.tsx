import { Ionicons } from '@expo/vector-icons';
import type { SubagentItem } from '@pocket/client-core';
import type { SubagentStep } from '@pocket/protocol';
import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import { alert } from '../alert';
import type { IconName } from '../format';
import * as Haptics from '../haptics';
import { useNow } from '../hooks';
import {
  activityCaption,
  stepGlyph,
  stepGlyphColor,
  stepLine,
  stepName,
  stepSummary,
  subagentDuration,
  subagentEndedIcon,
  subagentHeadline,
  subagentLive,
  subagentStats,
  subagentStatusColor,
  subagentStatusLabel,
  subagentTaskLine,
  subagentTitle,
  type StepGlyph,
} from '../subagents';
import { colors, mono, radius, space } from '../theme';
import { Markdown } from './Markdown';

/** A Stop that changed nothing on the card (the Mac never got it) can be tried again after this long. */
const STOP_RETRY_MS = 10_000;

export type SubagentCardProps = {
  item: SubagentItem;
  /** Stops this child only. */
  onCancel?: (id: string) => void;
  /** Opens the picture of the Linux desktop the child works on, by the child's id. */
  onOpenDesktop?: (key: string) => void;
};

const STEP_ICON: Record<Exclude<StepGlyph, 'spinner'>, IconName> = { done: 'checkmark', error: 'close', idle: 'ellipse-outline' };
const STEP_WORD: Record<StepGlyph, string> = { spinner: 'running', done: 'done', error: 'failed', idle: 'unfinished' };

function SubagentCardImpl({ item, onCancel, onOpenDesktop }: SubagentCardProps) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const live = subagentLive(item.status);
  // Ticks inside this card, and only while it works: the chat list does not re-render for it.
  const now = useNow(live);

  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), STOP_RETRY_MS);
    return () => clearTimeout(timer);
  }, [stopping]);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((o) => !o);
  };

  const title = subagentTitle(item);
  const taskLine = subagentTaskLine(item);
  const headline = subagentHeadline(item);
  const duration = subagentDuration(item, now);
  const statusLabel = subagentStatusLabel(item.status);
  const statusColor = subagentStatusColor(item.status);
  const endedIcon = subagentEndedIcon(item.status);
  const steps = item.steps ?? [];
  const caption = activityCaption(item);
  const result = item.result?.trim() ? item.result : undefined;
  const error = item.error?.trim() ? item.error : undefined;
  const nested = item.parentId !== undefined;
  const canStop = live && onCancel !== undefined;
  const canOpenDesktop = live && item.desktop === true && onOpenDesktop !== undefined;
  // The report and the error say it all once open; repeating their first line above them is noise.
  const headlineCovered = open && ((item.status === 'completed' && result !== undefined) || (item.status === 'failed' && error !== undefined));

  const confirmStop = () =>
    alert('Stop this subagent?', `${title} stops working on its task. Other subagents and the chat carry on.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setStopping(true);
          onCancel?.(item.id);
        },
      },
    ]);

  return (
    <View style={[styles.card, nested && styles.nested, live && styles.cardLive, item.status === 'failed' && styles.cardError]}>
      <Pressable
        onPress={toggle}
        android_ripple={{ color: colors.borderHi }}
        accessibilityRole="button"
        accessibilityLabel={`${nested ? 'Sub-task, ' : ''}${title}, ${statusLabel}. Task: ${taskLine}. ${headline}`}
        accessibilityHint={open ? 'Hides the details' : 'Shows the details'}
        accessibilityState={{ expanded: open }}
      >
        <View style={styles.head}>
          <Ionicons name="git-branch-outline" size={14} color={colors.textMuted} />
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.task} numberOfLines={1}>
            {taskLine}
          </Text>
          {live ? (
            <ActivityIndicator size="small" color={statusColor} style={styles.spinner} />
          ) : endedIcon ? (
            <Ionicons name={endedIcon} size={15} color={statusColor} />
          ) : null}
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={colors.textMuted} />
        </View>
        {headlineCovered ? null : (
          <View style={styles.line}>
            <Text style={styles.headline} numberOfLines={open ? undefined : 2}>
              {headline}
            </Text>
            {live && duration ? <Text style={styles.time}>{duration}</Text> : null}
          </View>
        )}
      </Pressable>
      {open && (
        <View style={styles.body}>
          {item.task.trim() ? <Section title="Task" text={item.task} /> : null}
          <View style={styles.facts}>
            <Text style={styles.stats}>{subagentStats(item, now)}</Text>
            <View style={styles.tags}>
              {nested ? <Tag icon="return-down-forward-outline" text="Sub-task" /> : null}
              {item.background ? <Tag icon="time-outline" text="Background" /> : null}
              {item.desktop ? <Tag icon="desktop-outline" text="Own desktop" /> : null}
            </View>
          </View>
          {steps.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                Activity
                {caption ? <Text style={styles.sectionNote}>{`  ${caption}`}</Text> : null}
              </Text>
              <View style={styles.steps}>
                {steps.map((step) => (
                  <StepRow key={step.id} step={step} live={live} />
                ))}
              </View>
            </View>
          )}
          {result !== undefined && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Result</Text>
              <View style={styles.report}>
                <Markdown text={result} />
              </View>
            </View>
          )}
          {error !== undefined && <Section title="Error" text={error} error />}
          {(canOpenDesktop || canStop) && (
            <View style={styles.actions}>
              {canOpenDesktop && (
                <Pressable
                  onPress={() => onOpenDesktop?.(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`View the desktop of ${title}`}
                  style={({ pressed }) => [styles.btn, styles.btnQuiet, pressed && styles.pressed]}
                >
                  <Ionicons name="desktop-outline" size={15} color={colors.text} />
                  <Text style={[styles.btnText, { color: colors.text }]}>View desktop</Text>
                </Pressable>
              )}
              {canStop && (
                <Pressable
                  onPress={confirmStop}
                  disabled={stopping}
                  accessibilityRole="button"
                  accessibilityLabel={`Stop ${title}`}
                  accessibilityState={{ disabled: stopping }}
                  style={({ pressed }) => [styles.btn, styles.btnStop, (pressed || stopping) && styles.pressed]}
                >
                  {stopping ? <ActivityIndicator size="small" color={colors.danger} /> : <Ionicons name="stop-circle-outline" size={16} color={colors.danger} />}
                  <Text style={[styles.btnText, { color: colors.danger }]}>{stopping ? 'Stopping…' : 'Stop'}</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function Section({ title, text, error }: { title: string; text: string; error?: boolean }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, error && { color: colors.danger }]}>{title}</Text>
      <Text selectable style={[styles.mono, error && { color: '#F2A5A1' }]}>
        {text}
      </Text>
    </View>
  );
}

function Tag({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.tag}>
      <Ionicons name={icon} size={11} color={colors.textMuted} />
      <Text style={styles.tagText}>{text}</Text>
    </View>
  );
}

function StepRow({ step, live }: { step: SubagentStep; live: boolean }) {
  const glyph = stepGlyph(step.status, live);
  const color = stepGlyphColor(glyph);
  const summary = stepSummary(step);
  return (
    <View style={styles.step} accessible accessibilityLabel={`${stepLine(step)}, ${STEP_WORD[glyph]}`}>
      <View style={styles.stepGlyph}>
        {glyph === 'spinner' ? (
          <ActivityIndicator size="small" color={color} style={styles.stepSpinner} />
        ) : (
          <Ionicons name={STEP_ICON[glyph]} size={glyph === 'idle' ? 9 : 12} color={color} />
        )}
      </View>
      <Text style={styles.stepText} numberOfLines={2}>
        <Text style={styles.stepTool}>{stepName(step)}</Text>
        {summary ? <Text style={styles.stepSummary}>{`  ${summary}`}</Text> : null}
      </Text>
    </View>
  );
}

export const SubagentCard = memo(SubagentCardImpl);

const PAD = 10;
const ICON = 14;
const GAP = 6;

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHi,
    overflow: 'hidden',
  },
  nested: { marginLeft: space.md },
  cardLive: { borderColor: 'rgba(0,149,246,0.45)' },
  cardError: { borderColor: 'rgba(237,73,86,0.5)' },
  head: { flexDirection: 'row', alignItems: 'center', gap: GAP, paddingHorizontal: PAD, paddingTop: 7, paddingBottom: 6 },
  name: { flexShrink: 0, maxWidth: '40%', color: colors.textDim, fontSize: 12, fontWeight: '600' },
  task: { flex: 1, color: colors.textMuted, fontSize: 11.5, fontFamily: mono },
  spinner: { transform: [{ scale: 0.7 }] },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingLeft: PAD + ICON + GAP, paddingRight: PAD, paddingBottom: 8 },
  headline: { flex: 1, color: colors.textDim, fontSize: 12, lineHeight: 17 },
  time: { color: colors.textMuted, fontFamily: mono, fontSize: 11, lineHeight: 17 },
  body: { paddingHorizontal: PAD, paddingBottom: PAD, gap: space.sm },
  facts: { gap: space.xs },
  stats: { color: colors.textMuted, fontFamily: mono, fontSize: 11 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.surfaceHi },
  tagText: { color: colors.textDim, fontSize: 10.5, fontWeight: '600' },
  section: { gap: space.xs },
  sectionTitle: { color: colors.textMuted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  sectionNote: { fontWeight: '400', textTransform: 'none', letterSpacing: 0 },
  mono: {
    color: colors.textDim,
    fontFamily: mono,
    fontSize: 11.5,
    lineHeight: 16,
    backgroundColor: colors.bg,
    padding: space.sm,
    borderRadius: radius.sm,
  },
  steps: { gap: 6, backgroundColor: colors.bg, padding: space.sm, borderRadius: radius.sm },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  stepGlyph: { width: 14, height: 16, alignItems: 'center', justifyContent: 'center' },
  stepSpinner: { transform: [{ scale: 0.6 }] },
  stepText: { flex: 1, fontSize: 11.5, lineHeight: 16 },
  stepTool: { color: colors.textDim, fontWeight: '600' },
  stepSummary: { color: colors.textMuted, fontFamily: mono },
  report: { backgroundColor: colors.bg, padding: space.sm, borderRadius: radius.sm },
  actions: { flexDirection: 'row', gap: space.sm },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 36, borderRadius: 8 },
  btnQuiet: { backgroundColor: colors.borderHi },
  btnStop: { backgroundColor: colors.dangerSoft },
  btnText: { fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.75 },
});
