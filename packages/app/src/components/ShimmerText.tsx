import React, { useMemo } from 'react';
import { useDerivedValue } from 'react-native-reanimated';
import {
  Canvas,
  Text as SkiaText,
  LinearGradient,
  matchFont,
  vec,
  useClock,
  type SkFont,
} from '@shopify/react-native-skia';

type FontWeight = '400' | '500' | '600' | '700' | '800';

type ShimmerTextProps = {
  text: string;
  /** Available width to wrap within (px). */
  width: number;
  fontSize?: number;
  fontWeight?: FontWeight;
  /** Dim base color of the glyphs. */
  baseColor?: string;
  /** Bright color of the moving highlight band. */
  highlightColor?: string;
  /** One full left-to-right sweep, in milliseconds. */
  periodMs?: number;
  maxLines?: number;
  /** Horizontal alignment of each line within `width`. Defaults to 'center'. */
  align?: 'left' | 'center';
};

function wrapText(
  text: string,
  font: SkFont,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';

  for (const word of words) {
    const candidate = cur === '' ? word : `${cur} ${word}`;
    if (cur === '' || font.measureText(candidate).width <= maxWidth) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines) {
        cur = '';
        break;
      }
    }
  }
  if (cur !== '' && lines.length < maxLines) {
    lines.push(cur);
  }

  if (lines.length === maxLines && cur === '' && lines[maxLines - 1] != null) {
    let last = lines[maxLines - 1];
    while (last.length > 0 && font.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.length > 0 ? lines : [''];
}

export function ShimmerText({
  text,
  width,
  fontSize = 14,
  fontWeight = '600',
  baseColor = 'rgba(235,235,245,0.45)',
  highlightColor = 'rgba(255,255,255,0.95)',
  periodMs = 1500,
  maxLines = 3,
  align = 'center',
}: ShimmerTextProps) {
  const font = useMemo(
    () => matchFont({ fontFamily: 'Helvetica', fontSize, fontWeight }),
    [fontSize, fontWeight],
  );

  const { lines, lineHeight, baseline, height } = useMemo(() => {
    const fontMetrics = font.getMetrics();
    const computedLineHeight = Math.ceil(
      fontMetrics.descent - fontMetrics.ascent,
    );
    const wrapped = wrapText(text, font, width, maxLines);
    return {
      lines: wrapped,
      lineHeight: computedLineHeight,
      baseline: Math.ceil(-fontMetrics.ascent),
      height: wrapped.length * computedLineHeight,
    };
  }, [font, text, width, maxLines]);

  const band = Math.max(60, width * 0.5);
  const travel = width + band * 2;
  const clock = useClock();
  const startX = useDerivedValue(
    () => -band + ((clock.value % periodMs) / periodMs) * travel,
  );
  const gradientStart = useDerivedValue(() => vec(startX.value, 0));
  const gradientEnd = useDerivedValue(() => vec(startX.value + band, 0));

  return (
    <Canvas style={{ width, height }}>
      {lines.map((line, i) => {
        const lineWidth = font.measureText(line).width;
        const x = align === 'left' ? 0 : (width - lineWidth) / 2;
        const y = baseline + i * lineHeight;
        return (
          <SkiaText key={`${i}:${line}`} x={x} y={y} text={line} font={font}>
            <LinearGradient
              start={gradientStart}
              end={gradientEnd}
              colors={[baseColor, highlightColor, baseColor]}
              positions={[0, 0.5, 1]}
            />
          </SkiaText>
        );
      })}
    </Canvas>
  );
}
