import assert from "node:assert/strict";
import { test } from "node:test";
import { Company, EngineError } from "./company";
import type { LLMContext, TextRequest } from "./llm";
import { MockLLM } from "./llm";
import { parseVerdict } from "./prompts";
import { ScriptedLLM } from "./testing/scripted-llm";
import { USER_SPEAKER } from "./types";

const find = (company: Company, id: string) => company.snapshot().tasks.find((t) => t.id === id)!;

// ------------------------------------------------------------------- review

test("parseVerdict reads APPROVE / CHANGES and flags anything else as unclear", () => {
  assert.deepEqual(parseVerdict("APPROVE\n좋아요"), { verdict: "approved", comment: "좋아요" });
  assert.deepEqual(parseVerdict("**CHANGES**: 수치 근거 추가"), { verdict: "changes", comment: "수치 근거 추가" });
  assert.equal(parseVerdict("Request changes - too short").verdict, "changes");
  assert.equal(parseVerdict("음 괜찮은 것 같기도 하고").verdict, "unclear");
});

test("with 대표 review, finished work waits in review; changes send it back with the feedback", async () => {
  const llm = new ScriptedLLM((ctx) => (ctx.kind === "task" ? "결과물 v" : ""));
  const company = await Company.open({ llm });
  const a = company.hire({ name: "A", role: "PM" });
  const task = company.createTask({ title: "PRD", assigneeId: a.id, acceptance: "목표·범위·지표 포함", review: { mode: "human" } });
  await company.settle();
  assert.equal(find(company, task.id).status, "review");
  assert.equal(company.snapshot().agents[0].stats.tasksDone, 0, "not done until approved");

  assert.throws(() => company.reviewTask(task.id, { approve: false }), EngineError, "a rejection needs a reason");
  company.reviewTask(task.id, { approve: false, comment: "지표를 구체적으로" });
  await company.settle();
  const reworked = find(company, task.id);
  assert.equal(reworked.status, "review");
  assert.equal(reworked.revision, 1);
  const prompt = llm.calls.at(-1)!.prompt;
  assert.match(prompt, /지표를 구체적으로/);
  assert.match(prompt, /<previous>\n결과물 v\n<\/previous>/);
  assert.match(prompt, /Done means: 목표·범위·지표 포함/);

  company.reviewTask(task.id, { approve: true });
  const done = find(company, task.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.reviews.map((r) => [r.by, r.verdict, r.revision]), [
    [USER_SPEAKER, "changes", 0],
    [USER_SPEAKER, "approved", 1],
  ]);
  assert.equal(company.snapshot().agents[0].stats.tasksDone, 1);
  assert.throws(() => company.reviewTask(task.id, { approve: true }), EngineError);
});

test("an AI colleague reviews: sends the first attempt back, approves the revision", async () => {
  const company = await Company.open({ llm: new MockLLM(0) });
  const writer = company.hire({ name: "Writer", role: "Marketer" });
  const reviewer = company.hire({ name: "Editor", role: "Editor" });
  assert.throws(() => company.createTask({ title: "x", assigneeId: writer.id, review: { mode: "agent", reviewerId: writer.id } }), EngineError);

  const task = company.createTask({ title: "보도자료", assigneeId: writer.id, review: { mode: "agent", reviewerId: reviewer.id } });
  await company.settle();
  const done = find(company, task.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.reviews.map((r) => [r.by, r.verdict]), [
    [reviewer.id, "changes"],
    [reviewer.id, "approved"],
  ]);
  assert.equal(done.revision, 1);
  assert.equal(company.snapshot().agents.every((a) => a.status === "idle"), true);
});

