import { z } from 'zod';

export const contractVersion = 1;
export const idSchema = z.uuid();
// Keys stay open so the server can change its model menu without an app
// build. 'auto' is never a model key, so a picker stays unambiguous.
export const modelKeySchema = z
  .string()
  .regex(/^(?!auto$)[a-z0-9][a-z0-9.-]{0,47}$/u);
export const levelKeySchema = z.string().regex(/^[a-z]{1,16}$/u);
export const pickerSchema = z.union([z.literal('auto'), modelKeySchema]);
export type ModelKey = z.infer<typeof modelKeySchema>;
export type LevelKey = z.infer<typeof levelKeySchema>;
export type Picker = z.infer<typeof pickerSchema>;

export const imageSchema = z
  .string()
  .max(3_000_000)
  .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u);

const historyEntrySchema = z.strictObject({
  id: idSchema,
  parentId: idSchema.nullable(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  images: z.array(imageSchema).max(4),
  complete: z.boolean(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

const responseTextSchema = z.strictObject({
  type: z.enum(['input_text', 'output_text']),
  text: z.string(),
});
const responseImageSchema = z.strictObject({
  type: z.literal('input_image'),
  image_url: imageSchema,
});
const responseMessageSchema = z.strictObject({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.array(z.union([responseTextSchema, responseImageSchema])),
});
const compactedItemSchema = z.strictObject({
  type: z.literal('compaction'),
  id: z.string().optional(),
  encrypted_content: z.string().min(1),
});
const reasoningItemSchema = z.strictObject({
  type: z.literal('reasoning'),
  id: z.string().optional(),
  encrypted_content: z.string().nullable().optional(),
  summary: z.array(
    z.strictObject({ type: z.literal('summary_text'), text: z.string() }),
  ),
});
export const responseInputItemSchema = z.union([
  responseMessageSchema,
  compactedItemSchema,
  reasoningItemSchema,
]);
export type ResponseInputItem = z.infer<typeof responseInputItemSchema>;

export const checkpointSchema = z.strictObject({
  model: modelKeySchema,
  throughMessageId: idSchema,
  method: z.enum(['openai-compaction', 'kimi-summary', 'deepseek-summary']),
  items: z.array(responseInputItemSchema),
  summary: z.string(),
});
export type ContextCheckpoint = z.infer<typeof checkpointSchema>;

export const submissionSchema = z.strictObject({
  version: z.literal(contractVersion),
  attemptId: idSchema,
  chatId: idSchema,
  pathId: idSchema,
  userTurnId: idSchema,
  picker: pickerSchema,
  retryModel: modelKeySchema.nullable(),
  // Absent means the model's default level. Optional, not nullable, so an
  // older input serializes unchanged.
  level: levelKeySchema.optional(),
  history: z.array(historyEntrySchema).min(1),
  checkpoints: z.array(checkpointSchema).max(4),
});
export type Submission = z.infer<typeof submissionSchema>;

// Even a worst-case escaped part is below the Vercel HTTP body limit.
export const contextPartCharacters = 300_000;
const stagedIdentity = {
  attemptId: idSchema,
  chatId: idSchema,
  parts: z.number().int().positive().safe(),
  characters: z.number().int().positive().safe(),
};
const contextPartSchema = z.strictObject({
  kind: z.literal('stage'),
  ...stagedIdentity,
  index: z.number().int().nonnegative().safe(),
  text: z.string().min(1).max(contextPartCharacters),
});
const commitInputSchema = z.strictObject({
  kind: z.literal('commit'),
  ...stagedIdentity,
});
export type ContextPart = z.infer<typeof contextPartSchema>;
export type CommitInput = z.infer<typeof commitInputSchema>;

export const attemptStatusSchema = z.enum([
  'accepted',
  'selecting',
  'compacting',
  'generating',
  'completed',
  'stopped',
  'interrupted',
  'failed',
  'deleted',
]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export function isTerminal(status: AttemptStatus): boolean {
  return (
    status === 'completed' ||
    status === 'stopped' ||
    status === 'interrupted' ||
    status === 'failed' ||
    status === 'deleted'
  );
}

export const attemptSnapshotSchema = z.strictObject({
  version: z.literal(contractVersion),
  attemptId: idSchema,
  chatId: idSchema,
  pathId: idSchema,
  userTurnId: idSchema,
  sequence: z.number().int().nonnegative().safe(),
  status: attemptStatusSchema,
  actualModel: modelKeySchema.nullable(),
  text: z.string(),
  reasoning: z.string(),
  error: z.string().nullable(),
  checkpoint: checkpointSchema.nullable(),
  cancelRequested: z.boolean(),
  delivered: z.boolean(),
});
export type AttemptSnapshot = z.infer<typeof attemptSnapshotSchema>;

const eventIdentity = {
  version: z.literal(contractVersion),
  attemptId: idSchema,
  sequence: z.number().int().positive().safe(),
};
export const jobEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...eventIdentity,
    kind: z.literal('status'),
    status: attemptStatusSchema,
    actualModel: modelKeySchema.nullable(),
  }),
  z.strictObject({
    ...eventIdentity,
    kind: z.literal('provider'),
    wire: z.enum(['responses', 'gateway']),
    raw: z.string(),
  }),
  z.strictObject({
    ...eventIdentity,
    kind: z.literal('snapshot'),
    snapshot: attemptSnapshotSchema,
  }),
]);
export type JobEvent = z.infer<typeof jobEventSchema>;
export type EventPayload =
  | { kind: 'status'; status: AttemptStatus; actualModel: ModelKey | null }
  | { kind: 'provider'; wire: 'responses' | 'gateway'; raw: string }
  | { kind: 'snapshot'; snapshot: AttemptSnapshot };

export const socketCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('submit'), submission: submissionSchema }),
  contextPartSchema,
  commitInputSchema,
  z.strictObject({
    kind: z.literal('attach'),
    attemptId: idSchema,
    after: z.number().int().nonnegative().safe(),
  }),
]);
export type SocketCommand = z.infer<typeof socketCommandSchema>;

