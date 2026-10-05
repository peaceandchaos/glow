import { useCallback, useEffect, useState } from 'react';
import { type Attachment, useChatStore } from '../state/chatStore';

export type Draft = { text: string; attachments: Attachment[] };
export type ChangeDraft = (change: (draft: Draft) => Draft) => void;

const empty: Draft = { text: '', attachments: [] };

export function useDraft(chatId: string): [Draft, ChangeDraft] {
  const savedText = useChatStore(state => state.draftText);
  const saveDraftAfterPause = useChatStore(state => state.saveDraftAfterPause);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(
    () => new Map(),
  );
  const draft = drafts.get(chatId);
  if (draft === undefined)
    setDrafts(
      new Map(drafts).set(chatId, { ...empty, text: savedText(chatId) }),
    );
  const changeDraft = useCallback<ChangeDraft>(
    change =>
      setDrafts(previous =>
        new Map(previous).set(chatId, change(previous.get(chatId) ?? empty)),
      ),
    [chatId],
  );
  const text = draft?.text;
  useEffect(() => {
    if (text !== undefined) saveDraftAfterPause(chatId, text);
  }, [chatId, text, saveDraftAfterPause]);
  return [draft ?? empty, changeDraft];
}
