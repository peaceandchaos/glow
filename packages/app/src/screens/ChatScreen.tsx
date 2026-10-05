import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { type LegendListRef } from '@legendapp/list/react-native';
import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from '@legendapp/list/keyboard';
import {
  useChatStore,
  type Attachment,
  type Message,
} from '../state/chatStore';
import BootSplash from 'react-native-bootsplash';
import { ChatMessages } from '../components/ChatMessages';
import { MessageBubble } from '../components/MessageBubble';
import { Header } from '../components/Header';
import { Composer } from '../components/Composer';
import { EmptyState } from '../components/EmptyState';
import { ScrollToBottomButton } from '../components/ScrollToBottomButton';
import { theme } from '../theme';

// Cap for the anchored user bubble's reserved size (~2 lines + padding), per
// legend-list's AI-chat example.
const ANCHOR_MAX_SIZE = 2 * 21 + 32;

// load this lazily since we only need it when a reasoning trace is available
const ReasoningSheet = React.lazy(() =>
  import('../components/ReasoningSheet').then(m => ({
    default: m.ReasoningSheet,
  })),
);

type ChatScreenProps = {
  onOpenRecents: () => void;
  // Counts chats opened from Recents, including the one already shown.
  openCount: number;
};

export function ChatScreen({ onOpenRecents, openCount }: ChatScreenProps) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const send = useChatStore(state => state.send);
  const stop = useChatStore(state => state.stop);
  const newChat = useChatStore(state => state.newChat);
  const loadOlder = useChatStore(state => state.loadOlder);
  const chatId = useChatStore(state => state.chatId);
  const messagesLength = useChatStore(state => state.messages.length);
  const isStreaming = useChatStore(state => state.isStreaming);
  const [composerHeight, setComposerHeight] = useState(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<View>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);

  const openReasoning = useCallback((text: string) => {
    setReasoning(text);
  }, []);

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble message={item} onOpenReasoning={openReasoning} />
    ),
    [openReasoning],
  );

  // The anchor is the user turn sent last in this launch. A chat that does
  // not show that turn has no anchor.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const anchorIndex = useChatStore(state => {
    for (let index = state.messages.length - 1; index >= 0; index--)
      if (state.messages[index].id === anchorId) return index;
    return undefined;
  });
  // A sent reply is followed once it overflows the reserved space. A reply
  // already streaming when the chat opened, as after a relaunch, has no
  // anchored turn and is followed from the start. A drag pauses either.
  const [overflowedAnchorId, setOverflowedAnchorId] = useState<string | null>(
    null,
  );
  const [resumedChatId, setResumedChatId] = useState<string | null>(null);
  const [pausedChatId, setPausedChatId] = useState<string | null>(null);
  if (isStreaming && anchorIndex == null && resumedChatId !== chatId) {
    setResumedChatId(chatId);
  }
  const tracking =
    (anchorIndex != null && overflowedAnchorId === anchorId) ||
    resumedChatId === chatId;
  const following = tracking && pausedChatId !== chatId;

  // Image messages are taller than the text cap; leave them uncapped so the top
  // of the image lands at the anchor offset instead of being clipped above it.
  const anchorHasImage = useChatStore(state =>
    anchorIndex != null
      ? (state.messages[anchorIndex]?.attachments?.length ?? 0) > 0
      : false,
  );

  const { contentInsetEndAdjustment, onComposerLayout: reportComposerInset } =
    useKeyboardChatComposerInset(listRef, composerRef);
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });

  const onComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setComposerHeight(event.nativeEvent.layout.height);
      reportComposerInset(event);
    },
    [reportComposerInset],
  );

  const onSubmit = useCallback(
    (text: string, attachments: Attachment[]) => {
      const isFirstMessage = messagesLength === 0;
      const userId = send(text, attachments);
      if (userId === null) {
        return 'unsaved';
      }
      setResumedChatId(null);
      setPausedChatId(null);
      setAnchorId(userId);
      scrollMessageToEnd({ animated: !isFirstMessage, closeKeyboard: true });
      return 'saved';
    },
    [messagesLength, send, scrollMessageToEnd],
  );

  // A chat starts at its newest message when it opens and when Recents opens
  // it again while it is shown.
  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: false });
  }, [chatId, openCount]);

  const keyboardOffset = { opened: insets.bottom };

  // The chevron shows whenever the bottom of the conversation isn't visible.
  const onEndVisible = useCallback(
    (visible: boolean) => {
      setShowScrollDown(!visible);
      // Back at the bottom after a manual scroll-up: re-arm tail-follow
      if (visible && tracking) {
        setPausedChatId(null);
      }
    },
    [tracking],
  );

  // A manual drag while the reply streams pauses tail-follow so the user can
  // scroll up (e.g. to read a table)
  const onScrollBeginDrag = useCallback(() => {
    if (tracking) {
      setPausedChatId(chatId);
    }
  }, [chatId, tracking]);

  const scrollToBottom = () => {
    scrollMessageToEnd({ animated: true, closeKeyboard: false });
  };

  return (
    <View style={styles.container}>
      <BootSplash.HideOnDraw fade />
      <ChatMessages>
        {(messages, addedOlder) => (
          <KeyboardAwareLegendList
            ref={listRef}
            style={styles.fill}
            data={messages}
            keyExtractor={(item: Message) => item.id}
            renderItem={renderMessage}
            // Let the bottom contentInset / anchored end-space area still catch scroll touches (RN 0.81+ hit-test bug, facebook/react-native#54123).
            applyWorkaroundForContentInsetHitTestBug
            initialScrollAtEnd
            onStartReached={loadOlder}
            maintainVisibleContentPosition={
              Platform.OS !== 'android'
                ? // Holding rows in place on every data change fights the
                  // anchored send, so only an older page uses it.
                  { data: addedOlder }
                : anchorIndex != null && !following
            }
            keyboardLiftBehavior="whenAtEnd"
            // Match the composer's keyboard offset or a gap opens between the last message and the keyboard.
            keyboardOffset={insets.bottom}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            freeze={freeze}
            anchoredEndSpace={
              anchorIndex != null
                ? {
                    anchorIndex,
                    anchorMaxSize: anchorHasImage ? undefined : ANCHOR_MAX_SIZE,
                    anchorOffset: insets.top + 56,
                    onSizeChanged: size => {
                      if (size <= 0) {
                        setOverflowedAnchorId(anchorId);
                      }
                    },
                  }
                : undefined
            }
            maintainScrollAtEnd={
              following
                ? { on: { dataChange: true, itemLayout: true } }
                : undefined
            }
            // Default threshold is too tight for fast streaming and permanently stops the follow.
            maintainScrollAtEndThreshold={1}
            estimatedItemSize={64}
            estimatedListSize={{ width: windowWidth, height: windowHeight }}
            onEndVisible={onEndVisible}
            onScrollBeginDrag={onScrollBeginDrag}
            contentContainerStyle={[
              styles.listContent,
              { paddingTop: insets.top + 56 },
            ]}
            keyboardDismissMode="interactive"
          />
        )}
      </ChatMessages>

      {messagesLength === 0 ? (
        <EmptyState composerHeight={composerHeight} />
      ) : null}

      <Header onNewChat={newChat} onOpenRecents={onOpenRecents} />

      <KeyboardStickyView
        offset={keyboardOffset}
        style={[styles.scrollDown, { bottom: composerHeight + 10 }]}
        pointerEvents="box-none"
      >
        {showScrollDown ? (
          <ScrollToBottomButton onPress={scrollToBottom} />
        ) : null}
      </KeyboardStickyView>

      <KeyboardStickyView offset={keyboardOffset} style={styles.composer}>
        <Composer
          chatId={chatId}
          composerRef={composerRef}
          onLayout={onComposerLayout}
          onSubmit={onSubmit}
          onStop={stop}
          streaming={isStreaming}
        />
      </KeyboardStickyView>

      {reasoning != null ? (
        <Suspense fallback={null}>
          <ReasoningSheet
            reasoning={reasoning}
            onDismiss={() => setReasoning(null)}
          />
        </Suspense>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  fill: {
    flex: 1,
  },
  composer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  scrollDown: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  listContent: {
    paddingBottom: 4,
  },
});
