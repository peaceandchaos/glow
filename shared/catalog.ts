import { z } from 'zod';
import {
  levelKeySchema,
  modelKeySchema,
  type LevelKey,
  type ModelKey,
  type Picker,
} from './contracts';

const labelSchema = z.string().min(1).max(40);
const levelOptionSchema = z.object({ key: levelKeySchema, label: labelSchema });
const modelEntrySchema = z.object({
  key: modelKeySchema,
  label: labelSchema,
  transport: z.enum(['http', 'socket']),
  levels: z.array(z.unknown()),
  defaultLevel: z.unknown(),
});
const envelopeSchema = z.object({
  auto: z.boolean(),
  models: z.array(z.unknown()),
});

export type CatalogModel = {
  key: ModelKey;
  label: string;
  transport: 'http' | 'socket';
  // Empty means the model has no level control.
  levels: z.infer<typeof levelOptionSchema>[];
  // Null means the provider default: the request omits the parameter.
  defaultLevel: LevelKey | null;
};
// The first model is the fallback model and the first chat's model.
export type Catalog = {
  auto: boolean;
  models: [CatalogModel, ...CatalogModel[]];
};

// Lenient on purpose: one unreadable entry must not freeze an app's menu.
export function parseCatalog(text: string): Catalog | null {
  let envelope;
  try {
    envelope = envelopeSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
  if (!envelope.success) return null;
  const kept: CatalogModel[] = [];
  for (const raw of envelope.data.models) {
    const entry = modelEntrySchema.safeParse(raw);
    if (!entry.success || kept.some(model => model.key === entry.data.key))
      continue;
    const levels = entry.data.levels.flatMap(level => {
      const option = levelOptionSchema.safeParse(level);
      return option.success ? [option.data] : [];
    });
    const fallback = levels.find(
      option => option.key === entry.data.defaultLevel,
    );
    kept.push({
      key: entry.data.key,
      label: entry.data.label,
      transport: entry.data.transport,
      levels,
      defaultLevel: fallback?.key ?? null,
    });
  }
  const [first, ...rest] = kept;
  return first ? { auto: envelope.data.auto, models: [first, ...rest] } : null;
}

type Choice =
  | { kind: 'auto' }
  | { kind: 'model'; model: CatalogModel; level: LevelKey | null };

// Stored choices are never rewritten: a model or level the catalog no longer
// offers resolves here, and comes back if the catalog offers it again.
export function resolveChoice(
  catalog: Catalog,
  picker: Picker,
  level: LevelKey | undefined,
): Choice {
  if (picker === 'auto' && catalog.auto) return { kind: 'auto' };
  const found = catalog.models.find(entry => entry.key === picker);
  const entry = found ?? catalog.models[0];
  const kept = found?.levels.some(option => option.key === level)
    ? level
    : undefined;
  return { kind: 'model', model: entry, level: kept ?? entry.defaultLevel };
}

const openLevels = [
  { key: 'none', label: 'None' },
  { key: 'low', label: 'Low' },
  { key: 'high', label: 'High' },
  { key: 'max', label: 'Max' },
];
const gptLevels = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'xhigh', label: 'Extra high' },
  { key: 'max', label: 'Max' },
];

// The server's default menu, for an app that has not fetched the catalog yet.
export const bakedCatalog: Catalog = {
  auto: true,
  models: [
    {
      key: 'deepseek',
      label: 'DeepSeek V4.1 Flash',
      transport: 'http',
      levels: openLevels,
      defaultLevel: null,
    },
    {
      key: 'kimi',
      label: 'Kimi K3',
      transport: 'http',
      levels: openLevels,
      defaultLevel: null,
    },
    {
      key: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      transport: 'socket',
      levels: gptLevels,
      defaultLevel: 'medium',
    },
    {
      key: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      transport: 'socket',
      levels: gptLevels,
      defaultLevel: 'medium',
    },
  ],
};