export function* submissionCommands(
  submission: Submission,
): Generator<SocketCommand> {
  const text = JSON.stringify(submission);
  if (text.length <= contextPartCharacters) {
    yield { kind: 'submit', submission };
    return;
  }
  const identity = {
    attemptId: submission.attemptId,
    chatId: submission.chatId,
    parts: Math.ceil(text.length / contextPartCharacters),
    characters: text.length,
  };
  for (let index = 0; index < identity.parts; index += 1) {
    yield {
      kind: 'stage',
      ...identity,
      index,
      text: text.slice(
        index * contextPartCharacters,
        (index + 1) * contextPartCharacters,
      ),
    };
  }
  yield { kind: 'commit', ...identity };
}

export const serverMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('detached'), attemptId: idSchema }),
  z.strictObject({
    kind: z.literal('staged'),
    attemptId: idSchema,
    index: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    kind: z.literal('accepted'),
    snapshot: attemptSnapshotSchema,
  }),
  z.strictObject({ kind: z.literal('event'), event: jobEventSchema }),
  z.strictObject({
    kind: z.literal('error'),
    attemptId: idSchema.nullable(),
    message: z.string(),
    status: z.number().int().min(400).max(599).optional(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const seqSchema = z.number().int().nonnegative().safe();
// model is {picker, level}; leaf is {leafId, updatedAt}.
export const chatFieldSchema = z.enum(['title', 'model', 'leaf']);
export type ChatField = z.infer<typeof chatFieldSchema>;
export const chatRowSchema = z.strictObject({
  id: idSchema,
  title: z.string().min(1).max(120),
  picker: pickerSchema,
  level: levelKeySchema.optional(),
  basePathId: idSchema,
  leafId: idSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ChatRow = z.infer<typeof chatRowSchema>;
export const chatPushSchema = z.strictObject({
  ...chatRowSchema.shape,
  dirty: z.array(chatFieldSchema).min(1),
});
// A newer phone may send attachment metadata, which this build does not
// store. Unknown attachment keys and an unreadable list are dropped, so those
// rows still sync.
const attachmentMetaSchema = z.object({
  id: idSchema,
  kind: z.string().max(32),
  mediaType: z.string().max(127),
  name: z.string().max(255),
  bytes: z.number().int().positive(),
});
export const messageRowSchema = z.strictObject({
  id: idSchema,
  chatId: idSchema,
  parentId: idSchema.nullable(),
  pathId: idSchema,
  role: z.enum(['user', 'assistant']),
  status: z.enum(['completed', 'stopped', 'interrupted', 'failed']),
  text: z.string().max(1_000_000),
  reasoning: z.string().max(1_000_000),
  imageCount: z.number().int().min(0).max(4),
  picker: pickerSchema,
  level: levelKeySchema.optional(),
  retryModel: modelKeySchema.nullable(),
  actualModel: modelKeySchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  attachments: z.array(attachmentMetaSchema).max(4).optional().catch(undefined),
});
export type MessageRow = z.infer<typeof messageRowSchema>;
export const syncPushSchema = z.strictObject({
  chats: z.array(chatPushSchema).max(200),
  messages: z.array(messageRowSchema).max(500),
});
export type SyncPush = z.infer<typeof syncPushSchema>;
export const syncPageSchema = z.strictObject({
  chats: z.array(chatRowSchema),
  messages: z.array(messageRowSchema),
  deletedChatIds: z.array(idSchema),
  cursor: seqSchema,
  more: z.boolean(),
});
export type SyncPage = z.infer<typeof syncPageSchema>;
export const searchRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
});
const searchHitSchema = z.strictObject({
  chatId: idSchema,
  messageId: idSchema.nullable(),
  title: z.string(),
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;
export const searchResponseSchema = z.strictObject({
  hits: z.array(searchHitSchema).max(20),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const sessionTokenBytes = 32;
export const sessionTokenSchema = z
  .string()
  .length(Math.ceil((sessionTokenBytes * 4) / 3))
  .regex(/^[A-Za-z0-9_-]+$/u)
  .brand<'SessionToken'>();
export type SessionToken = z.infer<typeof sessionTokenSchema>;

export const sessionRequestSchema = z.strictObject({
  identityToken: z.string().min(1).max(10_000),
  rawNonce: z.string().min(1).max(1_000),
});
export const sessionResponseSchema = z.strictObject({
  token: sessionTokenSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export function decode<T>(
  schema: Pick<z.ZodType<T>, 'parse'>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the common boundary for untrusted JSON and storage values.
  raw: unknown,
): T {
  return schema.parse(raw);
}

export function decodeJson<T>(
  schema: Pick<z.ZodType<T>, 'parse'>,
  text: string,
): T {
  return decode(schema, JSON.parse(text));
}

export function validateAncestry(submission: Submission): void {
  let parentId: string | null = null;
  const ids = new Set<string>();
  for (const entry of submission.history) {
    if (entry.parentId !== parentId || ids.has(entry.id)) {
      throw new Error('Conversation ancestry is inconsistent.');
    }
    if (entry.role === 'assistant' && entry.images.length > 0) {
      throw new Error('Assistant images are not supported in this version.');
    }
    parentId = entry.id;
    ids.add(entry.id);
  }
  const last = submission.history.at(-1);
  if (last?.id !== submission.userTurnId || last.role !== 'user') {
    throw new Error('The current user turn must end the selected path.');
  }
  const models = new Set<ModelKey>();
  for (const checkpoint of submission.checkpoints) {
    if (!ids.has(checkpoint.throughMessageId) || models.has(checkpoint.model)) {
      throw new Error('A context checkpoint does not belong to this path.');
    }
    models.add(checkpoint.model);
  }
}
