import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Company } from "../engine/company";
import { MockLLM } from "../engine/llm";
import { MemoryFileStore } from "../engine/files";
import { AuthStore } from "./auth";
import { createCipher } from "./crypto";
import { createDb, type Db } from "./db";
import { migrate, MIGRATIONS } from "./migrations";
import { PgPersistence, PostgresStore } from "./pg-store";
import { SettingsStore } from "./settings";

// Runs against a throwaway Postgres database (TEST_DATABASE_URL); skipped when none is reachable.
const URL = process.env.TEST_DATABASE_URL ?? "postgres://companyai:companyai@127.0.0.1:5432/companyai_test";
let db: Db | undefined;

before(async () => {
  try {
    const candidate = createDb(URL, { pool: true });
    await candidate.query("drop schema public cascade");
    await candidate.query("create schema public");
    db = candidate;
  } catch {
    db = undefined;
  }
});
after(async () => {
  await db?.close();
});

const need = (t: { skip(msg?: string): void }) => {
  if (!db) t.skip("no test Postgres reachable (set TEST_DATABASE_URL)");
  return db!;
};

async function count(table: string) {
  return Number((await db!.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0].n);
}

test("migrations create the schema once and are safe to run again or concurrently", async (t) => {
  const d = need(t);
  if (!db) return;
  const [a, b] = await Promise.all([migrate(d), migrate(d)]);
  assert.equal(a + b, MIGRATIONS.length, "applied exactly once between two racing starts");
  assert.equal(await migrate(d), 0);
  assert.equal(await count("agents"), 0);
});

test("the company is saved row by row and loads back identically; saves write only what changed", async (t) => {
  const d = need(t);
  if (!db) return;
  const files = new MemoryFileStore();
  const store = new PostgresStore(d);
  const company = await Company.open({ llm: new MockLLM(0), store, files });
  const agent = company.hire({ name: "가나", role: "리서처" });
  company.hire({ name: "다라", role: "디자이너" });
  const task = company.createTask({ title: "시장 조사", assigneeId: agent.id });
  await company.flush();
  assert.equal(await count("agents"), 2);
  assert.equal(await count("tasks"), 1);

  // Nothing changed: the next save writes no rows.
  const touch = async () => (await d.query<{ xmin: string }>("select xmin::text from agents order by id")).rows.map((r) => r.xmin).join(",");
  const reader = new PostgresStore(d);
  const stored = (await reader.load())!;
  const before = await touch();
  await reader.save(stored);
  assert.equal(await touch(), before, "unchanged rows are left alone");
  stored.agents[0].name = "가나다";
  await reader.save(stored);
  assert.notEqual(await touch(), before, "a changed row is rewritten");

  // A fresh process sees the same company.
  const again = await Company.open({ llm: new MockLLM(0), store: new PostgresStore(d), files });
  assert.deepEqual(
    again.snapshot().agents.map((a) => a.name),
    ["가나다", "다라"],
  );
  assert.equal(again.snapshot().tasks[0].title, task.title);

  // Deleting removes the row.
  again.fire(agent.id);
  await again.flush();
  const loaded = await new PostgresStore(d).load();
  assert.equal(loaded?.agents.length, 1);
  assert.equal(await count("agents"), 1);
});

test("activity keeps its order and trimming old entries doesn't rewrite the rest", async (t) => {
  const d = need(t);
  if (!db) return;
  const store = new PostgresStore(d);
  const company = await Company.open({ llm: new MockLLM(0), store, files: new MemoryFileStore() });
  company.hire({ name: "마바", role: "개발자" });
  await company.flush();
  const rows = (await d.query<{ id: string }>("select id from activity order by position")).rows.map((r) => r.id);
  const state = await new PostgresStore(d).load();
  assert.deepEqual(
    state?.activity.map((a) => a.id),
    rows,
  );
});

test("accounts and the encrypted Claude key live in app_kv; the key is never stored in clear", async (t) => {
  const d = need(t);
  if (!db) return;
  const cipher = await createCipher("a-long-test-secret-for-the-database", "settings");
  const settings = await SettingsStore.open(new PgPersistence(d, "settings"), cipher);
  assert.ok(settings.canStoreKey);
  await settings.setAnthropicApiKey("sk-ant-test-1234567890");
  const raw = JSON.stringify((await d.query("select value from app_kv where key = 'settings'")).rows[0].value);
  assert.ok(!raw.includes("sk-ant-test"), "no plaintext key in the database");
  const reopened = await SettingsStore.open(new PgPersistence(d, "settings"), cipher);
  assert.equal(reopened.anthropicApiKey, "sk-ant-test-1234567890");
  const wrong = await createCipher("some-other-secret-entirely", "settings");
  await assert.rejects(SettingsStore.open(new PgPersistence(d, "settings"), wrong));

  const auth = await AuthStore.open(new PgPersistence(d, "auth"), { signingSecret: "sign-secret-for-tests" });
  await auth.setup({ username: "owner", password: "correct horse battery", displayName: "대표" });
  const auth2 = await AuthStore.open(new PgPersistence(d, "auth"), { signingSecret: "sign-secret-for-tests" });
  assert.equal(auth2.enabled, true);
  assert.equal(auth2.users().length, 1);
});
