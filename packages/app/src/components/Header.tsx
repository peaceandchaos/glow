import React, { useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  cubicBezier,
  useReducedMotion,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  modelLabels,
  modelSchema,
  type ModelKey,
  type Picker,
} from '../../../../shared/contracts';
import { Glass } from './Glass';
import { Icon } from './Icon';
import { theme } from '../theme';

const CIRCLE = 44;
const MENU_GAP = 8;
const OPTION_HEIGHT = 40;
const TOUCH_TARGET = 44;
const optionSlop = {
  top: (TOUCH_TARGET - OPTION_HEIGHT) / 2,
  bottom: (TOUCH_TARGET - OPTION_HEIGHT) / 2,
};
const easeOut = cubicBezier(0.23, 1, 0.32, 1);

export const Header = React.memo(function ({
  shown,
  picker,
  onPickModel,
  onNewChat,
  onOpenRecents,
}: {
  shown: boolean;
  picker: Picker;
  onPickModel: (model: ModelKey) => void;
  onNewChat: () => void;
  onOpenRecents: () => void;
}) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  if (open && !shown) setOpen(false);
  const [pill, setPill] = useState({ x: 0, width: 0 });
  const fade = {
    transitionDuration: reduceMotion ? 80 : 200,
    transitionTimingFunction: easeOut,
  };
  const quick = {
    transitionDuration: reduceMotion ? 80 : 120,
    transitionTimingFunction: easeOut,
  };

  const label = picker === 'auto' ? 'Auto' : modelLabels[picker];
  const pick = (model: ModelKey) => {
    onPickModel(model);
    setOpen(false);
  };
  const measurePill = (event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setPill({ x, width });
  };

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      accessibilityViewIsModal={open}
      onAccessibilityEscape={open ? () => setOpen(false) : undefined}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.scrim,
          { opacity: open ? 1 : 0, transitionProperty: 'opacity', ...fade },
        ]}
        pointerEvents={open ? 'auto' : 'none'}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPressIn={() => setOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss model menu"
        />
      </Animated.View>

      <View style={[styles.row, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => {
            setOpen(false);
            onOpenRecents();
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Recents"
        >
          <Glass interactive style={styles.circle}>
            <Icon name="line.3.horizontal" />
          </Glass>
        </Pressable>

        <Pressable
          onLayout={measurePill}
          onPress={() => setOpen(!open)}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Chooses the model for this chat"
          accessibilityState={{ expanded: open }}
        >
          {({ pressed }) => (
            <Animated.View
              style={{
                transform: [
                  { scale: pressed ? (reduceMotion ? 0.99 : 0.97) : 1 },
                ],
                transitionProperty: 'transform',
                ...quick,
              }}
            >
              <Glass interactive style={styles.namePill}>
                <Text style={styles.name}>{label}</Text>
                <Animated.View
                  style={{
                    transform: [{ rotate: open ? '180deg' : '0deg' }],
                    transitionProperty: 'transform',
                    ...quick,
                  }}
                >
                  <Icon
                    name="chevron.down"
                    size={13}
                    color={theme.textSecondary}
                  />
                </Animated.View>
              </Glass>
            </Animated.View>
          )}
        </Pressable>

        <Pressable
          onPress={() => {
            setOpen(false);
            onNewChat();
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New chat"
        >
          <Glass interactive style={styles.circle}>
            <Icon name="square.and.pencil" />
          </Glass>
        </Pressable>
      </View>

      {/* The menu offers models only. A chat saved on Auto still shows Auto. */}
      <Animated.View
        style={[
          styles.menu,
          {
            top: insets.top + 6 + CIRCLE + MENU_GAP,
            left: pill.x,
            minWidth: pill.width,
            opacity: open ? 1 : 0,
            transform: reduceMotion
              ? []
              : [{ translateY: open ? 0 : -8 }, { scale: open ? 1 : 0.97 }],
            transitionProperty: ['opacity', 'transform'],
            ...fade,
          },
        ]}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityRole="menu"
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
        {modelSchema.options.map(model => {
          const selected = model === picker;
          return (
            <Pressable
              key={model}
              onPress={() => pick(model)}
              hitSlop={optionSlop}
              accessibilityRole="button"
              accessibilityLabel={modelLabels[model]}
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.option,
                selected
                  ? styles.optionSelected
                  : pressed
                    ? styles.optionPressed
                    : null,
              ]}
            >
              <Text style={styles.check}>{selected ? '✓' : ''}</Text>
              <Text style={styles.optionLabel}>{modelLabels[model]}</Text>
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
});

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
  scrim: {
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
  },
  menu: {
    position: 'absolute',
    padding: 6,
    gap: 2,
    borderRadius: 16,
    // Opaque, because React Native has no backdrop blur on iOS and text would
    // show through a translucent panel. This is rgba(28, 28, 30, 0.92) over
    // the black background.
    backgroundColor: '#1A1A1C',
    boxShadow: [
      'inset 0 0 0 0.5px rgba(255, 255, 255, 0.1)',
      '0 12px 32px rgba(0, 0, 0, 0.36)',
      '0 2px 8px rgba(0, 0, 0, 0.18)',
    ].join(', '),
    transformOrigin: 'top center',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: OPTION_HEIGHT,
    paddingLeft: 10,
    paddingRight: 12,
    borderRadius: 12,
  },
  optionSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  optionPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  check: {
    width: 16,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 16,
    textAlign: 'center',
  },
  optionLabel: {
    color: '#EAEAEA',
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 18,
  },
});
