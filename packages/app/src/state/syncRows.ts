import {
  chatPushSchema,
  messageRowSchema,
  type ChatField,
  type ChatRow,
  type MessageRow,
  type SyncPush,
} from '../../../../shared/contracts';
import type { ChatRecord, SavedMessage } from './archive';

const encoder = new TextEncoder();
export const bytesOf = (row: MessageRow | ChatRow): number =>
  encoder.encode(JSON.stringify(row)).byteLength;

type ChatFields = Pick<
  ChatRecord,
  'title' | 'picker' | 'level' | 'leafId' | 'updatedAt'
>;
export const fieldHolds: Record<
  ChatField,
  (chat: ChatFields, row: ChatFields) => boolean
> = {
  title: (chat, row) => chat.title === row.title,
  model: (chat, row) => chat.picker === row.picker && chat.level === row.level,
  leaf: (chat, row) =>
    chat.leafId === row.leafId && chat.updatedAt === row.updatedAt,
};

// Null when the server would refuse the row, such as an unfinished reply or a
// text over its limit.
export function messageRow(message: SavedMessage): MessageRow | null {
  const row = messageRowSchema.safeParse({
    id: message.id,
    chatId: message.chatId,
    parentId: message.parentId,
    pathId: message.pathId,
    role: message.role,
    status: message.status,
    text: message.text,
    reasoning: message.reasoning,
    imageCount: message.images.length,
    picker: message.picker,
    level: message.level,
    retryModel: message.retryModel,
    actualModel: message.actualModel,
    error: message.error,
    createdAt: message.createdAt,
  });
  return row.success ? row.data : null;
}

export function chatRow(
  chat: ChatRecord,
  dirty: ChatField[],
): SyncPush['chats'][number] | null {
  const row = chatPushSchema.safeParse({
    id: chat.id,
    title: chat.title,
    picker: chat.picker,
    level: chat.level,
    basePathId: chat.basePathId,
    leafId: chat.leafId,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    dirty,
  });
  return row.success ? row.data : null;
}
