import React, { useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { NitroImage } from 'react-native-nitro-image';
import { AttachmentMenu } from './AttachmentMenu';
import { BarButton } from './BarButton';
import { EffortGauge } from './EffortGauge';
import { Glass } from './Glass';
import { Icon } from './Icon';
import { useAttachments } from '../hooks/useAttachments';
import { useDictation } from '../hooks/useDictation';
import { useDraft } from '../hooks/useDraft';
import type { Attachment } from '../state/chatStore';
import { theme } from '../theme';

const INPUT_MAX_HEIGHT = 120;

// Shared duration for the attachment pill swell/shrink so the thumbnail fade
// and the height collapse stay in lockstep.
const THUMBS_ANIM_MS = 220;

// The composer keeps its input when the message was not saved.
export type SendResult = 'saved' | 'unsaved';

const afterText = (text: string, transcript: string) =>
  text.length === 0 || /\s$/u.test(text)
    ? text + transcript
    : `${text} ${transcript}`;

type ComposerProps = {
  chatId: string;
  onSubmit: (text: string, attachments: Attachment[]) => SendResult;
  onStop: () => void;
  streaming: boolean;
  composerRef: React.RefObject<View | null>;
  onLayout: (event: LayoutChangeEvent) => void;
};

export const Composer = React.memo(function ({
  chatId,
  onSubmit,
  onStop,
  streaming,
  composerRef,
  onLayout,
}: ComposerProps) {
  const insets = useSafeAreaInsets();
  const [{ text: value, attachments }, changeDraft] = useDraft(chatId);
  const setValue = (text: string) => changeDraft(draft => ({ ...draft, text }));
  const { pickImages, removeAttachment } = useAttachments(changeDraft);
  const canSend = value.trim().length > 0 || attachments.length > 0;
  const dictation = useDictation();
  const listening = dictation?.listening ?? false;

  const onSend = () => {
    if (!canSend) {
      return;
    }
    if (onSubmit(value, attachments) === 'unsaved') {
      return;
    }
    changeDraft(() => ({ text: '', attachments: [] }));
  };

  // The thumbnail strip lives in a height-clipped container so the pill can
  // smoothly swell/shrink as images are added/removed.
  const hasAttachments = attachments.length > 0;
  const [thumbsContentHeight, setThumbsContentHeight] = useState(0);
  const thumbsStyle = useAnimatedStyle(() => ({
    height: withTiming(hasAttachments ? thumbsContentHeight : 0, {
      duration: THUMBS_ANIM_MS,
      easing: Easing.inOut(Easing.ease),
    }),
    opacity: withTiming(hasAttachments ? 1 : 0, {
      duration: THUMBS_ANIM_MS,
      easing: Easing.inOut(Easing.ease),
    }),
  }));

  // Keep the last non-empty attachment list so the thumbnails stay mounted
  // while the pill collapses.
  const [displayedAttachments, setDisplayedAttachments] = useState(attachments);
  if (hasAttachments && displayedAttachments !== attachments) {
    setDisplayedAttachments(attachments);
  }

  // iOS can retain a multiline TextInput's expanded height after clearing it.
  // Keep its original one-line measurement, but do not use it to size the bar.
  const [oneLineHeight, setOneLineHeight] = useState<number>();
  const onInputLayout = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.height);
    setOneLineHeight(current => current ?? measured);
  };
  const collapsedInputStyle =
    value.length === 0 && oneLineHeight != null
      ? { height: oneLineHeight }
      : undefined;

  return (
    <View
      ref={composerRef}
      onLayout={onLayout}
      style={[styles.container, { paddingBottom: insets.bottom + 8 }]}
    >
      <Glass style={styles.bar}>
        <Animated.View
          style={[styles.thumbsClip, thumbsStyle]}
          pointerEvents={hasAttachments ? 'auto' : 'none'}
        >
          <View
            style={styles.thumbs}
            onLayout={event => {
              const nextHeight = Math.ceil(event.nativeEvent.layout.height);
              setThumbsContentHeight(current =>
                Math.abs(current - nextHeight) <= 1 ? current : nextHeight,
              );
            }}
          >
            {displayedAttachments.map((attachment, index) => (
              <View key={`${attachment.uri}:${index}`} style={styles.thumbWrap}>
                <NitroImage
                  image={{ filePath: attachment.uri }}
                  style={styles.thumb}
                />
                <Pressable
                  style={styles.thumbRemove}
                  hitSlop={8}
                  onPress={() => removeAttachment(index)}
                >
                  <View style={styles.thumbRemoveBadge}>
                    <Icon name="xmark" size={11} color="#FFFFFF" />
                  </View>
                </Pressable>
              </View>
            ))}
          </View>
        </Animated.View>

        <View style={styles.row}>
          <AttachmentMenu onPickPhotos={pickImages} />
          <TextInput
            value={value}
            onChangeText={setValue}
            onLayout={onInputLayout}
            autoFocus
            placeholder={listening ? 'Listening…' : 'Ask anything'}
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, collapsedInputStyle]}
            multiline
          />
          <EffortGauge />
          {dictation ? (
            <BarButton
              onPress={() =>
                dictation.toggle(transcript =>
                  setValue(afterText(value, transcript)),
                )
              }
              accessibilityRole="button"
              accessibilityLabel={listening ? 'Stop dictation' : 'Dictate'}
              accessibilityState={{ selected: listening }}
            >
              <Animated.View
                style={[styles.circle, listening && styles.recording, fill]}
              >
                <Icon
                  name={listening ? 'waveform' : 'mic'}
                  size={17}
                  color={theme.text}
                />
              </Animated.View>
            </BarButton>
          ) : null}
          {/* While a reply streams, the send arrow becomes a stop button. */}
          <BarButton
            onPress={streaming ? onStop : onSend}
            disabled={!streaming && !canSend}
            accessibilityRole="button"
            accessibilityLabel={streaming ? 'Stop' : 'Send'}
          >
            <Animated.View
              style={[
                styles.circle,
                streaming || canSend ? styles.sendActive : styles.sendInactive,
                fill,
              ]}
            >
              <Icon
                name={streaming ? 'stop.fill' : 'arrow.up'}
                size={streaming ? 13 : 16}
                color={
                  streaming || canSend ? theme.background : theme.textSecondary
                }
              />
            </Animated.View>
          </BarButton>
        </View>
      </Glass>
    </View>
  );
});

const CIRCLE = 32;
const fill = {
  transitionProperty: 'backgroundColor',
  transitionDuration: 150,
} as const;

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  bar: {
    borderRadius: 26,
    padding: 6,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: theme.text,
    paddingTop: 10,
    paddingBottom: 10,
    paddingHorizontal: 4,
    maxHeight: INPUT_MAX_HEIGHT,
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recording: {
    backgroundColor: theme.recording,
  },
  sendActive: {
    backgroundColor: theme.sendActive,
  },
  sendInactive: {
    backgroundColor: theme.sendInactive,
  },
  thumbsClip: {
    overflow: 'hidden',
  },
  thumbs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 2,
    paddingBottom: 8,
  },
  thumbWrap: {
    width: 120,
    height: 120,
    borderRadius: 18,
    overflow: 'hidden',
  },
  thumb: {
    width: 120,
    height: 120,
    borderRadius: 16,
  },
  thumbRemove: {
    position: 'absolute',
    top: 6,
    right: 6,
  },
  thumbRemoveBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
