import { StyleSheet } from 'react-native';
import type { MarkdownStyle } from 'react-native-enriched-markdown';
import { markdownTokens, theme } from './theme';

const { bodyFontSize, bodyLineHeight, linkColor, codeBackground, headings } =
  markdownTokens;

// react-native-enriched-markdown defaults to light mode; this maps the app's
// dark theme onto its style slots. Typography comes from the shared
// markdownTokens so the streaming renderer and the final render stay in sync.
export const darkMarkdownStyle: MarkdownStyle = {
  paragraph: {
    color: theme.text,
    fontSize: bodyFontSize,
    lineHeight: bodyLineHeight,
  },
  h1: { color: theme.text, fontSize: headings[1].fontSize, fontWeight: '700' },
  h2: { color: theme.text, fontSize: headings[2].fontSize, fontWeight: '700' },
  h3: { color: theme.text, fontSize: headings[3].fontSize, fontWeight: '600' },
  h4: { color: theme.text, fontSize: 16, fontWeight: '600' },
  h5: { color: theme.text, fontSize: 15, fontWeight: '600' },
  h6: { color: theme.text, fontSize: 14, fontWeight: '600' },
  strong: { color: theme.text },
  em: { color: theme.text },
  link: { color: linkColor, underline: true },
  list: { color: theme.text, bulletColor: theme.text, markerColor: theme.text },
  blockquote: { color: theme.textSecondary, borderColor: theme.border },
  code: {
    color: theme.text,
    backgroundColor: codeBackground,
    borderColor: theme.border,
  },
  codeBlock: {
    color: theme.text,
    backgroundColor: codeBackground,
    borderColor: theme.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  thematicBreak: { color: theme.border },
  table: {
    color: theme.text,
    fontSize: bodyFontSize,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    headerBackgroundColor: codeBackground,
    headerTextColor: theme.text,
    rowEvenBackgroundColor: 'transparent',
    rowOddBackgroundColor: 'transparent',
    cellPaddingHorizontal: 12,
    cellPaddingVertical: 8,
  },
};
