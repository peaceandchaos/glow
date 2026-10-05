import React, { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TrueSheet } from '@lodev09/react-native-true-sheet';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { Icon } from './Icon';
import { darkMarkdownStyle } from '../markdownStyle';
import { theme } from '../theme';

type ReasoningSheetProps = {
  reasoning: string;
  onDismiss: () => void;
};

export const ReasoningSheet = React.memo(function ({
  reasoning,
  onDismiss,
}: ReasoningSheetProps) {
  const insets = useSafeAreaInsets();
  const sheet = useRef<TrueSheet>(null);

  return (
    <TrueSheet
      ref={sheet}
      detents={['auto', 1]}
      initialDetentIndex={0}
      onDidDismiss={onDismiss}
      maxContentHeight={620}
      grabber={true}
    >
      <View style={styles.header}>
        <Pressable onPress={() => sheet.current?.dismiss()} hitSlop={8}>
          <View style={styles.closeButton}>
            <Icon name="xmark" size={15} color={theme.text} />
          </View>
        </Pressable>
        <Text style={styles.title}>Thought process</Text>
        {/* Spacer matching the close button so the title stays centered. */}
        <View style={styles.closeButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <EnrichedMarkdownText
          markdown={reasoning}
          markdownStyle={darkMarkdownStyle}
          flavor="github"
        />
      </ScrollView>
    </TrueSheet>
  );
});

const CLOSE = 32;

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  closeButton: {
    width: CLOSE,
    height: CLOSE,
    borderRadius: CLOSE / 2,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.text,
  },
  scroll: {
    paddingHorizontal: 20,
  },
  scrollContent: {
    paddingTop: 4,
  },
});
