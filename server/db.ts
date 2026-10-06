/**
 * A tiny Postgres wrapper over node-postgres that fits both hosts:
 * - a pool on the Node server (a Mac talking to Neon or a local Postgres), and
 * - one short-lived connection per operation on Cloudflare, where Hyperdrive keeps the real pool
 *   at the edge so connecting is cheap and nothing is held between requests.
 */
import { Client, Pool } from "pg";

export interface Queryable {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Result<R> = { rows: R[]; rowCount: number | null };
type Runner = { query(text: string, params?: any[]): Promise<unknown> };
const run = <R>(r: Runner, text: string, params?: unknown[]) => r.query(text, params as any[]) as Promise<Result<R>>;

export function createDb(connectionString: string, opts: { pool: boolean }): Db {
  if (opts.pool) {
    const pool = new Pool({ connectionString, max: 4 });
    return {
      query: (text, params) => run(pool, text, params),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn({ query: (t, p) => run(client, t, p) });
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const withClient = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  };
  return {
    query: (text, params) => withClient((c) => run(c, text, params)),
    transaction: (fn) =>
      withClient(async (c) => {
        await c.query("BEGIN");
        try {
          const result = await fn({ query: (t, p) => run(c, t, p) });
          await c.query("COMMIT");
          return result;
        } catch (err) {
          await c.query("ROLLBACK").catch(() => {});
          throw err;
        }
      }),
    close: async () => {},
  };
}
