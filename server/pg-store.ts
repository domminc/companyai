import type { Store } from "../engine/store";
import type { CompanyState } from "../engine/types";
import type { Db } from "./db";
import type { Persistence } from "./persistence";

/** The company's collections, each a table of JSON documents. */
const COLLECTIONS = ["gateways", "agents", "tasks", "meetings", "chats", "activity"] as const;
type Collection = (typeof COLLECTIONS)[number];

interface Row {
  id: string;
  position: number;
  json: string;
}

function rowsOf(state: CompanyState): Record<Collection, Row[]> {
  const indexed = <T extends { id: string }>(items: T[]): Row[] => items.map((x, i) => ({ id: x.id, position: i, json: JSON.stringify(x) }));
  // Activity is ordered by time instead of by index, so trimming the oldest entries doesn't renumber (and rewrite) the rest.
  let last = 0;
  const activity = state.activity.map((x) => {
    last = Math.max(last + 1, Date.parse(x.at) * 1000 || 0);
    return { id: x.id, position: last, json: JSON.stringify(x) };
  });
  return {
    gateways: indexed(state.gateways),
    agents: indexed(state.agents),
    tasks: indexed(state.tasks),
    meetings: indexed(state.meetings),
    chats: state.chats.map((c, i) => ({ id: c.agentId, position: i, json: JSON.stringify(c) })),
    activity,
  };
}

/**
 * The company state in Postgres. save() writes only the rows that changed since the last save,
 * in one transaction; load() reads everything back in order. One writer at a time (the app's
 * single Durable Object, or the one Node process) is assumed.
 */
export class PostgresStore implements Store {
  /** What each row looked like when we last wrote or read it: "position|json". */
  private seen = new Map<Collection, Map<string, string>>(COLLECTIONS.map((c) => [c, new Map()]));
  private seenMeta = "";

  constructor(private db: Db) {}

  async load(): Promise<CompanyState | null> {
    const meta = (await this.db.query<{ data: Record<string, unknown> }>("select data from company_meta where id = 'main'")).rows[0];
    if (!meta) return null;
    const state: Record<string, unknown> = { ...meta.data };
    for (const c of COLLECTIONS) {
      const rows = (await this.db.query<{ id: string; position: string; data: any }>(`select id, position, data from ${c} order by position, id`)).rows;
      state[c] = rows.map((r) => r.data);
      const seen = this.seen.get(c)!;
      seen.clear();
      rows.forEach((r, i) => seen.set(r.id, `${r.position}|${JSON.stringify(r.data)}`));
    }
    this.seenMeta = JSON.stringify(meta.data);
    return state as unknown as CompanyState;
  }

  async save(state: CompanyState): Promise<void> {
    const rows = rowsOf(state);
    const { gateways: _g, agents: _a, tasks: _t, meetings: _m, chats: _c, activity: _ac, ...meta } = state;
    const metaJson = JSON.stringify(meta);
    const next = new Map<Collection, Map<string, string>>();

    await this.db.transaction(async (q) => {
      if (metaJson !== this.seenMeta) {
        await q.query(
          "insert into company_meta (id, data) values ('main', $1::jsonb) on conflict (id) do update set data = excluded.data, updated_at = now()",
          [metaJson],
        );
      }
      for (const c of COLLECTIONS) {
        const before = this.seen.get(c)!;
        const after = new Map(rows[c].map((r) => [r.id, `${r.position}|${r.json}`]));
        next.set(c, after);
        const changed = rows[c].filter((r) => before.get(r.id) !== after.get(r.id));
        const removed = [...before.keys()].filter((id) => !after.has(id));
        if (removed.length) await q.query(`delete from ${c} where id = any($1::text[])`, [removed]);
        if (changed.length) {
          await q.query(
            `insert into ${c} (id, position, data)
             select id, position, data::jsonb from unnest($1::text[], $2::bigint[], $3::text[]) as x(id, position, data)
             on conflict (id) do update set position = excluded.position, data = excluded.data`,
            [changed.map((r) => r.id), changed.map((r) => r.position), changed.map((r) => r.json)],
          );
        }
      }
    });
    // Only now that the transaction committed do we trust the new picture of the table.
    this.seenMeta = metaJson;
    for (const [c, m] of next) this.seen.set(c, m);
  }
}

/** One JSON document in the app_kv table: accounts, settings. */
export class PgPersistence<T> implements Persistence<T> {
  constructor(
    private db: Db,
    private key: string,
  ) {}

  async load(): Promise<T | undefined> {
    const row = (await this.db.query<{ value: T }>("select value from app_kv where key = $1", [this.key])).rows[0];
    return row?.value;
  }

  async save(value: T): Promise<void> {
    await this.db.query(
      "insert into app_kv (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()",
      [this.key, JSON.stringify(value)],
    );
  }
}
