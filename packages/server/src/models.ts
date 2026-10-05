import type { ModelKey } from '../../../shared/contracts';

type Limits = {
  id: string;
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

// Source links and the selected output budget are recorded in docs/providers.md.
export const models = {
  kimi: {
    id: 'moonshotai/kimi-k3',
    wire: 'gateway',
    window: 1_000_000,
    maxOutput: 32_768,
    threshold: 850_000,
  },
  deepseek: {
    id: 'deepseek/deepseek-v4.1-flash',
    wire: 'gateway',
    window: 1_000_000,
    maxOutput: 32_768,
    threshold: 800_000,
  },
  'gpt-6.1-sol': {
    id: 'gpt-6.1-sol',
    wire: 'responses',
    window: 1_050_000,
    maxOutput: 32_768,
    threshold: 800_000,
    compactThreshold: 200_000,
  },
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    wire: 'responses',
    window: 1_050_000,
    maxOutput: 32_768,
    threshold: 800_000,
    compactThreshold: 200_000,
  },
} satisfies Record<ModelKey, ModelConfig>;

export function checkpointMethod(model: ModelKey) {
  if (model === 'kimi') return 'kimi-summary';
  if (model === 'deepseek') return 'deepseek-summary';
  return 'openai-compaction';
}