test("an AI reviewer that keeps rejecting, or answers unclearly, hands the task to 대표", async () => {
  const stubborn = await Company.open({ llm: new ScriptedLLM((ctx) => (ctx.kind === "review" ? "CHANGES: 다시" : "초안")) });
  const w = stubborn.hire({ name: "W", role: "r" });
  const r = stubborn.hire({ name: "R", role: "r" });
  const t = stubborn.createTask({ title: "t", assigneeId: w.id, review: { mode: "agent", reviewerId: r.id } });
  await stubborn.settle();
  const escalated = find(stubborn, t.id);
  assert.equal(escalated.status, "review");
  assert.deepEqual(escalated.review, { mode: "human" });
  assert.equal(escalated.reviews.length, 3, "two rejections sent back, the third escalated");

  const vague = await Company.open({ llm: new ScriptedLLM((ctx) => (ctx.kind === "review" ? "글쎄요" : "초안")) });
  const w2 = vague.hire({ name: "W", role: "r" });
  const r2 = vague.hire({ name: "R", role: "r" });
  const t2 = vague.createTask({ title: "t", assigneeId: w2.id, review: { mode: "agent", reviewerId: r2.id } });
  await vague.settle();
  assert.deepEqual(find(vague, t2.id).review, { mode: "human" });
});

// ------------------------------------------------------------- dependencies

test("a task waits for its prerequisites; a failed prerequisite keeps it waiting", async () => {
  let failFirst = true;
  const llm = new ScriptedLLM((ctx) => {
    if (ctx.kind === "task" && ctx.title === "flaky" && failFirst) throw new Error("boom");
    return "ok";
  });
  const company = await Company.open({ llm });
  const a = company.hire({ name: "A", role: "r" });
  const b = company.hire({ name: "B", role: "r" });
  const first = company.createTask({ title: "flaky", assigneeId: a.id });
  const second = company.createTask({ title: "next", assigneeId: b.id, dependsOn: [first.id, "tsk_missing"] });
  assert.deepEqual(find(company, second.id).dependsOn, [first.id], "unknown ids are dropped");
  assert.equal(find(company, second.id).status, "todo", "B is idle but must wait");
  await company.settle();
  assert.equal(find(company, first.id).status, "failed");
  assert.equal(find(company, second.id).status, "todo", "still blocked");

  failFirst = false;
  company.retryTask(first.id);
  await company.settle();
  assert.equal(find(company, second.id).status, "done");
});

test("deleting a prerequisite unblocks the tasks that waited for it", async () => {
  const company = await Company.open({ llm: new MockLLM(0) });
  const b = company.hire({ name: "B", role: "r" });
  const first = company.createTask({ title: "unassigned prerequisite" });
  const second = company.createTask({ title: "next", assigneeId: b.id, dependsOn: [first.id] });
  await company.settle();
  assert.equal(find(company, second.id).status, "todo");
  company.deleteTask(first.id);
  await company.settle();
  assert.equal(find(company, second.id).status, "done");
});

// ---------------------------------------------------------- meeting outcome

test("meeting results wait as a draft; 대표 edits and registers them with dependencies", async () => {
  const company = await Company.open({ llm: new MockLLM(0) });
  const [a, b, c] = ["A", "B", "C"].map((n) => company.hire({ name: n, role: `${n} role` }));
  const m = company.startMeeting({ topic: "출시", participantIds: [a.id, b.id, c.id], createTasks: false });
  await company.settle();

  let meeting = company.snapshot().meetings.find((x) => x.id === m.id)!;
  assert.equal(meeting.outcome, "draft");
  assert.equal(company.snapshot().tasks.length, 0, "nothing registered yet");
  assert.deepEqual(meeting.actionItems.map((i) => i.after), [[], [0], [0]]);
  assert.ok(meeting.actionItems.every((i) => i.acceptance && i.include));

  const tasks = company.registerOutcome(m.id, {
    items: [{ title: "기준안 작성", assigneeId: b.id }, { include: false }, null],
    review: { mode: "agent", reviewerId: c.id },
  });
  assert.equal(tasks.length, 2);
  const [base, follow] = tasks;
  assert.equal(base.title, "기준안 작성");
  assert.equal(base.assigneeId, b.id);
  assert.deepEqual(base.review, { mode: "agent", reviewerId: c.id });
  assert.deepEqual(follow.dependsOn, [base.id], "item 2 came after item 0");
  assert.equal(follow.assigneeId, c.id);
  assert.deepEqual(follow.review, { mode: "human" }, "C can't review C's own item");
  meeting = company.snapshot().meetings.find((x) => x.id === m.id)!;
  assert.equal(meeting.outcome, "registered");
  assert.equal(meeting.actionItems[1].taskId, undefined);
  assert.throws(() => company.registerOutcome(m.id), EngineError);
  await company.settle();
});

