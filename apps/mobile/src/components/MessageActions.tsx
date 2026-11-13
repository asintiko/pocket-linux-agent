import { Ionicons } from '@expo/vector-icons';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { alert } from '../alert';
import { colors, radius, space } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

type ActionButtonProps = {
  icon: IconName;
  label: string;
  detail: string;
  onPress: () => void;
};

function ActionButton({ icon, label, detail, onPress }: ActionButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <View style={styles.actionIcon}>
        <Ionicons name={icon} size={19} color={colors.textDim} />
      </View>
      <View style={styles.actionCopy}>
        <Text style={styles.actionLabel}>{label}</Text>
        <Text style={styles.actionDetail}>{detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
    </Pressable>
  );
}

function shareIsSupported(): boolean {
  if (Platform.OS !== 'web') return true;
  const navigatorWithShare = (globalThis as unknown as { navigator?: { share?: unknown } }).navigator;
  return typeof navigatorWithShare?.share === 'function';
}

export function MessageActions({
  text,
  children,
  accessibilityLabel,
  disabled = false,
  style,
}: {
  text: string;
  children: ReactNode;
  accessibilityLabel?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [visible, setVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const canOpen = !disabled && text.trim().length > 0;
  const canShare = shareIsSupported();

  const open = () => setVisible(true);
  const close = () => setVisible(false);
  const copyMessage = async () => {
    try {
      if (Platform.OS === 'web') await navigator.clipboard.writeText(text);
      else Clipboard.setString(text);
    } catch {
      close();
      alert('Could not copy message', 'Clipboard access is unavailable on this device.');
      return;
    }
    close();
    AccessibilityInfo.announceForAccessibility('Message copied to clipboard');
  };
  const shareMessage = () => {
    close();
    try {
      void Share.share({ message: text }, { dialogTitle: 'Share message' }).catch(() => {
        alert('Could not share message', 'Sharing is unavailable on this device.');
      });
    } catch {
      alert('Could not share message', 'Sharing is unavailable on this device.');
    }
  };

  return (
    <>
      <Pressable
        style={style}
        disabled={!canOpen}
        onLongPress={canOpen ? open : undefined}
        onPress={canOpen && Platform.OS === 'web' ? open : undefined}
        delayLongPress={500}
        onAccessibilityTap={canOpen ? open : undefined}
        accessibilityActions={canOpen ? [{ name: 'longpress', label: 'Open message actions' }] : undefined}
        onAccessibilityAction={canOpen ? (event) => {
          if (event.nativeEvent.actionName === 'longpress') open();
        } : undefined}
        accessible={canOpen}
        accessibilityRole={canOpen ? 'button' : undefined}
        accessibilityLabel={canOpen ? (accessibilityLabel ?? 'Message: ' + text) : undefined}
        accessibilityHint={canOpen ? 'Long press or activate for copy and share actions' : undefined}
      >
        {children}
      </Pressable>
      {canOpen ? (
        <Modal
          visible={visible}
          transparent
          animationType="slide"
          statusBarTranslucent
          onRequestClose={close}
        >
          <View style={styles.modalRoot}>
            <Pressable
              style={styles.backdrop}
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close message actions"
            />
            <View
              style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) + space.sm }]}
              accessibilityRole="menu"
              accessibilityLabel="Message actions"
              accessibilityViewIsModal
            >
              <View style={styles.handle} />
              <Text style={styles.title}>Message actions</Text>
              <Text style={styles.preview} numberOfLines={3}>
                {text}
              </Text>
              <ActionButton
                icon="copy-outline"
                label="Copy message"
                detail="Copy text to this device's clipboard"
                onPress={copyMessage}
              />
              {canShare ? (
                <ActionButton
                  icon="share-outline"
                  label="Share message"
                  detail="Choose an app to share this text"
                  onPress={shareMessage}
                />
              ) : null}
              <Pressable
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel="Cancel message actions"
                style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  sheet: {
    width: '100%',
    maxWidth: 560,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHi,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    alignSelf: 'center',
    backgroundColor: colors.borderHi,
    marginBottom: space.md,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: space.xs },
  preview: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginBottom: space.sm },
  action: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceHi,
    marginTop: space.xs,
  },
  actionIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  actionCopy: { flex: 1, gap: 2 },
  actionLabel: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  actionDetail: { color: colors.textMuted, fontSize: 12 },
  cancel: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.surfaceHi,
    marginTop: space.sm,
  },
  cancelText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.72 },
});
