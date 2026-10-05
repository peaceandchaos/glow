import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import PagerView, {
  type PagerViewOnPageSelectedEvent,
} from 'react-native-pager-view';
import { KeyboardController } from 'react-native-keyboard-controller';
import { RecentsScreen } from './RecentsScreen';
import { ChatScreen } from './ChatScreen';
import { useChatStore } from '../state/chatStore';
import { theme } from '../theme';

const RECENTS_PAGE = 0;
const CHAT_PAGE = 1;

export function RootDrawer() {
  const pagerRef = useRef<PagerView>(null);

  const goToChat = () => pagerRef.current?.setPage(CHAT_PAGE);
  const goToRecents = () => pagerRef.current?.setPage(RECENTS_PAGE);

  const selectedPage = useRef(CHAT_PAGE);
  const onPageSelected = useCallback((event: PagerViewOnPageSelectedEvent) => {
    const page = event.nativeEvent.position;
    if (page !== selectedPage.current) {
      selectedPage.current = page;
      KeyboardController.dismiss();
    }
  }, []);

  const startNewChat = useChatStore(state => state.newChat);
  const showChat = useChatStore(state => state.openChat);

  const newChat = () => {
    startNewChat();
    goToChat();
  };

  const [openCount, setOpenCount] = useState(0);
  const openChat = (chatId: string) => {
    showChat(chatId);
    setOpenCount(count => count + 1);
    goToChat();
  };

  return (
    <View style={styles.root}>
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={CHAT_PAGE}
        onPageSelected={onPageSelected}
      >
        <View key="recents" style={styles.page}>
          <RecentsScreen onNewChat={newChat} onOpenChat={openChat} />
        </View>
        <View key="chat" style={styles.page}>
          <ChatScreen onOpenRecents={goToRecents} openCount={openCount} />
        </View>
      </PagerView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.background,
  },
  pager: {
    flex: 1,
    backgroundColor: theme.background,
  },
  page: {
    flex: 1,
  },
});
