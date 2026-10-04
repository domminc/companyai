import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeHermes } from "../engine/testing/fake-hermes";
import { discoverLocalHermes, hermesHome, localUrl, parseEnv, sameGateway } from "./hermes-local";

test("parses a .env the way Hermes writes and people edit it", () => {
  const env = parseEnv(`# comment\nAPI_SERVER_ENABLED=true\nAPI_SERVER_KEY="abc 123"\nexport API_SERVER_PORT=9000 # custom\n\nbad line\nOTHER='x'\n`);
  assert.deepEqual(env, { API_SERVER_ENABLED: "true", API_SERVER_KEY: "abc 123", API_SERVER_PORT: "9000", OTHER: "x" });
});

test("the address is always loopback, on the configured port", () => {
  assert.equal(localUrl({}), "http://127.0.0.1:8642");
  assert.equal(localUrl({ API_SERVER_PORT: "9000", API_SERVER_HOST: "0.0.0.0" }), "http://127.0.0.1:9000");
});

test("HERMES_HOME wins, else ~/.hermes", () => {
  assert.equal(hermesHome({ HERMES_HOME: "/x/h" }, "/home/u"), "/x/h");
  assert.equal(hermesHome({}, "/home/u"), "/home/u/.hermes");
});

async function homeWith(env: string) {
  const home = await mkdtemp(join(tmpdir(), "companyai-hl-"));
  await mkdir(join(home, ".hermes"), { recursive: true });
  await writeFile(join(home, ".hermes", ".env"), env);
  return home;
}

test("a running Hermes with the plugin is found, reachable, and its key stays server-side", async (t) => {
  const fake = await startFakeHermes({ apiKey: "local-key-1234567890" });
  t.after(() => fake.close());
  const port = new URL(fake.url).port;
  const home = await homeWith(`API_SERVER_ENABLED=true\nAPI_SERVER_KEY=local-key-1234567890\nAPI_SERVER_PORT=${port}\n`);
  const found = await discoverLocalHermes({ home, env: {} });
  assert.equal(found.found, true);
  assert.equal(found.reachable, true);
  assert.equal(found.plugin, true);
  assert.equal(found.url, `http://127.0.0.1:${port}`);
  assert.equal(found.key, "local-key-1234567890");
});

test("without the plugin it is still reachable, and a wrong key or a stopped Hermes says so", async (t) => {
  const fake = await startFakeHermes({ apiKey: "right-key-1234567890", ops: { plugin: false } });
  t.after(() => fake.close());
  const port = new URL(fake.url).port;
  const env = (key: string, p = port) => `API_SERVER_KEY=${key}\nAPI_SERVER_PORT=${p}\n`;
  const noPlugin = await discoverLocalHermes({ home: await homeWith(env("right-key-1234567890")), env: {} });
  assert.deepEqual([noPlugin.found, noPlugin.reachable, noPlugin.plugin], [true, true, false]);
  const wrongKey = await discoverLocalHermes({ home: await homeWith(env("wrong-key-1234567890")), env: {} });
  assert.deepEqual([wrongKey.found, wrongKey.reachable], [true, false]);
  const stopped = await discoverLocalHermes({ home: await homeWith(env("right-key-1234567890", "1")), env: {} });
  assert.deepEqual([stopped.found, stopped.reachable], [true, false]);
});

test("nothing configured, or the API server switched off, means not found", async () => {
  const empty = await mkdtemp(join(tmpdir(), "companyai-hl-"));
  assert.equal((await discoverLocalHermes({ home: empty, env: {} })).found, false);
  const off = await homeWith("API_SERVER_ENABLED=false\nAPI_SERVER_KEY=abcdefghijklmnopqrstu\n");
  assert.equal((await discoverLocalHermes({ home: off, env: {} })).found, false);
  const noKey = await homeWith("API_SERVER_ENABLED=true\n");
  assert.equal((await discoverLocalHermes({ home: noKey, env: {} })).found, false);
});

test("localhost, 127.0.0.1 and ::1 are the same gateway; other hosts and ports are not", () => {
  assert.ok(sameGateway("http://localhost:8642", "http://127.0.0.1:8642/"));
  assert.ok(!sameGateway("http://localhost:8642", "http://127.0.0.1:9000"));
  assert.ok(!sameGateway("http://localhost:8642", "http://mac-mini.local:8642"));
});
