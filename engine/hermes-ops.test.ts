import assert from "node:assert/strict";
import { test } from "node:test";
import { Company, EngineError } from "./company";
import { MockLLM } from "./llm";
import { startFakeHermes } from "./testing/fake-hermes";

const WORK_MS = 40;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(plugin = true) {
  const fake = await startFakeHermes({ apiKey: "owner-key", profiles: { researcher: undefined }, ops: { plugin, workMs: WORK_MS } });
  const company = await Company.open({ llm: new MockLLM(0) });
  const gateway = await company.addGateway({ name: "집 서버", url: fake.url, apiKey: "owner-key" });
  const agent = company.hire({ name: "리서처", role: "Researcher", hermes: { gatewayId: gateway.id, profile: "researcher" } });
  return { fake, company, gateway, agent };
}

test("automations go through the DeskRPG plugin: create, run now with history, pause, delete", async (t) => {
  const { fake, company, agent } = await setup();
  t.after(() => fake.close());

  const job = await company.createAutomation(agent.id, { name: "아침 브리핑", schedule: "0 9 * * *", prompt: "업계 뉴스를 요약해 줘" });
  assert.equal(job.schedule, "0 9 * * *");
  assert.equal(fake.ops.jobs[0].profile, "researcher");
  const listed = await company.listAutomations(agent.id);
  assert.equal(listed.source, "plugin");
  assert.deepEqual(listed.jobs.map((j) => j.name), ["아침 브리핑"]);

  await company.automationAction(agent.id, job.id, "run");
  await company.syncHermesWork();
  assert.deepEqual(company.snapshot().agents[0].external, { kind: "cron", title: "아침 브리핑" });
  await wait(WORK_MS * 3);
  const [run] = await company.automationRuns(agent.id, job.id);
  assert.equal(run.status, "ok");
  assert.match(run.resultText, /업계 뉴스/);
  await company.syncHermesWork();
  assert.equal(company.snapshot().agents[0].external, undefined);

  await company.automationAction(agent.id, job.id, "pause");
  assert.equal((await company.listAutomations(agent.id)).jobs[0].state, "paused");
  const renamed = await company.updateAutomation(agent.id, job.id, { name: "평일 브리핑" });
  assert.equal(renamed.name, "평일 브리핑");
  await company.automationAction(agent.id, job.id, "delete");
  assert.deepEqual((await company.listAutomations(agent.id)).jobs, []);
  await assert.rejects(company.automationAction(agent.id, job.id, "run"), (e: EngineError) => e.status === 404);
});

test("without the plugin, automations fall back to Hermes' own jobs API and the kanban says what's missing", async (t) => {
  const { fake, company, gateway, agent } = await setup(false);
  t.after(() => fake.close());
  const job = await company.createAutomation(agent.id, { name: "주간 점검", schedule: "every 7d", prompt: "점검" });
  assert.equal((await company.listAutomations(agent.id)).source, "core");
  assert.deepEqual(await company.automationRuns(agent.id, job.id), []);
  assert.equal((await company.updateAutomation(agent.id, job.id, { prompt: "꼼꼼히 점검" })).prompt, "꼼꼼히 점검");
  assert.deepEqual(await company.kanbanOverview(gateway.id), { plugin: false, boards: [] });
});

test("automations are for Hermes employees only", async () => {
  const company = await Company.open({ llm: new MockLLM(0) });
  const claude = company.hire({ name: "C", role: "r" });
  await assert.rejects(company.listAutomations(claude.id), EngineError);
});

test("a kanban card for a Hermes employee shows them at work, and finishing it is logged", async (t) => {
  const { fake, company, gateway, agent } = await setup();
  t.after(() => fake.close());

  const overview = await company.kanbanOverview(gateway.id);
  assert.equal(overview.plugin, true);
  assert.deepEqual(overview.boards.map((b) => b.slug), ["default"]);

  const card = await company.kanbanCreateCard(gateway.id, "default", { title: "경쟁사 가격표 정리", assigneeId: agent.id });
  assert.equal(card.assignee, "researcher");
  assert.equal(card.status, "ready");

  await wait(WORK_MS * 1.5);
  await company.syncHermesWork();
  assert.deepEqual(company.snapshot().agents[0].external, { kind: "kanban", title: "경쟁사 가격표 정리", board: "default" });

  await wait(WORK_MS * 1.5);
  await company.syncHermesWork();
  const state = company.snapshot();
  assert.equal(state.agents[0].external, undefined);
  assert.ok(state.activity.some((a) => a.message.includes("경쟁사 가격표 정리") && a.message.includes("마쳤습니다")));

  const board = await company.kanbanBoard(gateway.id, "default");
  assert.deepEqual(board.columns.find((c) => c.name === "done")!.tasks.map((c) => c.id), [card.id]);
  await company.kanbanComment(gateway.id, "default", card.id, "숫자 출처도 붙여 주세요");
  const detail = await company.kanbanCard(gateway.id, "default", card.id);
  assert.match(detail.task.result ?? "", /researcher/);
  assert.equal(detail.comments[0].author, "대표");

  const claude = company.hire({ name: "C", role: "r" });
  await assert.rejects(company.kanbanCreateCard(gateway.id, "default", { title: "x", assigneeId: claude.id }), EngineError);
  await assert.rejects(company.kanbanAction(gateway.id, "default", card.id, "fly" as never), EngineError);
  await company.kanbanCreateBoard(gateway.id, { slug: "launch", name: "출시" });
  assert.deepEqual((await company.kanbanOverview(gateway.id)).boards.map((b) => b.slug), ["default", "launch"]);
  await assert.rejects(company.kanbanCreateBoard(gateway.id, { slug: "Bad Slug" }), EngineError);
});
