import React from 'react';
import { Pressable, StyleSheet, type PressableProps } from 'react-native';
import Animated, {
  cubicBezier,
  useReducedMotion,
} from 'react-native-reanimated';

const BAR_BUTTON = 40;
const easeOut = cubicBezier(0.23, 1, 0.32, 1);

// Only the inner view dims and shrinks, so a press never moves the button's
// frame or shifts the row.
export function BarButton({
  children,
  ...props
}: Omit<PressableProps, 'children' | 'style'> & {
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <Pressable hitSlop={2} style={styles.button} {...props}>
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.content,
            {
              opacity: pressed ? 0.6 : 1,
              transform: [{ scale: pressed && !reduceMotion ? 0.9 : 1 }],
              transitionProperty: ['opacity', 'transform'],
              transitionDuration: 120,
              transitionTimingFunction: easeOut,
            },
          ]}
        >
          {children}
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: BAR_BUTTON,
    height: BAR_BUTTON,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
