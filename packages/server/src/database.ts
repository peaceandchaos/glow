import { Pool } from 'pg';

type SqlValue = string | number | boolean | null;
type SqlResult = { rows: { data: string }[] };
export interface SqlConnection {
  query(sql: string, values?: SqlValue[]): Promise<SqlResult>;
}
export interface Database extends SqlConnection {
  transaction<T>(
    operation: (connection: SqlConnection) => Promise<T>,
  ): Promise<T>;
}

export function postgresDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 4 });
  return {
    async query(sql, values) {
      return pool.query<{ data: string }>(sql, values);
    },
    async transaction(operation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await operation({
          async query(sql, values) {
            return client.query<{ data: string }>(sql, values);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
