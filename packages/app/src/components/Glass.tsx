import React from 'react';
import { View, type ColorValue, type ViewProps } from 'react-native';
import {
  isLiquidGlassSupported,
  LiquidGlassView,
} from '@callstack/liquid-glass';
import { theme } from '../theme';

type GlassProps = ViewProps & {
  // Interactive glass grows on touch and shimmers (iOS 26+ only).
  interactive?: boolean;
  // Base tint of the glass; lifts it off pure black when there is little
  // content behind it to frost.
  tintColor?: ColorValue;
};

// Real liquid glass on iOS 26+, a plain rounded surface everywhere else.
export function Glass({
  interactive,
  tintColor,
  style,
  children,
  ...rest
}: GlassProps) {
  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        interactive={interactive}
        effect="regular"
        colorScheme="dark"
        tintColor={tintColor}
        style={style}
        {...rest}
      >
        {children}
      </LiquidGlassView>
    );
  }

  return (
    <View
      style={[
        { backgroundColor: tintColor ?? theme.glassFallbackBackground },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
