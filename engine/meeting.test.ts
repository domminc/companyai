import assert from "node:assert/strict";
import { test } from "node:test";
import { Company, EngineError } from "./company";
import type { LLMContext } from "./llm";
import { findMentions, parseHandRaise, pickSpeaker } from "./meeting";
import { ScriptedLLM } from "./testing/scripted-llm";
import type { Meeting, NoticeEntry, PollEntry, SpeechEntry } from "./types";
import { USER_SPEAKER } from "./types";

type Script = (ctx: LLMContext) => string | Promise<string>;

async function setup(script: Script, names = ["A", "B", "C"]) {
  const company = await Company.open({ llm: new ScriptedLLM(script) });
  const agents = names.map((name) => company.hire({ name, role: `${name} role` }));
  return { company, agents };
}

const speeches = (m: Meeting) => m.transcript.filter((e): e is SpeechEntry => e.kind === "speech");
const polls = (m: Meeting) => m.transcript.filter((e): e is PollEntry => e.kind === "poll");
const notices = (m: Meeting) => m.transcript.filter((e): e is NoticeEntry => e.kind === "notice");
const meetingOf = (company: Company, id: string) => company.snapshot().meetings.find((m) => m.id === id)!;

// ------------------------------------------------------------------ helpers

test("parseHandRaise reads SPEAK/PASS leniently", () => {
  assert.deepEqual(parseHandRaise("SPEAK: 일정 리스크가 있어요"), { wantsToSpeak: true, reason: "일정 리스크가 있어요" });
  assert.deepEqual(parseHandRaise("**SPEAK**: 보충할게요"), { wantsToSpeak: true, reason: "보충할게요" });
  assert.deepEqual(parseHandRaise("\n  speak - quick point"), { wantsToSpeak: true, reason: "quick point" });
  assert.equal(parseHandRaise("PASS").wantsToSpeak, false);
  assert.equal(parseHandRaise("Pass for now").wantsToSpeak, false);
  assert.equal(parseHandRaise("음... 잘 모르겠네요").wantsToSpeak, false);
  assert.equal(parseHandRaise("").wantsToSpeak, false);
});

test("findMentions matches the longest name, skips self and keeps order", () => {
  const people = [
    { id: "1", name: "김하" },
    { id: "2", name: "김하늘" },
    { id: "3", name: "Lee Do" },
  ];
  assert.deepEqual(findMentions("@Lee Do 그리고 @김하늘 생각은?", people), ["3", "2"]);
  assert.deepEqual(findMentions("@김하 @김하늘", people), ["1", "2"]);
  assert.deepEqual(findMentions("@김하늘 @Lee Do", people, "2"), ["3"]);
  assert.deepEqual(findMentions("no mentions", people), []);
});

test("pickSpeaker favours whoever has been silent longest, then participant order", () => {
  const order = ["a", "b", "c"];
  assert.equal(pickSpeaker(["b", "c"], new Map(), order), "b");
  assert.equal(pickSpeaker(["a", "b", "c"], new Map([["a", 3], ["b", 1], ["c", 2]]), order), "b");
  assert.equal(pickSpeaker(["a", "c"], new Map([["a", 5]]), order), "c");
  assert.equal(pickSpeaker([], new Map(), order), null);
});

// ------------------------------------------------------------ floor control

test("the chair opens; when everyone passes the meeting ends", async () => {
  const { company, agents } = await setup((ctx) => (ctx.kind === "poll" ? "PASS" : "회의를 시작합니다."), ["A", "B"]);
  const m = company.startMeeting({ topic: "t", participantIds: agents.map((a) => a.id) });
  await company.settle();
  const done = meetingOf(company, m.id);
  assert.equal(done.status, "done");
  assert.equal(done.endReason, "all_passed");
  assert.deepEqual(speeches(done).map((s) => [s.speakerId, s.via]), [[agents[0].id, "opening"]]);
  assert.deepEqual(polls(done)[0].passes.sort(), agents.map((a) => a.id).sort());
});

test("raised hands are served fairly and each agent's quota is enforced", async () => {
  const { company, agents } = await setup((ctx) => (ctx.kind === "poll" ? "SPEAK: 할 말 있음" : "의견입니다."));
  const [a, b, c] = agents;
  const m = company.startMeeting({ topic: "t", participantIds: [a.id, b.id, c.id], maxTurnsPerAgent: 2 });
  await company.settle();
  const done = meetingOf(company, m.id);
  assert.deepEqual(speeches(done).map((s) => s.speakerId), [a.id, b.id, c.id, a.id, b.id, c.id]);
  assert.deepEqual(speeches(done).slice(1).map((s) => [s.via, s.reason]), Array(5).fill(["hand", "할 말 있음"]));
  assert.equal(done.endReason, "turn_limit");
});

