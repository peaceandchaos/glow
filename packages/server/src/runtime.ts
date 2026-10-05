import { postgresDatabase } from './database';
import { GatewayClient } from './gateway';
import { JobRepository } from './jobs';
import { JevClient } from './jev';
import { LiveProviders } from './providers';
import { ResponsesClient } from './responses';
import { schemaSql } from './schema';

let repository: Promise<JobRepository> | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server setting: ${name}`);
  return value;
}

export function runtimeJobs(): Promise<JobRepository> {
  repository ??= (async () => {
    const database = postgresDatabase(required('DATABASE_URL'));
    await database.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'personal-chat/schema-v1',
      ]);
      await db.query(schemaSql);
    });
    return new JobRepository(database);
  })().catch(error => {
    repository = null;
    throw error;
  });
  return repository;
}

export function runtimeProviders(): LiveProviders {
  return new LiveProviders(
    new ResponsesClient({ apiKey: required('OPENAI_API_KEY') }),
    new GatewayClient({ apiKey: required('AI_GATEWAY_API_KEY') }),
    runtimeJev(),
  );
}

export function runtimeJev(): JevClient {
  return new JevClient(required('AI_GATEWAY_API_KEY'));
}
