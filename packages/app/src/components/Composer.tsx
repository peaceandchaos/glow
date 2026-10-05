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
import { Glass } from './Glass';
import { Icon } from './Icon';
import { useAttachments } from '../hooks/useAttachments';
import { useDraft } from '../hooks/useDraft';
import type { Attachment } from '../state/chatStore';
import { theme } from '../theme';

const INPUT_MAX_HEIGHT = 120;

// Shared duration for the attachment pill swell/shrink so the thumbnail fade
// and the height collapse stay in lockstep.
const THUMBS_ANIM_MS = 220;

// The composer keeps its input when the message was not saved.
export type SendResult = 'saved' | 'unsaved';

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
  // Keep its original one-line measurement, but do not use it to size the pill.
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
      <View style={styles.row}>
        <AttachmentMenu onPickPhotos={pickImages} />
        <View style={styles.inputPillWrap}>
          <Glass style={styles.inputPill}>
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
                  <View
                    key={`${attachment.uri}:${index}`}
                    style={styles.thumbWrap}
                  >
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

            <TextInput
              value={value}
              onChangeText={setValue}
              onLayout={onInputLayout}
              autoFocus
              placeholder="Ask about Margelo"
              placeholderTextColor={theme.textSecondary}
              style={[styles.input, collapsedInputStyle]}
              multiline
            />
          </Glass>
        </View>

        {/* While a reply streams, the send arrow becomes a pause button that
            stops the stream. */}
        <Pressable
          onPress={streaming ? onStop : onSend}
          disabled={!streaming && !canSend}
          hitSlop={6}
        >
          <Glass interactive style={styles.circle}>
            <Icon
              name={streaming ? 'stop.fill' : 'arrow.up'}
              size={streaming ? 15 : 20}
              color={
                streaming || canSend ? theme.sendActive : theme.sendInactive
              }
            />
          </Glass>
        </Pressable>
      </View>
    </View>
  );
});

const CIRCLE = 44;
const PILL_VERTICAL_PADDING = 6;

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  inputPillWrap: {
    flex: 1,
  },
  inputPill: {
    minHeight: CIRCLE,
    borderRadius: 24,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: PILL_VERTICAL_PADDING,
    overflow: 'hidden',
  },
  input: {
    fontSize: 16,
    color: theme.text,
    paddingVertical: 4,
    maxHeight: INPUT_MAX_HEIGHT,
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
