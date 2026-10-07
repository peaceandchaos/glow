import React, {
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  LegendList,
  type LegendListRenderItemProps,
} from '@legendapp/list/react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass } from '../components/Glass';
import { Icon } from '../components/Icon';
import { useChatStore } from '../state/chatStore';
import { filterRecents, recentTime, type Recent } from '../state/recents';
import { SignOutContext } from '../state/signOut';
import type { SearchHit } from '../../../../shared/contracts';
import { theme } from '../theme';

// The time the day labels count from. It moves at the next midnight and when
// the app comes back to the foreground, where timers may not have run.
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const timer = setTimeout(refresh, midnight.getTime() - now);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [now]);
  return now;
}

type RecentsScreenProps = {
  onNewChat: () => void;
  onOpenChat: (chatId: string) => void;
};

export function RecentsScreen({ onNewChat, onOpenChat }: RecentsScreenProps) {
  const insets = useSafeAreaInsets();
  const chats = useChatStore(state => state.recents);
  const serverHits = useChatStore(state => state.serverHits);
  const searchServer = useChatStore(state => state.searchServer);
  const [query, setQuery] = useState('');
  // Typing stays responsive while a long list filters.
  const deferredQuery = useDeferredValue(query);
  const now = useNow();
  const signOut = useContext(SignOutContext);
  const confirmSignOut = () =>
    Alert.alert('Sign out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  const recents = useMemo(
    () =>
      filterRecents(chats, deferredQuery).map((chat): Recent => ({
        id: chat.id,
        title: chat.title,
        time: recentTime(chat.updatedAt, now),
      })),
    [chats, deferredQuery, now],
  );
  // A hit for a chat this phone does not hold cannot open, and one already
  // listed is not repeated.
  const hits = useMemo(() => {
    if (serverHits.query !== query.trim()) return [];
    const listed = new Set(recents.map(recent => recent.id));
    const local = new Map(chats.map(chat => [chat.id, chat.title]));
    return serverHits.hits.flatMap((hit): SearchHit[] => {
      const title = local.get(hit.chatId);
      return title === undefined || listed.has(hit.chatId)
        ? []
        : [{ ...hit, title }];
    });
  }, [serverHits, query, recents, chats]);

  const renderRecent = useCallback(
    ({ item }: LegendListRenderItemProps<Recent>) => (
      <Pressable style={styles.row} onPress={() => onOpenChat(item.id)}>
        <View style={styles.rowText}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.time}>{item.time}</Text>
        </View>
      </Pressable>
    ),
    [onOpenChat],
  );

  return (
    <View style={styles.container}>
      <View style={[styles.topRow, { paddingTop: insets.top + 8 }]}>
        <View style={styles.search}>
          <Icon name="magnifyingglass" size={18} color={theme.textSecondary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search..."
            placeholderTextColor={theme.textSecondary}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            onSubmitEditing={() => searchServer(query)}
          />
        </View>
      </View>

      <LegendList
        data={recents}
        keyExtractor={item => item.id}
        estimatedItemSize={66}
        recycleItems
        ListHeaderComponent={<Text style={styles.section}>History</Text>}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        renderItem={renderRecent}
        ListFooterComponent={
          hits.length > 0 ? (
            <View>
              <Text style={styles.section}>Messages</Text>
              {hits.map(hit => (
                <Pressable
                  key={hit.chatId}
                  style={styles.row}
                  onPress={() => onOpenChat(hit.chatId)}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.title} numberOfLines={1}>
                      {hit.title}
                    </Text>
                    {hit.snippet ? (
                      <Text style={styles.time} numberOfLines={2}>
                        {hit.snippet}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null
        }
      />

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 8 }]}>
        <Pressable style={styles.newChatWrap} onPress={onNewChat} hitSlop={8}>
          <Glass interactive style={styles.newChat}>
            <Icon name="plus" size={16} />
            <Text style={styles.newChatText}>New Chat</Text>
          </Glass>
        </Pressable>
        <Pressable
          onPress={confirmSignOut}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Glass interactive style={styles.circle}>
            <Icon name="gearshape" size={20} />
          </Glass>
        </Pressable>
      </View>
    </View>
  );
}

const CIRCLE = 44;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    paddingHorizontal: 16,
    backgroundColor: theme.glassFallbackBackground,
  },
  searchInput: {
    flex: 1,
    fontSize: 17,
    color: theme.text,
    padding: 0,
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  section: {
    color: theme.textSecondary,
    fontSize: 16,
    fontWeight: '500',
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 8,
  },
  listContent: {
    paddingBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  title: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '600',
  },
  time: {
    color: theme.textSecondary,
    fontSize: 15,
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 10,
  },
  newChatWrap: {
    flex: 1,
  },
  newChat: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    overflow: 'hidden',
  },
  newChatText: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '600',
  },
});
