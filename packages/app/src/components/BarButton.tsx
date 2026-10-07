import React from 'react';
import { Pressable, StyleSheet, type PressableProps } from 'react-native';
import Animated, {
  cubicBezier,
  useReducedMotion,
} from 'react-native-reanimated';

export const BAR_BUTTON = 40;
const easeOut = cubicBezier(0.23, 1, 0.32, 1);

// A composer control. A press dims and shrinks the icon in place; the button's
// frame never moves, so the row does not shift.
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
