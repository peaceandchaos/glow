import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/database';
import { schemaSql } from '../src/schema';

export async function testDatabase(): Promise<{
  postgres: PGlite;
  database: Database;
}> {
  const postgres = new PGlite();
  await postgres.exec(schemaSql);
  const database: Database = {
    async query(sql, values) {
      return postgres.query<{ data: string }>(sql, values);
    },
    async transaction(operation) {
      return postgres.transaction(async transaction =>
        operation({
          async query(sql, values) {
            return transaction.query<{ data: string }>(sql, values);
          },
        }),
      );
    },
  };
  return { postgres, database };
}
