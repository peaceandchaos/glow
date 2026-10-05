import type {
  ContextCheckpoint,
  ModelKey,
  ResponseInputItem,
  Submission,
} from '../../../shared/contracts';

export type PreparedContext = {
  items: ResponseInputItem[];
  checkpoint: ContextCheckpoint | null;
};
export type ProviderChunk = {
  wire: 'responses' | 'gateway';
  raw: string;
  text?: string;
  reasoning?: string;
};
export type ProviderCompletion = { checkpoint: ContextCheckpoint | null };
export type BeforePaidCall = () => Promise<void>;
export interface Providers {
  select(
    input: Submission,
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
  ): Promise<ModelKey>;
  prepare(
    input: Submission,
    model: ModelKey,
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
  ): Promise<PreparedContext>;
  generate(
    input: Submission,
    model: ModelKey,
    context: PreparedContext,
    signal: AbortSignal,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
    beforeCall: BeforePaidCall,
  ): Promise<ProviderCompletion>;
}
