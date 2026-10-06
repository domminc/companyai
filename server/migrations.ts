import type { Db } from "./db";

/**
 * The schema, in order. A migration is never edited once shipped: add the next one. They run by
 * themselves when the app starts, so deploying never needs a separate database step.
 *
 * Company data is stored as JSON documents, one row per employee / task / meeting / chat /
 * activity entry, so the app's state can be saved by writing only what changed while the data
 * stays queryable in SQL.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      create table company_meta (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table gateways (id text primary key, position bigint not null, data jsonb not null);
      create table agents (id text primary key, position bigint not null, data jsonb not null);
      create table tasks (id text primary key, position bigint not null, data jsonb not null);
      create table meetings (id text primary key, position bigint not null, data jsonb not null);
      create table chats (id text primary key, position bigint not null, data jsonb not null);
      create table activity (id text primary key, position bigint not null, data jsonb not null);
      create index activity_position on activity (position);
      -- Accounts and settings: one JSON document per key.
      create table app_kv (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      );
    `,
  },
];

const LOCK_ID = 727_270_001;

export async function migrate(db: Db): Promise<number> {
  return db.transaction(async (q) => {
    await q.query("select pg_advisory_xact_lock($1)", [LOCK_ID]);
    await q.query("create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())");
    const done = new Set((await q.query<{ version: number }>("select version from schema_migrations")).rows.map((r) => r.version));
    let applied = 0;
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await q.query(m.sql);
      await q.query("insert into schema_migrations (version) values ($1)", [m.version]);
      applied++;
    }
    return applied;
  });
}
