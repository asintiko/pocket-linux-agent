import { Ionicons } from '@expo/vector-icons';
import type { ChatItem } from '@pocket/client-core';
import { PEER_FEATURES, type PermissionDecision } from '@pocket/protocol';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../../src/components/Avatar';
import { ChatRow } from '../../src/components/ChatRow';
import { ChatSettings } from '../../src/components/ChatSettings';
import { ClaudeAvatar } from '../../src/components/ClaudeAvatar';
import { ClaudeComposer, type ComposerActions } from '../../src/components/ClaudeComposer';
import { Composer } from '../../src/components/Composer';
import { DesktopChip } from '../../src/components/DesktopChip';
import { DesktopSheet } from '../../src/components/DesktopSheet';
import { PermissionCard } from '../../src/components/PermissionCard';
import { TypingBubble } from '../../src/components/TypingBubble';
import { makeConversations, type StubConversation } from '../../src/content/stub';
import { buildTimeline } from '../../src/chat-timeline';
import { beginSend, sendConfirmed, type PendingSend } from '../../src/pending-send';
import { personaFor } from '../../src/persona';
import { useChatSelector, useSession } from '../../src/session';
import { markOpened } from '../../src/state/unread';
import { desktopAgentsKey } from '../../src/subagents';
import { colors, ownBubble, radius } from '../../src/theme';

const EMPTY: ChatItem[] = [];

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