test("an @mention hands over the floor; a mentioned agent without turns left is skipped", async () => {
  const { company, agents } = await setup((ctx) => {
    if (ctx.kind === "poll") return ctx.remaining > 0 ? "SPEAK: 보충" : "PASS";
    if (ctx.kind !== "meeting") return "";
    if (ctx.opening) return "시작하죠. @B 먼저 말씀해 주세요.";
    if (ctx.agentName === "B") return "좋습니다. @A 질문이 있어요.";
    return "정리하겠습니다.";
  });
  const [a, b, c] = agents;
  const m = company.startMeeting({ topic: "t", participantIds: [a.id, b.id, c.id], maxTurnsPerAgent: 1 });
  await company.settle();
  const done = meetingOf(company, m.id);
  assert.deepEqual(speeches(done).map((s) => [s.speakerId, s.via]), [
    [a.id, "opening"],
    [b.id, "mention"],
    [c.id, "hand"],
  ]);
  assert.ok(notices(done).some((n) => n.text.includes("A님은 발언 횟수를 다 써서")));
});

test("the human can speak, @mention and grant the floor, bypassing the quota", async () => {
  let releaseOpening!: () => void;
  const openingHeld = new Promise<void>((r) => (releaseOpening = r));
  const { company, agents } = await setup(async (ctx) => {
    if (ctx.kind === "poll") return "PASS";
    if (ctx.kind === "meeting" && ctx.opening) await openingHeld;
    return "네.";
  });
  const [a, b, c] = agents;
  const m = company.startMeeting({ topic: "t", participantIds: [a.id, b.id, c.id], maxTurnsPerAgent: 1 });
  await new Promise((r) => setImmediate(r));

  company.postMeetingMessage(m.id, "@C 님 의견부터 듣고 싶어요");
  company.grantFloor(m.id, a.id); // A has used its only turn on the opening
  releaseOpening();
  await company.settle();

  const done = meetingOf(company, m.id);
  const order = speeches(done).map((s) => [s.speakerId, s.via]);
  assert.deepEqual(order, [
    [a.id, "opening"],
    [USER_SPEAKER, "user"],
    [c.id, "user_grant"],
    [a.id, "user_grant"],
  ]);
  assert.throws(() => company.postMeetingMessage(m.id, "끝난 회의"), EngineError);
  void b;
});

test("ending the meeting stops after the current speaker and still writes minutes", async () => {
  let company!: Company;
  let meetingId = "";
  let turns = 0;
  ({ company } = await setup((ctx) => {
    if (ctx.kind === "poll") return "SPEAK: 계속";
    if (ctx.kind === "meeting" && ++turns === 2) company.endMeeting(meetingId);
    return "발언";
  }));
  const ids = company.snapshot().agents.map((a) => a.id);
  meetingId = company.startMeeting({ topic: "t", participantIds: ids, maxTurnsPerAgent: 5 }).id;
  await company.settle();
  const done = meetingOf(company, meetingId);
  assert.equal(done.status, "done");
  assert.equal(done.endReason, "ended_by_user");
  assert.equal(speeches(done).length, 2);
  assert.ok(done.summary);
});

test("an unreachable participant is a failure, not a pass; nobody reachable fails the meeting", async () => {
  const flaky = await setup((ctx) => {
    if (ctx.kind === "poll" && ctx.agentName === "B") throw new Error("gateway down");
    return ctx.kind === "poll" ? "PASS" : "시작";
  });
  const m1 = flaky.company.startMeeting({ topic: "t", participantIds: flaky.agents.map((a) => a.id) });
  await flaky.company.settle();
  const done = meetingOf(flaky.company, m1.id);
  assert.equal(done.status, "done");
  assert.deepEqual(polls(done)[0].failures.map((f) => [f.agentId, f.reason]), [[flaky.agents[1].id, "gateway down"]]);
  assert.deepEqual(polls(done)[0].passes, [flaky.agents[0].id, flaky.agents[2].id]);

  const down = await setup((ctx) => {
    if (ctx.kind === "poll") throw new Error("offline");
    return "시작";
  });
  const m2 = down.company.startMeeting({ topic: "t", participantIds: down.agents.map((a) => a.id) });
  await down.company.settle();
  const failed = meetingOf(down.company, m2.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /offline/);
  assert.ok(down.company.snapshot().agents.every((a) => a.status === "idle"));
});

test("a failed speech is noted and the meeting carries on", async () => {
  const { company, agents } = await setup((ctx) => {
    if (ctx.kind === "poll") return ctx.agentName === "B" && ctx.turnsTaken === 0 ? "SPEAK: 제 차례" : "PASS";
    if (ctx.kind === "meeting" && ctx.agentName === "B") throw new Error("model overloaded");
    return "시작";
  });
  const m = company.startMeeting({ topic: "t", participantIds: agents.map((a) => a.id) });
  await company.settle();
  const done = meetingOf(company, m.id);
  assert.equal(done.status, "done");
  assert.ok(notices(done).some((n) => n.text.includes("B님의 발언이 실패") && n.text.includes("model overloaded")));
});
