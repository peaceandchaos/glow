// Dark theme. The Margelo logo used on the empty state is the white variant.
export const theme = {
  background: '#000000',
  text: '#FFFFFF',
  textSecondary: '#8E8E93',
  userBubbleBackground: '#1C1C1E',
  userBubbleText: '#FFFFFF',
  // Background used wherever liquid glass is not available (Android, iOS < 26).
  glassFallbackBackground: '#1C1C1E',
  border: '#2C2C2E',
  sendActive: '#FFFFFF',
  sendInactive: '#48484A',
  // The model menu's panel is opaque, because React Native has no backdrop
  // blur on iOS and text would show through a translucent panel. The color is
  // rgba(28, 28, 30, 0.92) over the black background.
  menuBackground: '#1A1A1C',
  menuText: '#EAEAEA',
} as const;

// Shared markdown design tokens. markdownStyle derives the EnrichedMarkdownText
// style from these, so the chat reply and the reasoning trace share one
// typography source and can't drift apart.
export const markdownTokens = {
  bodyFontSize: 16,
  bodyLineHeight: 22,
  linkColor: '#0A84FF',
  codeFontSize: 14,
  codeBackground: theme.userBubbleBackground,
  headings: {
    1: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
    2: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
    3: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  },
} as const;
