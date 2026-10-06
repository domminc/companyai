import assert from "node:assert/strict";
import { test } from "node:test";
import { Company } from "../engine/company";
import { MemoryFileStore } from "../engine/files";
import { MockLLM } from "../engine/llm";
import { MemoryStore } from "../engine/store";
import { type App, createApp } from "./app";
import { AuthStore } from "./auth";
import { SettingsStore } from "./settings";
import { MemoryPersistence } from "./persistence";

async function setup(opts: { setupToken?: string } = {}) {
  const company = await Company.open({ llm: new MockLLM(0), store: new MemoryStore(), files: new MemoryFileStore() });
  const auth = await AuthStore.open(new MemoryPersistence());
  const settings = await SettingsStore.open(new MemoryPersistence());
  const app = createApp({ runtime: "workers", company, auth, settings, claude: { mockDelayMs: 0, provider: "mock" }, files: new MemoryFileStore(), ...opts });
  return { app, company, auth };
}

class Browser {
  cookie = "";
  constructor(private app: App) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.fetch(
      new Request(`https://office.example${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const set = res.headers.getSetCookie()[0];
    if (set) this.cookie = set.startsWith("companyai_session=;") ? "" : set.split(";")[0];
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, res };
  }
}

test("open mode: the API works without an account, like a one-person tool", async () => {
  const { app } = await setup();
  const b = new Browser(app);
  assert.deepEqual((await b.call("GET", "/api/auth/me")).data, { enabled: false, user: null, setupRequired: false });
  const hired = await b.call("POST", "/api/agents", { name: "김하늘", role: "PM" });
  assert.equal(hired.status, 200);
  assert.equal((await b.call("GET", "/api/state")).data.state.agents.length, 1);
  assert.equal((await b.call("GET", "/api/nope")).status, 404);
  assert.equal((await b.call("POST", "/api/agents", undefined, { "content-type": "application/json" })).status, 400, "missing name");
});

test("a public deployment stays locked until the owner is created with the setup token", async () => {
  const { app } = await setup({ setupToken: "setup-secret-token" });
  const b = new Browser(app);
  const me = (await b.call("GET", "/api/auth/me")).data;
  assert.equal(me.setupRequired, true);
  for (const [m, p] of [["GET", "/api/state"], ["POST", "/api/agents"], ["GET", "/api/events"]] as const) {
    const r = await b.call(m, p, m === "POST" ? { name: "x", role: "y" } : undefined);
    assert.equal(r.status, 403, `${m} ${p} while locked`);
    assert.equal(r.data.setup, true);
  }
  const wrong = await b.call("POST", "/api/auth/setup", { username: "boss", password: "correct horse", setupToken: "guess" });
  assert.equal(wrong.status, 403);
  const missing = await b.call("POST", "/api/auth/setup", { username: "boss", password: "correct horse" });
  assert.equal(missing.status, 403);
  const ok = await b.call("POST", "/api/auth/setup", { username: "boss", password: "correct horse", setupToken: "setup-secret-token", displayName: "홍대표" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, "owner");
  assert.ok(b.cookie.startsWith("companyai_session="), "signed in");
  assert.equal((await b.call("GET", "/api/state")).status, 200);
  assert.equal((await b.call("POST", "/api/auth/disable", { password: "correct horse" })).status, 409, "a public deployment can't go open");
  // a stranger without the cookie is now asked to log in, not to set up
  const stranger = new Browser(app);
  const r = await stranger.call("GET", "/api/state");
  assert.equal(r.status, 401);
  assert.equal((await stranger.call("GET", "/api/auth/me")).data.setupRequired, false);
});

test("roles: viewers read, members work, owners manage; other sites can't change anything", async () => {
  const { app } = await setup();
  const owner = new Browser(app);
  await owner.call("POST", "/api/auth/setup", { username: "boss", password: "correct horse" });
  await owner.call("POST", "/api/users", { username: "kim", password: "password1", displayName: "김팀원", role: "member" });
  await owner.call("POST", "/api/users", { username: "lee", password: "password2", role: "viewer" });
  const member = new Browser(app);
  const viewer = new Browser(app);
  assert.equal((await member.call("POST", "/api/auth/login", { username: "kim", password: "password1" })).status, 200);
  await viewer.call("POST", "/api/auth/login", { username: "lee", password: "password2" });

  assert.equal((await member.call("POST", "/api/agents", { name: "가나", role: "PM" })).status, 200);
  assert.equal((await member.call("PATCH", "/api/company", { name: "x" })).status, 403);
  assert.equal((await viewer.call("POST", "/api/tasks", { title: "x" })).status, 403);
  assert.equal((await viewer.call("GET", "/api/state")).status, 200);
  assert.equal((await owner.call("PATCH", "/api/company", { name: "단테" })).status, 200);

  const csrf = await owner.call("POST", "/api/tasks", { title: "x" }, { origin: "https://evil.example" });
  assert.equal(csrf.status, 403);
  const same = await owner.call("POST", "/api/tasks", { title: "x" }, { origin: "https://office.example" });
  assert.notEqual(same.status, 403);

  const log = (await owner.call("GET", "/api/state")).data.state.activity.map((a: any) => `${a.by}:${a.message}`);
  assert.ok(log.some((l: string) => l.startsWith("김팀원:") && l.includes("가나")), "who hired is recorded");
});

test("login attempts are throttled per address", async () => {
  const { app } = await setup();
  const b = new Browser(app);
  await b.call("POST", "/api/auth/setup", { username: "boss", password: "correct horse" });
  b.cookie = "";
  for (let i = 0; i < 10; i++) assert.equal((await b.call("POST", "/api/auth/login", { username: "boss", password: "wrong" }, { "cf-connecting-ip": "1.2.3.4" })).status, 401);
  assert.equal((await b.call("POST", "/api/auth/login", { username: "boss", password: "correct horse" }, { "cf-connecting-ip": "1.2.3.4" })).status, 429);
  assert.equal((await b.call("POST", "/api/auth/login", { username: "boss", password: "correct horse" }, { "cf-connecting-ip": "5.6.7.8" })).status, 200, "another address is unaffected");
});

test("the event stream starts with the state, carries changes and presence, and ends when the browser leaves", async () => {
  const { app } = await setup();
  const owner = new Browser(app);
  await owner.call("POST", "/api/auth/setup", { username: "boss", password: "correct horse", displayName: "홍대표" });
  const abort = new AbortController();
  const res = await app.fetch(new Request("https://office.example/api/events", { headers: { cookie: owner.cookie }, signal: abort.signal }));
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const until = async (text: string) => {
    while (!seen.includes(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${text}`);
      seen += decoder.decode(value);
    }
  };
  await until('"type":"state"');
  await until('"type":"presence"');
  assert.match(seen, /홍대표/);
  await owner.call("POST", "/api/agents", { name: "가나", role: "PM" });
  await until('"type":"agent.updated"');
  abort.abort();
  assert.equal(app.presence["conns"].size, 0, "presence is cleaned up");
});

test("the Claude key can only be saved where it can be stored safely", async () => {
  const { app } = await setup();
  const b = new Browser(app);
  assert.deepEqual((await b.call("GET", "/api/settings/claude")).data, { provider: "mock", source: "none" });
  assert.equal((await b.call("GET", "/api/runtime")).data.features.files, true);
  assert.equal((await b.call("GET", "/api/runtime")).data.runtime, "workers");
});
