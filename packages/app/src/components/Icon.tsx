import React, { type ComponentProps } from 'react';
import { type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView } from 'react-native-nitro-symbols';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons/static';
import type { SFSymbol } from 'sf-symbols-typescript';
import { theme } from '../theme';

// Android has no SF Symbols, so SymbolView renders this fallback there (on iOS
// the real SF Symbol shows and the fallback is never displayed). Map each SF
// Symbol we use to the closest Material Design Icon.
const SF_TO_MDI: Record<string, string> = {
  'line.3.horizontal': 'menu',
  'square.and.pencil': 'square-edit-outline',
  'chevron.down': 'chevron-down',
  'chevron.right': 'chevron-right',
  'chevron.up.chevron.down': 'unfold-more-horizontal',
  plus: 'plus',
  'arrow.up': 'arrow-up',
  'arrow.down': 'arrow-down',
  'stop.fill': 'stop',
  sparkles: 'creation',
  'text.bubble': 'message-outline',
  clock: 'clock-outline',
  'square.on.square': 'content-copy',
  'square.and.arrow.up': 'export-variant',
  play: 'play',
  'hand.thumbsup': 'thumb-up-outline',
  'hand.thumbsdown': 'thumb-down-outline',
  'arrow.clockwise': 'refresh',
  xmark: 'close',
  magnifyingglass: 'magnify',
  gearshape: 'cog-outline',
  camera: 'camera',
  photo: 'image',
  paperclip: 'paperclip',
};

type MdiName = ComponentProps<typeof MaterialDesignIcons>['name'];

type IconProps = {
  name: SFSymbol;
  size?: number;
  color?: ColorValue;
  style?: StyleProp<ViewStyle>;
};

export function Icon({
  name,
  size = 20,
  color = theme.text,
  style,
}: IconProps) {
  const mdiName = (SF_TO_MDI[name] ?? 'help-circle-outline') as MdiName;
  return (
    <SymbolView
      symbolName={name}
      tintColor={color}
      pointSize={size}
      style={style}
      fallback={
        <MaterialDesignIcons
          name={mdiName}
          size={size}
          color={color as string}
        />
      }
    />
  );
}
