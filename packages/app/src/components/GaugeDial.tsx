import React, { useEffect } from 'react';
import {
  Canvas,
  Circle,
  Group,
  Line,
  Path,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { theme } from '../theme';

const SIZE = 24;
const CENTER = SIZE / 2;
const STROKE = 2.5;
const START = 135;
const SWEEP = 270;
const arc = Skia.Path.Make();
arc.addArc(
  { x: STROKE, y: STROKE, width: SIZE - 2 * STROKE, height: SIZE - 2 * STROKE },
  START,
  SWEEP,
);
const easeOut = Easing.bezier(0.23, 1, 0.32, 1);

// `fraction` runs from 0 (lowest level) to 1 (highest).
export function GaugeDial({ fraction }: { fraction: number }) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(fraction);
  useEffect(() => {
    progress.set(
      reduceMotion
        ? fraction
        : withTiming(fraction, { duration: 240, easing: easeOut }),
    );
  }, [fraction, progress, reduceMotion]);
  const needle = useDerivedValue(() => [
    { rotate: ((START + SWEEP * progress.get()) * Math.PI) / 180 },
  ]);

  return (
    <Canvas style={{ width: SIZE, height: SIZE }}>
      <Path
        path={arc}
        style="stroke"
        strokeWidth={STROKE}
        strokeCap="round"
        color={theme.gaugeOff}
      />
      <Path
        path={arc}
        style="stroke"
        strokeWidth={STROKE}
        strokeCap="round"
        color={theme.text}
        end={progress}
      />
      <Group origin={vec(CENTER, CENTER)} transform={needle}>
        <Line
          p1={vec(CENTER, CENTER)}
          p2={vec(CENTER + 6, CENTER)}
          strokeWidth={2}
          strokeCap="round"
          color={theme.text}
        />
      </Group>
      <Circle cx={CENTER} cy={CENTER} r={2.25} color={theme.text} />
    </Canvas>
  );
}
