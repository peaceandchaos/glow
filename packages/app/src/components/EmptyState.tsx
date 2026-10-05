import React from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { NitroImage } from 'react-native-nitro-image';

// Breathing room kept between the logo and the top of the composer when the
// keyboard is open.
const LOGO_GAP = 1;

// Centered Margelo mark shown before the first message. Rises when the keyboard
// opens so it clears the composer. The lift tracks the measured composer height
// so it stays correct as the composer grows (e.g. an attachment) and across
// devices with different safe-area insets, rather than a fixed magic number.
export function EmptyState({ composerHeight }: { composerHeight: number }) {
  const { progress } = useReanimatedKeyboardAnimation();

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.value * -(composerHeight + LOGO_GAP) }],
  }));

  return (
    <Animated.View
      style={[styles.container, animatedStyle]}
      pointerEvents="none"
    >
      <NitroImage
        image={require('../assets/margelo-logo.png')}
        style={styles.logo}
        resizeMode="contain"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 36,
    height: 36,
    opacity: 0.2,
  },
});
