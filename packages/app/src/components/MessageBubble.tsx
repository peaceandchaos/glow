import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, SlideInDown } from 'react-native-reanimated';
import { NitroImage } from 'react-native-nitro-image';
import type { SFSymbol } from 'sf-symbols-typescript';
import type { Message } from '../state/chatStore';
import { Icon } from './Icon';
import { ShimmerText } from './ShimmerText';
import { theme } from '../theme';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { darkMarkdownStyle } from '../markdownStyle';
import { openWebLink } from '../openWebLink';

// SF Symbols for the (currently no-op) action row beneath a finished reply.
const ACTIONS: SFSymbol[] = [
  'square.on.square', // copy
  'square.and.arrow.up', // share
  'play', // read aloud
  'hand.thumbsup', // good response
  'hand.thumbsdown', // bad response
  'arrow.clockwise', // regenerate
];

const TITLE_BOLD_RE = /^(?:#+\s*)?\*\*(.+?)\*\*$/;
const TITLE_HEADING_RE = /^#+\s+(.+)$/;

// The trace's collapsed label is the reasoning summary's first heading (OpenAI
// summaries open with a "**Title**" line). Before that title finishes streaming
// (or when the summary has no heading) we fall back to "Thinking".
function reasoningLabel(reasoning: string): string {
  const firstLine = reasoning.trimStart().split('\n', 1)[0].trim();
  const bold = TITLE_BOLD_RE.exec(firstLine);
  if (bold) {
    return bold[1].trim();
  }
  const heading = TITLE_HEADING_RE.exec(firstLine);
  if (heading) {
    return heading[1].trim();
  }
  return 'Thinking';
}

type MessageBubbleProps = {
  message: Message;
  onOpenReasoning: (reasoning: string) => void;
};

export const MessageBubble = memo(function ({
  message,
  onOpenReasoning,
}: MessageBubbleProps) {
  if (message.role === 'user') {
    const hasText = message.text.length > 0;
    return (
      // Slides up from the bottom of the screen as it's sent (ChatGPT-style).
      <Animated.View
        style={styles.userRow}
        entering={SlideInDown.easing(Easing.out(Easing.exp)).duration(700)}
      >
        {message.attachments?.length ? (
          <View style={styles.userImages}>
            {message.attachments.map((uri, index) => (
              // NitroImage doesn't clip to its own borderRadius; round via a
              // wrapping View with overflow hidden (same as the composer thumbs).
              <View key={`${uri}:${index}`} style={styles.userImageWrap}>
                <NitroImage
                  image={{ filePath: uri }}
                  style={styles.userImage}
                />
              </View>
            ))}
          </View>
        ) : null}
        {hasText ? (
          <View style={styles.userBubble}>
            <Text style={styles.userText}>{message.text}</Text>
          </View>
        ) : null}
      </Animated.View>
    );
  }

  const isWaiting = message.status === 'streaming' && message.text.length === 0;
  const hasText = message.text.length > 0;
  // Show the collapsible thinking trace once reasoning exists and the answer has
  // started (while waiting we keep the single shimmer line instead).
  const showTrace = !!message.reasoning && !isWaiting;

  return (
    <View style={styles.assistantRow}>
      {showTrace ? (
        <Pressable
          style={styles.traceRow}
          hitSlop={6}
          onPress={() => onOpenReasoning(message.reasoning as string)}
        >
          <Icon name="clock" size={15} color={theme.textSecondary} />
          <Text style={styles.traceLabel} numberOfLines={1}>
            {reasoningLabel(message.reasoning as string)}
          </Text>
          <Icon name="chevron.right" size={13} color={theme.textSecondary} />
        </Pressable>
      ) : null}
      {isWaiting ? (
        // Delay the fade-in so "Thinking" doesn't pop in while the user message
        // is still sliding up; it eases in once that has settled.
        <Animated.View
          style={styles.statusRow}
          entering={FadeIn.delay(450).duration(300)}
        >
          <Icon
            name={
              (message.statusLabel ?? 'Thinking') === 'Responding'
                ? 'text.bubble'
                : 'sparkles'
            }
            size={15}
            color={theme.textSecondary}
          />
          <ShimmerText
            text={message.statusLabel ?? 'Thinking'}
            width={140}
            fontSize={16}
            maxLines={1}
            align="left"
          />
        </Animated.View>
      ) : (
        <EnrichedMarkdownText
          markdown={message.text}
          markdownStyle={darkMarkdownStyle}
          flavor="github"
          streamingAnimation={message.status === 'streaming'}
          onLinkPress={({ url }) => {
            void openWebLink(url);
          }}
        />
      )}
      {message.status === 'error' ? (
        <Text style={styles.error}>Something went wrong. Try again.</Text>
      ) : null}
      {/* Action row beneath a finished reply (visual only for now). */}
      {message.status === 'done' && hasText ? (
        <View style={styles.actionRow}>
          {ACTIONS.map(name => (
            <Pressable key={name} hitSlop={6}>
              <Icon name={name} size={18} color={theme.textSecondary} />
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  userRow: {
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  userImages: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 6,
    maxWidth: '82%',
    marginBottom: 4,
  },
  userImageWrap: {
    width: 180,
    height: 180,
    borderRadius: 18,
    overflow: 'hidden',
  },
  userImage: {
    width: 180,
    height: 180,
  },
  userBubble: {
    maxWidth: '82%',
    backgroundColor: theme.userBubbleBackground,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  userText: {
    color: theme.userBubbleText,
    fontSize: 16,
    lineHeight: 21,
  },
  assistantRow: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  traceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  traceLabel: {
    flex: 1,
    color: theme.textSecondary,
    fontSize: 16,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 22,
    paddingTop: 10,
    paddingBottom: 2,
  },
  error: {
    color: '#D7263D',
    fontSize: 13,
    marginTop: 4,
  },
});
