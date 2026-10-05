import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass } from './Glass';
import { Icon } from './Icon';
import { theme } from '../theme';

export const Header = React.memo(function ({
  onNewChat,
  onOpenRecents,
}: {
  onNewChat: () => void;
  onOpenRecents: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.row, { paddingTop: insets.top + 6 }]}>
      <Pressable onPress={onOpenRecents} hitSlop={8}>
        <Glass interactive style={styles.circle}>
          <Icon name="line.3.horizontal" />
        </Glass>
      </Pressable>

      <Glass interactive style={styles.namePill}>
        <Text style={styles.name}>Dave</Text>
        <Icon name="chevron.down" size={13} color={theme.textSecondary} />
      </Glass>

      <Pressable onPress={onNewChat} hitSlop={8}>
        <Glass interactive style={styles.circle}>
          <Icon name="square.and.pencil" />
        </Glass>
      </Pressable>
    </View>
  );
});

const CIRCLE = 44;

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Opaque so streaming content that scrolls up disappears behind the header
    // instead of showing through under the status bar.
    backgroundColor: theme.background,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  namePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: CIRCLE,
    paddingHorizontal: 18,
    borderRadius: CIRCLE / 2,
    overflow: 'hidden',
  },
  name: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.text,
  },
});
