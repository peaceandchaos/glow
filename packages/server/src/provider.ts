import type {
  ContextCheckpoint,
  ResponseInputItem,
  Submission,
} from '../../../shared/contracts';
import type { Effort, RegistryKey } from './models';

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
    offered: readonly string[],
  ): Promise<string>;
  prepare(
    input: Submission,
    model: RegistryKey,
    signal: AbortSignal,
    beforeCall: BeforePaidCall,
  ): Promise<PreparedContext>;
  generate(
    input: Submission,
    model: RegistryKey,
    context: PreparedContext,
    signal: AbortSignal,
    onChunk: (chunk: ProviderChunk) => Promise<void>,
    beforeCall: BeforePaidCall,
    effort: Effort | null,
  ): Promise<ProviderCompletion>;
}
