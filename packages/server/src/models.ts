import { z } from 'zod';
import type { Catalog, CatalogModel } from '../../../shared/catalog';

const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof efforts)[number];
const effortSchema = z.enum(efforts);
const levelLabels: Record<Effort, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

type Limits = {
  id: string;
  label: string;
  // Every reasoning effort the provider accepts for this model.
  levels: readonly Effort[];
  window: number;
  maxOutput: number;
  // The server's working-context limit: text bytes plus a per-image estimate.
  threshold: number;
};

export type ModelConfig =
  | (Limits & { wire: 'gateway' })
  | (Limits & {
      wire: 'responses';
      // The token count sent as compact_threshold.
      compactThreshold: number;
    });
export type ResponsesModel = Extract<ModelConfig, { wire: 'responses' }>;

const openLevels: Effort[] = ['none', 'low', 'high', 'max'];
const gptLevels: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Source links and the selected output budget are recorded in docs/providers.md.
export const models = {
  kimi: {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    levels: openLevels,
    wire: 'gateway',
    window: 1_000_000,
    maxOutput: 32_768,
    threshold: 850_000,
  },
  deepseek: {
    id: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    levels: openLevels,
    wire: 'gateway',
    window: 1_000_000,
    maxOutput: 32_768,
    threshold: 800_000,
  },
  'gpt-6.1-sol': {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    levels: gptLevels,
    wire: 'responses',
    window: 1_050_000,
    maxOutput: 32_768,
    threshold: 800_000,
    compactThreshold: 200_000,
  },
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    levels: gptLevels,
    wire: 'responses',
    window: 1_050_000,
    maxOutput: 32_768,
    threshold: 800_000,
    compactThreshold: 200_000,
  },
} satisfies Record<string, ModelConfig>;
export type RegistryKey = keyof typeof models;

export function isRegistryKey(key: string): key is RegistryKey {
  return Object.hasOwn(models, key);
}

export function effortFor(
  model: RegistryKey,
  level: string | null,
): Effort | null {
  const supported: readonly Effort[] = models[model].levels;
  return supported.find(effort => effort === level) ?? null;
}

type GatewayModelKey = {
  [K in RegistryKey]: (typeof models)[K]['wire'] extends 'gateway' ? K : never;
}[RegistryKey];
type ZeroRetentionHost = 'bedrock' | 'baseten' | 'fireworks';

export const gatewayHosts: Record<
  GatewayModelKey,
  [ZeroRetentionHost, ...ZeroRetentionHost[]]
> = {
  kimi: ['bedrock', 'fireworks'],
  deepseek: ['fireworks', 'baseten'],
};

export function isGatewayModel(model: RegistryKey): model is GatewayModelKey {
  return models[model].wire === 'gateway';
}

export function checkpointMethod(model: RegistryKey) {
  if (model === 'kimi') return 'kimi-summary';
  if (model === 'deepseek') return 'deepseek-summary';
  return 'openai-compaction';
}

const menuEntrySchema = z.strictObject({
  model: z.enum(Object.keys(models).filter(isRegistryKey)),
  levels: z.array(effortSchema),
  defaultLevel: effortSchema.nullable(),
});
const menuSchema = z.strictObject({
  auto: z.boolean(),
  models: z.tuple([menuEntrySchema], menuEntrySchema),
});
// Array order is menu order; the first model is the fallback and the first chat's model.
type Menu = z.infer<typeof menuSchema>;

export const defaultMenu: Menu = {
  auto: true,
  models: [
    { model: 'deepseek', levels: openLevels, defaultLevel: null },
    { model: 'kimi', levels: openLevels, defaultLevel: null },
    { model: 'gpt-6.1-sol', levels: gptLevels, defaultLevel: 'medium' },
    { model: 'gpt-6-astra', levels: gptLevels, defaultLevel: 'medium' },
  ],
};

function offerable(menu: Menu): Menu {
  const keys = menu.models.map(entry => entry.model);
  if (new Set(keys).size !== keys.length)
    throw new Error('a model is listed twice');
  for (const entry of menu.models) {
    const supported: readonly Effort[] = models[entry.model].levels;
    const unsupported = entry.levels.find(level => !supported.includes(level));
    if (unsupported)
      throw new Error(`${entry.model} does not support ${unsupported}`);
    if (entry.defaultLevel && !entry.levels.includes(entry.defaultLevel))
      throw new Error(`${entry.model} does not offer ${entry.defaultLevel}`);
  }
  return menu;
}

// A bad value must not stop sends, so it falls back to the default menu.
export function menuFrom(raw: string | undefined): Menu {
  if (!raw) return defaultMenu;
  try {
    return offerable(menuSchema.parse(JSON.parse(raw)));
  } catch (error) {
    console.error(
      `MODEL_MENU ignored: ${error instanceof Error ? error.message : 'invalid value'}`,
    );
    return defaultMenu;
  }
}

function catalogModel(entry: Menu['models'][number]): CatalogModel {
  return {
    key: entry.model,
    label: models[entry.model].label,
    levels: entry.levels.map(level => ({
      key: level,
      label: levelLabels[level],
    })),
    defaultLevel: entry.defaultLevel,
  };
}

export function catalogFrom(menu: Menu): Catalog {
  const [first, ...rest] = menu.models;
  return {
    auto: menu.auto,
    models: [catalogModel(first), ...rest.map(catalogModel)],
  };
}