test("with createTasks the outcome is registered straight away", async () => {
  const company = await Company.open({ llm: new MockLLM(0) });
  const [a, b] = ["A", "B"].map((n) => company.hire({ name: n, role: "r" }));
  const m = company.startMeeting({ topic: "t", participantIds: [a.id, b.id] });
  await company.settle();
  const snap = company.snapshot();
  assert.equal(snap.meetings[0].outcome, "registered");
  assert.equal(snap.tasks.length, 2);
  assert.deepEqual(snap.tasks[1].dependsOn, [snap.tasks[0].id]);
  assert.ok(snap.tasks.every((t) => t.status === "done" && t.sourceMeetingId === m.id));
});

// --------------------------------------------------------------------- chat

test("1:1 chat: replies stream in, keep history, and one reply at a time", async () => {
  const llm = new ScriptedLLM((ctx) => (ctx.kind === "chat" ? `답: ${ctx.message}` : ""));
  const company = await Company.open({ llm });
  const a = company.hire({ name: "하늘", role: "PM" });
  const deltas: string[] = [];
  company.subscribe((e) => e.type === "chat.delta" && deltas.push(e.text));

  const thread = company.chat(a.id, "로드맵 어때요?");
  assert.equal(thread.replying, true);
  assert.throws(() => company.chat(a.id, "또"), (e: EngineError) => e.status === 409);
  await company.settle();
  company.chat(a.id, "좋아요, 진행하죠");
  await company.settle();

  const snap = company.snapshot().chats.find((c) => c.agentId === a.id)!;
  assert.deepEqual(snap.messages.map((m) => [m.from, m.content]), [
    ["user", "로드맵 어때요?"],
    ["agent", "답: 로드맵 어때요?"],
    ["user", "좋아요, 진행하죠"],
    ["agent", "답: 좋아요, 진행하죠"],
  ]);
  assert.equal(snap.replying, false);
  assert.deepEqual(deltas, ["답: 로드맵 어때요?", "답: 좋아요, 진행하죠"]);
  const lastPrompt = (llm.calls.at(-1) as TextRequest).prompt;
  assert.match(lastPrompt, /\[대표\] 로드맵 어때요\?/);
  assert.match(lastPrompt, /\[하늘\] 답: 로드맵 어때요\?/);
  assert.equal(company.snapshot().agents[0].status, "idle", "chatting doesn't take the agent off work");

  company.fire(a.id);
  assert.equal(company.snapshot().chats.length, 0);
});

test("a failed chat reply is marked, and the thread can be cleared", async () => {
  const company = await Company.open({ llm: new ScriptedLLM(() => Promise.reject(new Error("down"))) });
  const a = company.hire({ name: "A", role: "r" });
  company.chat(a.id, "hi");
  await company.settle();
  const reply = company.snapshot().chats[0].messages[1];
  assert.equal(reply.error, true);
  assert.match(reply.content, /down/);
  company.clearChat(a.id);
  assert.equal(company.snapshot().chats.length, 0);
});

// ------------------------------------------------------------ joining a meeting

test("대표 joins a running meeting by speaking or explicitly", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const company = await Company.open({
    llm: new ScriptedLLM(async (ctx: LLMContext) => {
      if (ctx.kind === "meeting" && ctx.opening) await held;
      return ctx.kind === "poll" ? "PASS" : "네";
    }),
  });
  const [a, b] = ["A", "B"].map((n) => company.hire({ name: n, role: "r" }));
  const m = company.startMeeting({ topic: "t", participantIds: [a.id, b.id] });
  await new Promise((r) => setImmediate(r));
  assert.equal(company.joinMeeting(m.id).userJoined, true);
  assert.equal(company.joinMeeting(m.id, false).userJoined, false);
  company.postMeetingMessage(m.id, "안녕하세요");
  assert.equal(company.snapshot().meetings[0].userJoined, true);
  release();
  await company.settle();
  assert.throws(() => company.joinMeeting(m.id), EngineError);
});