function ThreadHeader({
  avatar,
  title,
  subtitle,
  subtitleColor,
  onCall,
  onVideo,
  onSubtitle,
  onSettings,
  customPrompt,
}: {
  avatar: ReactNode;
  title: string;
  subtitle: string;
  subtitleColor?: string;
  onCall?: () => void;
  onVideo?: () => void;
  /** The status line names the computer; tapping it opens the computer picker. */
  onSubtitle?: () => void;
  onSettings?: () => void;
  customPrompt?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View style={[styles.header, { paddingTop: insets.top, height: 60 + insets.top, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={26} color={colors.text} />
      </Pressable>
      {avatar}
      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Pressable onPress={onSubtitle} hitSlop={6}>
          <Text style={[styles.subtitle, subtitleColor ? { color: subtitleColor } : null]} numberOfLines={1}>
            {subtitle}
          </Text>
        </Pressable>
      </View>
      <Pressable onPress={onCall} disabled={!onCall} hitSlop={6} accessibilityRole="button" accessibilityLabel="Voice call" style={styles.headerAction}>
        <Ionicons name="call-outline" size={24} color={colors.text} />
      </Pressable>
      <Pressable onPress={onVideo} disabled={!onVideo} hitSlop={6} accessibilityRole="button" accessibilityLabel="Activity" style={styles.headerAction}>
        <Ionicons name="pulse-outline" size={24} color={colors.text} />
      </Pressable>
      {onSettings ? (
        <Pressable onPress={onSettings} hitSlop={6} accessibilityRole="button" accessibilityLabel="Chat settings" accessibilityHint={customPrompt ? 'Custom system prompt is set' : 'Set instructions for this conversation'} style={styles.headerAction}>
          <Ionicons name="options-outline" size={24} color={customPrompt ? colors.accent : colors.text} />
        </Pressable>
      ) : null}
    </View>
  );
}

function ClaudeThread({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { client, credentials } = useSession();
  // Field by field: a chat must not re-render for every word streamed into another chat.
  const session = useChatSelector((s) => s.sessions.find((x) => x.sessionId === id));
  const thread = useChatSelector((s) => s.threads[id]) ?? EMPTY;
  const loaded = useChatSelector((s) => s.loaded[id] === true);
  const allPermissions = useChatSelector((s) => s.permissions);
  const connection = useChatSelector((s) => s.connection);
  const brainOnline = useChatSelector((s) => s.brainOnline);
  const configureError = useChatSelector((s) => s.configureErrors[id]);
  const models = useChatSelector((s) => s.models);
  const computers = useChatSelector((s) => s.computers);
  // The client's own `supportsWorkspaces` is a getter and does not re-render; the same fact from the state does.
  const workspacesSupported = useChatSelector((s) => s.host?.features?.includes(PEER_FEATURES.workspaces) === true);
  const workspace = useChatSelector((s) => s.workspaces[id]);
  const keyboardVisible = useKeyboardVisible();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [desktopKey, setDesktopKey] = useState('main');
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const [confirmedSend, setConfirmedSend] = useState(0);

  const permissions = useMemo(() => allPermissions.filter((p) => p.sessionId === id), [allPermissions, id]);
  const persona = useMemo(() => personaFor(id), [id]);
  const data = useMemo(() => buildTimeline(thread).reverse(), [thread]);
  const running = session?.state === 'running' || session?.state === 'waiting_permission';
  const updatedAt = session?.updatedAt ?? 0;
  const sessionState = session?.state;
  const desktopAgents = useMemo(() => desktopAgentsKey(thread), [thread]);

  useEffect(() => {
    markOpened(id);
    return () => markOpened(id);
  }, [id]);

  useEffect(() => {
    if (updatedAt > 0) markOpened(id);
  }, [id, updatedAt]);

  useEffect(() => {
    if (client && !loaded && connection === 'online') client.loadHistory(id);
  }, [client, id, loaded, connection]);

  useEffect(() => {
    if (client && connection === 'online' && brainOnline && models.length === 0) client.loadModels();
  }, [client, connection, brainOnline, models.length]);

  // The chat's desktops: when it opens, when its turn starts or ends, and when a subagent with a desktop of its own starts or ends.
  useEffect(() => {
    if (!client || !workspacesSupported || connection !== 'online' || !brainOnline) return;
    client.loadWorkspace(id).catch(() => {});
  }, [client, id, workspacesSupported, connection, brainOnline, sessionState, desktopAgents]);

  useEffect(() => {
    if (!pendingSend) return;
    if (sendConfirmed(pendingSend, thread)) {
      setPendingSend(null);
      setConfirmedSend((version) => version + 1);
    }
  }, [pendingSend, thread]);

  useEffect(() => {
    if (pendingSend?.phase !== 'sending') return;
    const timer = setTimeout(() => setPendingSend((pending) => pending ? { ...pending, phase: 'unconfirmed' } : null), 15_000);
    return () => clearTimeout(timer);
  }, [pendingSend]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const savePrompt = useCallback((systemPrompt: string) => client?.configure(id, { systemPrompt }) ?? false, [client, id]);
  // Stable: every message row takes these, and a changed prop would redraw all of them.
  const cancelSubagent = useCallback((subagentId: string) => void client?.cancelSubagent(id, subagentId), [client, id]);
  const openDesktop = useCallback((key: string) => {
    setDesktopKey(key);
    setDesktopOpen(true);
  }, []);
  const openOwnDesktop = useCallback(() => openDesktop('main'), [openDesktop]);
  const closeDesktop = useCallback(() => setDesktopOpen(false), []);

  const actions = useMemo<ComposerActions>(
    () => ({
      loadModels: () => void client?.loadModels(),
      send: (text, attachments) => {
        if (!client || !loaded || connection !== 'online' || !brainOnline || pendingSend) return false;
        const sent = client.send(id, text, attachments.map(({ mime, dataBase64, name }) => ({ mime, dataBase64, ...(name ? { name } : {}) })));
        if (sent && text !== '/compact') setPendingSend(beginSend(text, thread, attachments, credentials?.deviceId));
        return sent;
      },
      stop: () => void client?.interrupt(id),
      recoverSend: () => setPendingSend((pending) => pending?.phase === 'unconfirmed' ? null : pending),
      configure: (patch) => void client?.configure(id, patch),
      newChat: () => {
        client
          ?.createSession()
          .then((next) => router.replace({ pathname: '/direct/[id]', params: { id: next } }))
          .catch(() => {});
      },
      agents: () => router.push('/direct/activity'),
      kill: () => void client?.kill(),
    }),
    [client, id, router, loaded, connection, brainOnline, pendingSend?.phase, thread, credentials?.deviceId],
  );

  const respond = useCallback(
    (requestId: string, decision: PermissionDecision) => {
      client?.respondPermission(requestId, decision);
    },
    [client],
  );

  const last = thread[thread.length - 1];
  const working = session?.state === 'running' && !(last?.type === 'assistant' && last.streaming);
  const computer = useMemo(
    () => computers.find((c) => c.deviceId === session?.executorId && (!c.capabilities || c.capabilities.includes('tools'))),
    [session?.executorId, computers],
  );
  const macOnline = connection === 'online' && brainOnline;
  const projectName = session?.project?.split(/[\\/]/).filter(Boolean).pop();
  const active = macOnline && (computer ? computer.online : true);
  const status = !session
    ? ''
    : !macOnline
      ? 'Mac offline · reconnecting'
      : pendingSend?.phase === 'sending'
        ? 'Sending…'
        : session.state === 'running'
      ? 'Typing…'
      : session.state === 'waiting_permission'
        ? 'Waiting for approval'
        : !computer
            ? `Active now · Mac${projectName ? ` · ${projectName}` : ''}`
            : computer.online
              ? `Active now · ${computer.name}${projectName ? ` · ${projectName}` : ''}`
              : `${computer.name} offline`;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThreadHeader
        avatar={<ClaudeAvatar size={36} active={active} persona={persona} />}
        title={persona.name}
        subtitle={status}
        subtitleColor={session?.state === 'waiting_permission' ? colors.warn : undefined}
        onCall={() => router.push({ pathname: '/direct/call', params: { id } })}
        onVideo={actions.agents}
        onSubtitle={() => router.push({ pathname: '/direct/computers', params: { sessionId: id } })}
        onSettings={session ? () => setSettingsOpen(true) : undefined}
        customPrompt={Boolean(session?.systemPrompt)}
      />

      {workspacesSupported && workspace?.supported ? <DesktopChip status={workspace} onPress={openOwnDesktop} /> : null}

      <FlatList
        data={data}
        inverted
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => item.type === 'date' ? (
          <View style={styles.dateRow}><Text style={styles.dateText}>{item.label}</Text></View>
        ) : <ChatRow item={item.item} persona={persona} onCancelSubagent={cancelSubagent} onOpenDesktop={openDesktop} />}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={[styles.list, { paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        ListHeaderComponent={pendingSend ? <ChatRow item={pendingSend.item} persona={persona} delivery={pendingSend.phase} onCancelSubagent={cancelSubagent} onOpenDesktop={openDesktop} /> : working ? <TypingBubble persona={persona} /> : undefined}
        ListEmptyComponent={
          pendingSend ? undefined : loaded ? (
            <View style={[styles.empty, { transform: [{ scaleY: -1 }] }]}>
              <ClaudeAvatar size={72} persona={persona} />
              <Text style={styles.emptyName}>{persona.name}</Text>
              <Text style={styles.emptyText}>Send a message to start the conversation.</Text>
              <Pressable onPress={() => setSettingsOpen(true)} accessibilityRole="button" style={styles.emptyAction}>
                <Ionicons name="options-outline" size={16} color={colors.accent} />
                <Text style={styles.emptyActionText}>{session?.systemPrompt ? 'Edit chat instructions' : 'Set chat instructions'}</Text>
              </Pressable>
            </View>
          ) : !macOnline ? (
            <View style={[styles.empty, { transform: [{ scaleY: -1 }] }]}>
              <Ionicons name="cloud-offline-outline" size={36} color={colors.textMuted} />
              <Text style={styles.emptyName}>Your Mac is offline</Text>
              <Text style={styles.emptyText}>Your conversation will load when it reconnects.</Text>
            </View>
          ) : (
            <View style={[styles.empty, { transform: [{ scaleY: -1 }] }]}>
              <ActivityIndicator color={colors.text} />
            </View>
          )
        }
      />

      <View style={[styles.bottom, { paddingBottom: keyboardVisible ? 8 : insets.bottom + 8, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }]}>
        {permissions.map((p) => (
          <PermissionCard key={p.requestId} request={p} onRespond={respond} />
        ))}
        <ClaudeComposer running={running} session={session} models={models} actions={actions} sendState={pendingSend?.phase ?? 'idle'} confirmedSend={confirmedSend} />
      </View>
      <ChatSettings visible={settingsOpen} title={session?.title || persona.name} prompt={session?.systemPrompt ?? ''} connected={macOnline && Boolean(session)} saveError={configureError} onSave={savePrompt} onClose={closeSettings} />
      <DesktopSheet visible={desktopOpen} sessionId={id} initialKey={desktopKey} onClose={closeDesktop} />
    </KeyboardAvoidingView>
  );
}

function StubThread({ conversation }: { conversation: StubConversation }) {
  const insets = useSafeAreaInsets();
  const data = useMemo(() => [...conversation.messages].reverse(), [conversation]);
  return (
    <View style={styles.root}>
      <ThreadHeader
        avatar={<Avatar uri={conversation.person.avatar} size={36} />}
        title={conversation.person.username}
        subtitle={conversation.active ? 'Active now' : conversation.name}
      />
      <FlatList
        data={data}
        inverted
        keyExtractor={(m) => m.id}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
        renderItem={({ item }) =>
          item.mine ? (
            <View style={styles.mineWrap}>
              <LinearGradient colors={ownBubble} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.bubble}>
                <Text style={styles.mineText}>{item.text}</Text>
              </LinearGradient>
            </View>
          ) : (
            <View style={styles.theirsWrap}>
              <Avatar uri={conversation.person.avatar} size={28} />
              <View style={[styles.bubble, styles.theirsBubble]}>
                <Text style={styles.mineText}>{item.text}</Text>
              </View>
            </View>
          )
        }
      />
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 8 }]}>
        <Composer readOnly />
      </View>
    </View>
  );
}

export default function DirectThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversation = useMemo(() => (id.startsWith('stub-') ? makeConversations().find((c) => c.id === id) : undefined), [id]);
  return conversation ? <StubThread key={id} conversation={conversation} /> : <ClaudeThread key={id} id={id} />;
}

function Separator() {
  return <View style={{ height: 6 }} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  headerAction: { width: 34, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  list: { paddingHorizontal: 12, paddingVertical: 12, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  emptyName: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 4 },
  emptyText: { color: colors.textMuted, textAlign: 'center', fontSize: 14, lineHeight: 20 },
  emptyAction: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, marginTop: 8 },
  emptyActionText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  dateRow: { alignItems: 'center', paddingVertical: 14 },
  dateText: { color: colors.textMuted, fontSize: 11, fontWeight: '600', backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5 },
  bottom: { paddingHorizontal: 12, paddingTop: 6, gap: 8 },
  mineWrap: { alignItems: 'flex-end', paddingLeft: 64 },
  theirsWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingRight: 64 },
  bubble: { borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10 },
  theirsBubble: { backgroundColor: colors.bubble, flexShrink: 1 },
  mineText: { color: colors.userText, fontSize: 15, lineHeight: 21 },
});
