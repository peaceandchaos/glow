import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';
import { Glass } from './Glass';
import { Icon } from './Icon';
import { theme } from '../theme';

const SIZE = 38;

// Floating glass chevron that scrolls the conversation to the very bottom.
export function ScrollToBottomButton({ onPress }: { onPress: () => void }) {
  return (
    <Animated.View
      entering={ZoomIn.duration(160)}
      exiting={ZoomOut.duration(140)}
    >
      <Pressable onPress={onPress} hitSlop={10}>
        <Glass interactive style={styles.circle}>
          <Icon name="chevron.down" size={18} color={theme.text} />
        </Glass>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
