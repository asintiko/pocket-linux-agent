import { Ionicons } from '@expo/vector-icons';
import type { WorkspaceStatus } from '@pocket/client-core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { desktopBar } from '../desktop';
import { colors, radius } from '../theme';

/** One line under a chat's header: where its Linux desktop runs and in what state. Tapping opens the picture. */
export function DesktopChip({ status, onPress }: { status: WorkspaceStatus; onPress: () => void }) {
  const insets = useSafeAreaInsets();
  const { name, label, color, more } = desktopBar(status);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name ? `${name}. ` : ''}${label}${more ? `, and ${more} more for subagents` : ''}`}
      accessibilityHint="Shows the desktop"
      style={({ pressed }) => [styles.bar, { paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }, pressed && styles.pressed]}
    >
      <Ionicons name="desktop-outline" size={15} color={colors.textMuted} />
      {name ? (
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
      ) : null}
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.state, { color }]} numberOfLines={1}>
        {label}
      </Text>
      {more > 0 ? (
        <View style={styles.more}>
          <Text style={styles.moreText}>+{more}</Text>
        </View>
      ) : null}
      <View style={styles.spacer} />
      <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { height: 32, flexDirection: 'row', alignItems: 'center', gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pressed: { backgroundColor: colors.surface },
  name: { flexShrink: 1, color: colors.textDim, fontSize: 12, fontWeight: '600' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  state: { flexShrink: 0, fontSize: 12 },
  more: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: colors.surfaceHi },
  moreText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
  spacer: { flex: 1 },
});
