import { SessionStore } from './auth';
import { postgresDatabase, type Database } from './database';
import { GatewayClient } from './gateway';
import { JobRepository } from './jobs';
import { JevClient } from './jev';
import { LiveProviders } from './providers';
import { ResponsesClient } from './responses';
import { schemaSql } from './schema';

let installed: Promise<Database> | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server setting: ${name}`);
  return value;
}

function runtimeDatabase(): Promise<Database> {
  installed ??= (async () => {
    const database = postgresDatabase(required('DATABASE_URL'));
    await database.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'personal-chat/schema-v1',
      ]);
      await db.query(schemaSql);
    });
    return database;
  })().catch(error => {
    installed = null;
    throw error;
  });
  return installed;
}

export async function runtimeJobs(): Promise<JobRepository> {
  return new JobRepository(await runtimeDatabase());
}

export async function runtimeSessions(): Promise<SessionStore> {
  return new SessionStore(await runtimeDatabase());
}

// Without AI_GATEWAY_API_KEY, both Gateway clients use the Vercel OIDC token.
function gatewayKey(): string | undefined {
  return process.env.AI_GATEWAY_API_KEY || undefined;
}

export function runtimeProviders(): LiveProviders {
  return new LiveProviders(
    new ResponsesClient({ apiKey: required('OPENAI_API_KEY') }),
    new GatewayClient({ apiKey: gatewayKey() }),
    runtimeJev(),
  );
}

export function runtimeJev(): JevClient {
  return new JevClient(gatewayKey());
}
