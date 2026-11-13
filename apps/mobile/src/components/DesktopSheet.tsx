import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { alert } from '../alert';
import { desktopDetail, desktopNote, desktopStateColor, desktopStateLabel, listDesktops, MAIN_DESKTOP, pickDesktop, previewAge } from '../desktop';
import * as Haptics from '../haptics';
import { useAppActive, useNow } from '../hooks';
import { useChatSelector, useSession } from '../session';
import { colors, mono, radius } from '../theme';

/** A picture every 3 s is live enough to follow an agent; the next is asked for only after the last came back. */
const PREVIEW_MS = 3000;
/** How often the sheet asks the Mac again which desktops exist and in what state. */
const STATUS_MS = 5000;

type Shot = { key: string; uri: string; aspect: number; at: number };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

export function DesktopSheet({ visible, sessionId, initialKey, onClose }: {
  visible: boolean;
  sessionId: string;
  /** The desktop to show first: `main` (the chat's own, the default) or a subagent's id. */
  initialKey?: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { client } = useSession();
  const status = useChatSelector((s) => s.workspaces[sessionId]);
  const appActive = useAppActive();
  const [picked, setPicked] = useState(initialKey ?? MAIN_DESKTOP);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [busy, setBusy] = useState<'close' | 'wipe' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Every opening starts over on the desktop asked for. Set while rendering, so no frame (and no request) is for the last one.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setPicked(initialKey ?? MAIN_DESKTOP);
      setShot(null);
      setShotError(null);
      setLoadError(null);
      setActionError(null);
    }
  }

  const unsupported = status?.supported === false;
  const desktops = useMemo(() => listDesktops(status?.desktops), [status?.desktops]);
  const selected = pickDesktop(status?.desktops, picked);
  const key = selected.key;
  const own = key === MAIN_DESKTOP;
  const running = !unsupported && selected.state === 'running';
  const canClose = selected.state === 'starting' || selected.state === 'running' || selected.state === 'failed';
  const shown = running && shot?.key === key ? shot : null;
  const detail = desktopDetail(selected);
  const computer = status?.computer;

  // Asks for the desktops when opened, then again while open: a desktop the agent starts meanwhile shows up.
  useEffect(() => {
    if (!visible || !appActive || !client) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      client
        .loadWorkspace(sessionId)
        .then(
          () => {
            if (!stopped) setLoadError(null);
          },
          (e: unknown) => {
            if (!stopped) setLoadError(errorText(e));
          },
        )
        .finally(() => {
          if (!stopped) timer = setTimeout(load, STATUS_MS);
        });
    };
    load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [visible, appActive, client, sessionId]);

  // The picture: one request at a time, the next only after the last came back; an answer for another desktop is dropped.
  useEffect(() => {
    if (!visible || !appActive || !client || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setFetching(true);
      try {
        const { image } = await client.previewWorkspace(sessionId, key);
        if (stopped) return;
        setShot({ key, uri: `data:${image.mime};base64,${image.dataBase64}`, aspect: image.width / image.height, at: Date.now() });
        setShotError(null);
      } catch (e) {
        if (stopped) return;
        setShotError(errorText(e));
      }
      setFetching(false);
      timer = setTimeout(() => void load(), PREVIEW_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      setFetching(false);
    };
  }, [visible, appActive, client, sessionId, key, running, refreshes]);

  useEffect(() => {
    setShotError(null);
    if (!running) setShot(null);
  }, [key, running]);

  const reset = (kind: 'close' | 'wipe') => {
    if (!client) return;
    setBusy(kind);
    setActionError(null);
    (kind === 'close' ? client.resetWorkspace(sessionId, { key }) : client.resetWorkspace(sessionId, { wipe: true }))
      .then(
        () => setShot(null),
        (e: unknown) => setActionError(errorText(e)),
      )
      .finally(() => setBusy(null));
  };

  const confirm = (kind: 'close' | 'wipe') => {
    const text =
      kind === 'close'
        ? {
            title: 'Close this desktop?',
            message: `Programs running on it are closed and anything unsaved there is lost. ${own ? 'The chat gets a fresh desktop the next time the agent needs one. Its browser profile is kept.' : 'The subagent gets a fresh, empty desktop if it needs one again.'}`,
            action: 'Close desktop',
          }
        : {
            title: 'Delete desktop data?',
            message: 'This closes the chat’s desktops and permanently removes their browser profile and saved app state: logins, cookies and settings. The next desktop starts from scratch.',
            action: 'Delete data',
          };
    alert(text.title, text.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: text.action,
        style: 'destructive',
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          reset(kind);
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss desktop view" />
        <View accessibilityViewIsModal style={[styles.sheet, {
          marginTop: insets.top + 24,
          paddingBottom: Math.max(insets.bottom, 16),
          paddingLeft: Math.max(insets.left, 20),
          paddingRight: Math.max(insets.right, 20),
        }]}>
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text accessibilityRole="header" style={styles.title}>Desktop</Text>
              {computer ? (
                <View style={styles.computer}>
                  <View style={[styles.dot, { backgroundColor: computer.online ? colors.ok : colors.textMuted }]} />
                  <Text numberOfLines={1} style={styles.subtitle}>{computer.online ? computer.name : `${computer.name} · offline`}</Text>
                </View>
              ) : null}
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss desktop view" style={styles.close}>
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {unsupported ? (
              <Text style={styles.note}>{status?.reason ?? 'This chat’s computer has no desktops.'}</Text>
            ) : !status ? (
              loadError ? <Text accessibilityRole="alert" style={styles.warning}>{loadError}</Text> : <ActivityIndicator color={colors.textMuted} style={styles.loading} />
            ) : (
              <>
                {loadError ? <Text accessibilityRole="alert" style={styles.warning}>{loadError}</Text> : null}
                {desktops.length > 1 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                    {desktops.map((d) => (
                      <Pressable
                        key={d.key}
                        onPress={() => setPicked(d.key)}
                        accessibilityRole="button"
                        accessibilityLabel={`${d.label}, ${desktopStateLabel(d.state)}`}
                        accessibilityState={{ selected: d.key === key }}
                        style={[styles.chip, d.key === key && styles.chipOn]}
                      >
                        <View style={[styles.dot, { backgroundColor: desktopStateColor(d.state) }]} />
                        <Text numberOfLines={1} style={[styles.chipText, d.key === key && styles.chipTextOn]}>{d.label}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : null}

                <View style={styles.stateRow}>
                  <View style={[styles.dot, { backgroundColor: desktopStateColor(selected.state) }]} />
                  <Text style={styles.state}>{desktopStateLabel(selected.state)}</Text>
                  {detail ? <Text numberOfLines={1} style={styles.detail}>{detail}</Text> : null}
                </View>
                {selected.error ? <Text style={styles.warning}>{selected.error}</Text> : null}

                {running ? (
                  <View style={styles.picture}>
                    {shown ? (
                      <Picture uri={shown.uri} aspect={shown.aspect} />
                    ) : shotError ? null : (
                      <View style={[styles.placeholder, { aspectRatio: selected.width && selected.height ? selected.width / selected.height : 16 / 10 }]}>
                        <ActivityIndicator color={colors.textMuted} />
                      </View>
                    )}
                    <View style={styles.captionRow}>
                      <Caption at={shown?.at} />
                      <Pressable onPress={() => setRefreshes((n) => n + 1)} disabled={fetching} hitSlop={10} accessibilityRole="button" accessibilityLabel="Refresh the picture" accessibilityState={{ disabled: fetching }} style={styles.refresh}>
                        {fetching ? <ActivityIndicator size="small" color={colors.textMuted} /> : <Ionicons name="refresh" size={18} color={colors.textDim} />}
                      </Pressable>
                    </View>
                    {shotError ? <Text accessibilityRole="alert" style={styles.warning}>{shotError}</Text> : null}
                  </View>
                ) : (
                  <Text style={styles.note}>{desktopNote(selected)}</Text>
                )}

                <View style={styles.actions}>
                  <Pressable onPress={() => confirm('close')} disabled={busy !== null || !canClose} accessibilityRole="button" accessibilityState={{ disabled: busy !== null || !canClose }} style={[styles.button, styles.buttonQuiet, (busy !== null || !canClose) && styles.disabled]}>
                    {busy === 'close' ? <ActivityIndicator size="small" color={colors.text} /> : <Ionicons name="power-outline" size={18} color={colors.text} />}
                    <Text style={styles.buttonText}>{busy === 'close' ? 'Closing…' : 'Close desktop'}</Text>
                  </Pressable>
                  {own ? (
                    <Pressable onPress={() => confirm('wipe')} disabled={busy !== null} accessibilityRole="button" accessibilityState={{ disabled: busy !== null }} style={[styles.button, styles.buttonDanger, busy !== null && styles.disabled]}>
                      {busy === 'wipe' ? <ActivityIndicator size="small" color={colors.danger} /> : <Ionicons name="trash-outline" size={18} color={colors.danger} />}
                      <Text style={[styles.buttonText, { color: colors.danger }]}>{busy === 'wipe' ? 'Deleting…' : 'Delete desktop data'}</Text>
                    </Pressable>
                  ) : null}
                </View>
                {actionError ? <Text accessibilityRole="alert" style={styles.warning}>{actionError}</Text> : null}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Its own component so the picture does not redraw while the seconds count. */
const Picture = memo(function Picture({ uri, aspect }: { uri: string; aspect: number }) {
  const source = useMemo(() => ({ uri }), [uri]);
  return <Image source={source} style={[styles.image, { aspectRatio: aspect }]} contentFit="contain" cachePolicy="none" transition={150} accessible accessibilityLabel="Picture of the desktop, view only" />;
});

function Caption({ at }: { at: number | undefined }) {
  const now = useNow(at !== undefined);
  return <Text style={styles.caption} numberOfLines={1}>{at === undefined ? 'View only' : `View only · updated ${previewAge(at, now)}`}</Text>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet: { maxHeight: '92%', backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderHi, paddingTop: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  heading: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  computer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  subtitle: { flexShrink: 1, fontSize: 13, color: colors.textMuted },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surfaceHi },
  content: { gap: 12, paddingBottom: 4 },
  loading: { paddingVertical: 24 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chips: { gap: 8 },
  chip: { maxWidth: 200, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: 'transparent' },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { flexShrink: 1, color: colors.textDim, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: colors.text },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  state: { color: colors.text, fontSize: 15, fontWeight: '600' },
  detail: { flexShrink: 1, color: colors.textMuted, fontFamily: mono, fontSize: 11.5 },
  note: { color: colors.textMuted, fontSize: 14, lineHeight: 21 },
  warning: { color: colors.warn, fontSize: 13, lineHeight: 19 },
  picture: { gap: 8 },
  image: { width: '100%', borderRadius: radius.sm, backgroundColor: colors.bg },
  placeholder: { width: '100%', alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: colors.bg },
  captionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24 },
  caption: { flex: 1, color: colors.textMuted, fontSize: 12 },
  refresh: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  actions: { gap: 10, marginTop: 8 },
  button: { minHeight: 48, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.md },
  buttonQuiet: { backgroundColor: colors.surfaceHi },
  buttonDanger: { backgroundColor: colors.dangerSoft },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
