import assert from "node:assert/strict";
import { test } from "node:test";
import { Company, EngineError } from "./company";
import { MockLLM } from "./llm";
import { MemoryStore } from "./store";
import type { CompanyEvent } from "./types";

async function newCompany(store = new MemoryStore()) {
  return Company.open({ llm: new MockLLM(0), store });
}

test("hiring adds an idle agent with the default model", async () => {
  const company = await newCompany();
  const agent = company.hire({ name: "김하늘", role: "PM" });
  const state = company.snapshot();
  assert.equal(state.agents.length, 1);
  assert.equal(agent.status, "idle");
  assert.deepEqual(agent.runtime, { kind: "claude", model: state.defaultModel, tools: [] });
  assert.throws(() => company.hire({ name: "", role: "PM" }), EngineError);
});

test("a task assigned to an idle agent runs to completion", async () => {
  const company = await newCompany();
  const events: CompanyEvent[] = [];
  company.subscribe((e) => events.push(e));
  const agent = company.hire({ name: "이도윤", role: "Engineer" });
  const task = company.createTask({ title: "API 설계", assigneeId: agent.id });

  assert.equal(company.snapshot().tasks[0].status, "in_progress");
  await company.settle();

  const done = company.snapshot().tasks.find((t) => t.id === task.id)!;
  assert.equal(done.status, "done");
  assert.match(done.output, /API 설계/);
  assert.ok(events.some((e) => e.type === "task.delta"));
  assert.equal(company.snapshot().agents[0].stats.tasksDone, 1);
});

test("an agent works through its queue one task at a time", async () => {
  const company = await newCompany();
  const agent = company.hire({ name: "박서연", role: "Designer" });
  company.createTask({ title: "A", assigneeId: agent.id });
  company.createTask({ title: "B", assigneeId: agent.id });
  const statuses = company.snapshot().tasks.map((t) => t.status);
  assert.deepEqual(statuses, ["in_progress", "todo"]);
  await company.settle();
  assert.deepEqual(company.snapshot().tasks.map((t) => t.status), ["done", "done"]);
});

test("unassigned tasks wait until someone is assigned", async () => {
  const company = await newCompany();
  const task = company.createTask({ title: "보류" });
  await company.settle();
  assert.equal(company.snapshot().tasks[0].status, "todo");
  const agent = company.hire({ name: "최민준", role: "Analyst" });
  company.updateTask(task.id, { assigneeId: agent.id });
  await company.settle();
  assert.equal(company.snapshot().tasks[0].status, "done");
});

test("a meeting produces a transcript, minutes and follow-up tasks", async () => {
  const company = await newCompany();
  const a = company.hire({ name: "정유나", role: "PM" });
  const b = company.hire({ name: "강지호", role: "Engineer" });
  const meeting = company.startMeeting({ topic: "출시 계획", participantIds: [a.id, b.id] });

  assert.equal(company.snapshot().agents.every((x) => x.status === "in_meeting"), true);
  await company.settle();

  const state = company.snapshot();
  const done = state.meetings.find((m) => m.id === meeting.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.endReason, "all_passed");
  // The chair opens and @mentions 강지호; after that the floor goes by raised hands.
  const speeches = done.transcript.filter((e) => e.kind === "speech");
  assert.deepEqual(
    speeches.map((s) => [s.speakerId, s.via]),
    [
      [a.id, "opening"],
      [b.id, "mention"],
      [a.id, "hand"],
      [b.id, "hand"],
    ],
  );
  assert.ok(done.summary);
  assert.equal(done.actionItems.length, 2);
  // Action items became tasks and the participants already worked on them.
  assert.equal(state.tasks.length, 2);
  assert.ok(state.tasks.every((t) => t.sourceMeetingId === meeting.id && t.status === "done"));
  assert.ok(done.actionItems.every((i) => state.tasks.some((t) => t.id === i.taskId)));
});

test("a meeting waits for busy participants and blocks their next task", async () => {
  const company = await newCompany();
  const a = company.hire({ name: "A", role: "PM" });
  const b = company.hire({ name: "B", role: "Engineer" });
  company.createTask({ title: "first", assigneeId: a.id });
  const meeting = company.startMeeting({ topic: "sync", participantIds: [a.id, b.id], maxTurnsPerAgent: 1, createTasks: false });
  company.createTask({ title: "second", assigneeId: b.id });

  let snap = company.snapshot();
  assert.equal(snap.meetings[0].status, "scheduled");
  assert.equal(snap.tasks.find((t) => t.title === "second")!.status, "todo", "B is reserved for the meeting");

  await company.settle();
  snap = company.snapshot();
  assert.equal(snap.meetings.find((m) => m.id === meeting.id)!.status, "done");
  assert.ok(snap.tasks.every((t) => t.status === "done"));
  assert.equal(snap.tasks.length, 2, "createTasks: false adds no tasks");
});

test("meetings need at least two participants", async () => {
  const company = await newCompany();
  const a = company.hire({ name: "A", role: "PM" });
  assert.throws(() => company.startMeeting({ topic: "solo", participantIds: [a.id] }), EngineError);
});

test("busy agents cannot be fired; firing unassigns their queued tasks", async () => {
  const company = await newCompany();
  const a = company.hire({ name: "A", role: "PM" });
  company.createTask({ title: "running", assigneeId: a.id });
  company.createTask({ title: "queued", assigneeId: a.id });
  assert.throws(() => company.fire(a.id), EngineError);
  await company.settle();

  const b = company.hire({ name: "B", role: "PM" });
  const c = company.hire({ name: "C", role: "PM" });
  company.createTask({ title: "keeps A busy", assigneeId: a.id });
  company.startMeeting({ topic: "x", participantIds: [a.id, b.id] });
  company.createTask({ title: "for B", assigneeId: b.id });
  assert.equal(company.snapshot().meetings[0].status, "scheduled");
  // B is idle (reserved for the meeting), so can be let go; the meeting drops below two people.
  company.fire(b.id);
  const snap = company.snapshot();
  assert.equal(snap.meetings[0].status, "failed");
  assert.equal(snap.tasks.find((t) => t.title === "for B")!.assigneeId, null);
  company.fire(c.id);
  await company.settle();
});

test("state is persisted and interrupted work is recovered on reopen", async () => {
  const store = new MemoryStore();
  const company = await newCompany(store);
  const a = company.hire({ name: "A", role: "PM" });
  company.createTask({ title: "t", assigneeId: a.id });
  await company.settle();

  const saved = (await store.load())!;
  saved.tasks[0].status = "in_progress";
  saved.agents[0].status = "working";
  await store.save(saved);

  // The interrupted task is re-queued and picked up again on reopen.
  const reopened = await newCompany(store);
  await reopened.settle();
  const snap = reopened.snapshot();
  assert.equal(snap.tasks[0].status, "done");
  assert.equal(snap.agents[0].status, "idle");
  assert.equal(snap.agents[0].stats.tasksDone, 2);
});

test("LLM failures mark the task failed and free the agent", async () => {
  const llm = new MockLLM(0);
  llm.streamText = async () => {
    throw new Error("boom");
  };
  const company = await Company.open({ llm });
  const a = company.hire({ name: "A", role: "PM" });
  const task = company.createTask({ title: "t", assigneeId: a.id });
  await company.settle();
  const snap = company.snapshot();
  assert.equal(snap.tasks[0].status, "failed");
  assert.equal(snap.tasks[0].error, "boom");
  assert.equal(snap.agents[0].status, "idle");
  assert.equal(company.retryTask(task.id).status, "in_progress");
  await company.settle();
});
