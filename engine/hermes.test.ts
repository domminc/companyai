import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Company, EngineError } from "./company";
import { HermesClient, HermesError } from "./hermes";
import { MockLLM } from "./llm";
import { type FakeHermes, startFakeHermes } from "./testing/fake-hermes";
import type { CompanyEvent } from "./types";

const KEY = "owner-secret-key";
const PROFILE_KEY = "coder-secret-key";
let fake: FakeHermes;

before(async () => {
  fake = await startFakeHermes({ apiKey: KEY, profiles: { researcher: undefined, coder: PROFILE_KEY } });
});
after(() => fake.close());

const noSleep = async () => {};

test("a run streams deltas and resolves with run.completed even though the stream stays open", async () => {
  const client = new HermesClient({ baseUrl: fake.url, token: KEY, profile: "researcher" });
  const deltas: string[] = [];
  const tools: (string | null)[] = [];
  const text = await client.run(
    { input: "조사해 줘", instructions: "<workplace>...</workplace>" },
    { onDelta: (d) => deltas.push(d), onTool: (t) => tools.push(t) },
  );
  assert.match(text, /Hermes researcher/);
  assert.equal(deltas.join(""), text);
  assert.deepEqual(tools, ["web_search", null]);
  const sent = fake.runs.at(-1)!;
  assert.equal(sent.profile, "researcher");
  assert.equal(sent.instructions, "<workplace>...</workplace>");
  assert.equal(sent.authorization, `Bearer ${KEY}`);
});

test("gateway errors map to clear codes", async () => {
  const bad = new HermesClient({ baseUrl: fake.url, token: "wrong" });
  await assert.rejects(bad.capabilities(), (e: HermesError) => e.code === "unauthorized");
  const ghost = new HermesClient({ baseUrl: fake.url, token: KEY, profile: "ghost" });
  await assert.rejects(ghost.capabilities(), (e: HermesError) => e.code === "unknown_profile");
  const nowhere = new HermesClient({ baseUrl: "http://127.0.0.1:9", token: KEY });
  await assert.rejects(nowhere.capabilities(), (e: HermesError) => e.code === "unreachable");
});

test("run.failed rejects, and 429 is retried", async () => {
  const failing = await startFakeHermes({ reply: () => ({ error: "provider rejected the key" }) });
  try {
    await assert.rejects(new HermesClient({ baseUrl: failing.url }).run({ input: "x" }), /provider rejected the key/);
  } finally {
    await failing.close();
  }
  const busy = await startFakeHermes({ rateLimitFirst: 2, reply: () => "done" });
  try {
    assert.equal(await new HermesClient({ baseUrl: busy.url, sleep: noSleep }).run({ input: "x" }), "done");
  } finally {
    await busy.close();
  }
});

test("a run that never finishes times out and is stopped on the gateway", async () => {
  const hung = await startFakeHermes({ reply: () => ({ hang: true }) });
  try {
    await assert.rejects(new HermesClient({ baseUrl: hung.url }).run({ input: "x", timeoutMs: 200 }), /중단했습니다/);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(hung.stopped, ["run_1"]);
  } finally {
    await hung.close();
  }
});

async function companyWithGateway() {
  const company = await Company.open({ llm: new MockLLM(0) });
  const events: CompanyEvent[] = [];
  // Events carry live objects; clone to record what was sent at that moment.
  company.subscribe((e) => events.push(structuredClone(e)));
  const gateway = await company.addGateway({ name: "local", url: fake.url, apiKey: KEY });
  return { company, events, gateway };
}

test("gateways are verified on registration and their keys never leave the engine", async () => {
  const company = await Company.open({ llm: new MockLLM(0) });
  await assert.rejects(company.addGateway({ url: fake.url, apiKey: "wrong" }), (e: EngineError) => e.status === 502);
  await assert.rejects(company.addGateway({ url: "ftp://x" }), (e: EngineError) => e.status === 400);

  const { company: c2, events, gateway } = await companyWithGateway();
  assert.equal(gateway.hasApiKey, true);
  await c2.verifyHermesProfile({ gatewayId: gateway.id, profile: "coder", profileKey: PROFILE_KEY });
  await assert.rejects(c2.verifyHermesProfile({ gatewayId: gateway.id, profile: "ghost" }), EngineError);
  const agent = c2.hire({ name: "코더", role: "Engineer", hermes: { gatewayId: gateway.id, profile: "coder", profileKey: PROFILE_KEY } });
  assert.deepEqual(agent.runtime, { kind: "hermes", gatewayId: gateway.id, profile: "coder", hasProfileKey: true });

  const leaked = JSON.stringify([c2.snapshot(), events]);
  assert.ok(!leaked.includes(KEY) && !leaked.includes(PROFILE_KEY), "secrets must be redacted");
  assert.throws(() => c2.removeGateway(gateway.id), (e: EngineError) => e.status === 409);
});

test("a Hermes employee works a task through its profile, with tool activity", async () => {
  const { company, events, gateway } = await companyWithGateway();
  const agent = company.hire({ name: "리서처", role: "Researcher", persona: "SECRET-PERSONA", hermes: { gatewayId: gateway.id, profile: "researcher" } });
  company.createTask({ title: "시장 조사", assigneeId: agent.id });
  await company.settle();

  const task = company.snapshot().tasks[0];
  assert.equal(task.status, "done");
  assert.match(task.output, /Hermes researcher/);
  assert.ok(events.some((e) => e.type === "task.updated" && e.task.activeTool === "web_search"));
  const sent = fake.runs.at(-1)!;
  assert.match(sent.instructions!, /<workplace>/);
  assert.ok(!sent.instructions!.includes("SECRET-PERSONA"), "identity stays in the profile's SOUL.md");
});

test("Claude and Hermes employees meet together; a Hermes participant takes minutes without a Claude key", async () => {
  const { company, gateway } = await companyWithGateway();
  const pm = company.hire({ name: "정유나", role: "PM" });
  const coder = company.hire({ name: "코더", role: "Engineer", hermes: { gatewayId: gateway.id, profile: "coder", profileKey: PROFILE_KEY } });
  const m = company.startMeeting({ topic: "출시 일정", participantIds: [pm.id, coder.id] });
  await company.settle();

  const snap = company.snapshot();
  const done = snap.meetings.find((x) => x.id === m.id)!;
  assert.equal(done.status, "done", done.error ?? "");
  const speakers = done.transcript.flatMap((e) => (e.kind === "speech" ? [e.speakerId] : []));
  assert.ok(speakers.includes(pm.id) && speakers.includes(coder.id));
  assert.equal(done.summary, "Hermes 서기가 정리한 회의록입니다.");
  assert.equal(done.actionItems.length, 2);
  const coderRuns = fake.runs.filter((r) => r.profile === "coder");
  assert.ok(coderRuns.some((r) => r.input.startsWith("📋 [Meeting poll:")));
  assert.ok(coderRuns.every((r) => r.authorization === `Bearer ${PROFILE_KEY}`), "profile key wins over the gateway key");
  assert.ok(coderRuns.filter((r) => r.input.startsWith("📋")).every((r) => r.instructions?.includes("<meeting-protocol>")));
});
