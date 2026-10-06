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

// pg already treats these modes as verify-full and warns that it does;
// naming verify-full keeps that TLS check and drops the warning.
export function explicitSslMode(connectionString: string): string {
  return connectionString.replace(
    /([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|$)/gu,
    '$1verify-full',
  );
}

export function postgresDatabase(connectionString: string): Database {
  const pool = new Pool({
    connectionString: explicitSslMode(connectionString),
    max: 4,
  });
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
