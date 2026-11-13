import { Ionicons } from '@expo/vector-icons';
import { MAX_SYSTEM_PROMPT_LENGTH } from '@pocket/protocol';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius } from '../theme';

export function ChatSettings({ visible, title, prompt, connected, saveError, onSave, onClose }: {
  visible: boolean;
  title: string;
  prompt: string;
  connected: boolean;
  saveError?: string;
  onSave: (prompt: string) => boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(prompt);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(prompt);
    setError(null);
    setPending(null);
  }, [visible]);

  useEffect(() => {
    if (pending === null) return;
    if (prompt === pending) {
      setPending(null);
      onClose();
    }
  }, [pending, prompt, onClose]);

  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => {
      setPending(null);
      setError('Save was not confirmed. Your draft is still here; reconnect and try again.');
    }, 10_000);
    return () => clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (pending === null || !saveError) return;
    setPending(null);
    setError(saveError);
  }, [pending, saveError]);

  const saving = pending !== null;
  const changed = draft.trim() !== prompt;
  const close = () => { if (!saving) onClose(); };
  const save = () => {
    if (!connected || saving || !changed) return;
    const next = draft.trim();
    setError(null);
    setPending(next);
    if (!onSave(next)) {
      setPending(null);
      setError('Could not reach your Mac. Your draft has not been cleared.');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Dismiss chat settings" />
        <View accessibilityViewIsModal style={[styles.sheet, {
          marginTop: insets.top + 24,
          paddingBottom: Math.max(insets.bottom, 16),
          paddingLeft: Math.max(insets.left, 20),
          paddingRight: Math.max(insets.right, 20),
        }]}>
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text accessibilityRole="header" style={styles.title}>Chat settings</Text>
              <Text numberOfLines={1} style={styles.subtitle}>{title}</Text>
            </View>
            <Pressable onPress={close} disabled={saving} accessibilityRole="button" accessibilityLabel="Close chat settings" style={styles.close}>
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>System prompt</Text>
              <Text style={styles.badge}>THIS CHAT ONLY</Text>
            </View>
            <Text style={styles.description}>Tell the assistant how to respond in this conversation. Changes apply to your next message.</Text>
            <TextInput
              accessibilityLabel="System prompt"
              value={draft}
              onChangeText={setDraft}
              editable={!saving}
              multiline
              maxLength={MAX_SYSTEM_PROMPT_LENGTH}
              placeholder="For example: Answer concisely and include TypeScript examples."
              placeholderTextColor={colors.textMuted}
              selectionColor={colors.accent}
              style={styles.input}
              textAlignVertical="top"
            />
            <View style={styles.hintRow}>
              <Text style={styles.hint}>Leave empty to use default instructions.</Text>
              <Text style={styles.count}>{draft.length.toLocaleString()} / {MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()}</Text>
            </View>
            {!connected ? <Text accessibilityLiveRegion="polite" style={styles.warning}>Connect to your Mac to save changes.</Text> : null}
            {error ? <Text accessibilityRole="alert" style={styles.warning}>{error}</Text> : null}
            <View style={styles.buttons}>
              <Pressable onPress={() => setDraft('')} disabled={saving || !draft} accessibilityRole="button" style={[styles.clear, (saving || !draft) && styles.disabled]}>
                <Text style={styles.clearText}>Clear prompt</Text>
              </Pressable>
              <Pressable onPress={save} disabled={saving || !connected || !changed} accessibilityRole="button" accessibilityLabel="Save system prompt" style={[styles.save, (saving || !connected || !changed) && styles.disabled]}>
                {saving ? <ActivityIndicator size="small" color={colors.userText} /> : <Ionicons name="checkmark" size={18} color={colors.userText} />}
                <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save changes'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet: { maxHeight: '92%', backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderHi, paddingTop: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  heading: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surfaceHi },
  content: { gap: 12 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  badge: { fontSize: 9, fontWeight: '700', letterSpacing: 0.6, color: colors.accent, backgroundColor: colors.accentSoft, paddingHorizontal: 8, paddingVertical: 5, borderRadius: radius.sm },
  description: { fontSize: 14, lineHeight: 21, color: colors.textMuted },
  input: { minHeight: 164, maxHeight: 260, borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.md, backgroundColor: colors.bg, color: colors.text, padding: 14, fontSize: 15, lineHeight: 22 },
  hintRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, flexShrink: 1 },
  count: { color: colors.textMuted, fontSize: 11, lineHeight: 18, fontVariant: ['tabular-nums'] },
  warning: { color: colors.warn, fontSize: 13, lineHeight: 19 },
  buttons: { flexDirection: 'row', gap: 12, marginTop: 10 },
  clear: { minHeight: 48, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: colors.surfaceHi },
  clearText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  save: { flex: 1, minHeight: 48, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.md, backgroundColor: colors.accent },
  saveText: { color: colors.userText, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
