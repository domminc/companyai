import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, CompanyState, Meeting } from "../../../engine/types";
import { buildLayout, DESK_D, DESK_W, type Vec2 } from "./layout";
import { WalkGrid } from "./pathfinding";
import { deskAssignments, type Errand, planBossGoal, planGoals, planOverlays } from "./plan";

function agent(id: string, status: Agent["status"] = "idle", hiredAt = `2026-01-01T00:00:0${id.length}Z`): Agent {
  return {
    id,
    name: id,
    role: "role",
    persona: "",
    skills: [],
    runtime: { kind: "claude", model: "m" },
    status,
    hiredAt,
    stats: { tasksDone: 0, meetingsAttended: 0 },
  };
}

function state(agents: Agent[], extra: Partial<CompanyState> = {}): CompanyState {
  return { name: "c", mission: "", defaultModel: "m", gateways: [], agents, tasks: [], meetings: [], chats: [], activity: [], ...extra };
}

function meeting(partial: Partial<Meeting>): Meeting {
  return {
    id: "m1",
    topic: "t",
    agenda: "",
    participantIds: [],
    maxTurnsPerAgent: 3,
    maxTotalTurns: 9,
    status: "running",
    transcript: [],
    floorQueue: [],
    summary: "",
    decisions: [],
    actionItems: [],
    autoCreateTasks: true,
    outcome: "none",
    createdAt: "",
    ...partial,
  };
}

const pathLength = (p: Vec2[]) => p.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - p[i].x, q.z - p[i].z), 0);

test("layouts grow with the team and keep furniture inside the floor", () => {
  for (const n of [0, 3, 7, 14, 30]) {
    const layout = buildLayout(n);
    assert.ok(layout.desks.length >= Math.max(6, n), `desks for ${n}`);
    assert.ok(layout.meeting.seats.length >= Math.min(Math.max(6, n), 16));
    for (const d of layout.desks) {
      assert.ok(Math.abs(d.x) + DESK_W / 2 < layout.width / 2 && Math.abs(d.z) + DESK_D / 2 < layout.depth / 2);
    }
  }
});

test("every seat, desk and the report spot can be reached from the entrance", () => {
  for (const n of [4, 12, 20]) {
    const layout = buildLayout(n);
    const grid = new WalkGrid(layout);
    const targets = [
      ...layout.desks.map((d) => d.seat),
      ...layout.meeting.seats,
      ...layout.lounge.spots,
      layout.boss.reportSpot,
      layout.boss.seat,
      layout.meeting.hostSpot,
    ];
    for (const t of targets) {
      const path = grid.findPath(layout.entrance, t);
      assert.ok(path.length >= 2);
      // A path that went straight through walls would be as short as the crow flies; a real
      // one exists when every leg except the last step into a seat is clear.
      for (let i = 0; i < path.length - 2; i++) assert.ok(grid.lineClear(path[i], path[i + 1]), `blocked leg towards ${t.x},${t.z}`);
    }
  }
});

test("walking into the meeting room goes round its glass wall, through the door", () => {
  const layout = buildLayout(6);
  const grid = new WalkGrid(layout);
  const seat = layout.meeting.seats[0];
  const path = grid.findPath(layout.desks[0].seat, seat);
  const direct = Math.hypot(seat.x - layout.desks[0].seat.x, seat.z - layout.desks[0].seat.z);
  assert.ok(pathLength(path) > direct + 1, "must detour through the door");
  const { room, doorX, doorWidth } = layout.meeting;
  const roomFront = room.z + room.d / 2;
  // Every leg that crosses the room's front wall line within the room's width does so in the door.
  let crossings = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if ((a.z - roomFront) * (b.z - roomFront) >= 0) continue;
    const x = a.x + ((b.x - a.x) * (roomFront - a.z)) / (b.z - a.z);
    if (x < room.x - room.w / 2 || x > room.x + room.w / 2) continue;
    crossings++;
    assert.ok(Math.abs(x - doorX) < doorWidth / 2, `crossed the wall at x=${x}`);
  }
  assert.equal(crossings, 1);
});

test("desks are assigned by hiring order", () => {
  const a = agent("a", "idle", "2026-01-01T00:00:01Z");
  const b = agent("b", "idle", "2026-01-01T00:00:02Z");
  const c = agent("c", "idle", "2026-01-01T00:00:03Z");
  assert.deepEqual([...deskAssignments([c, a, b])], [["a", 0], ["b", 1], ["c", 2]]);
  const layout = buildLayout(3);
  const before = planGoals(state([a, b, c]), layout, new Map()).get("c")!;
  // Desk indexes are by order among current staff, so the office compacts when someone leaves.
  const after = planGoals(state([a, c]), layout, new Map()).get("c")!;
  assert.equal(before.key, "desk:2");
  assert.equal(after.key, "desk:1");
});

test("goals follow status: meeting seats by participant order, reports, breaks, desks", () => {
  const layout = buildLayout(4);
  const [a, b, c, d] = [agent("a", "in_meeting"), agent("bb", "in_meeting"), agent("ccc", "working"), agent("dddd")];
  const s = state([a, b, c, d], { meetings: [meeting({ participantIds: ["bb", "a"] })] });
  const errands = new Map<string, Errand>([["dddd", { kind: "break", spot: 1, until: 10 }]]);
  const goals = planGoals(s, layout, errands);
  assert.deepEqual(goals.get("bb")!.spot, layout.meeting.seats[0], "the chair takes the head of the table");
  assert.deepEqual(goals.get("a")!.spot, layout.meeting.seats[1]);
  assert.equal(goals.get("ccc")!.activity, "work");
  assert.equal(goals.get("dddd")!.activity, "break");

  errands.set("ccc", { kind: "report", title: "PRD", since: 5 });
  assert.equal(planGoals(s, layout, errands).get("ccc")!.activity, "report");
});

test("overlays show the speaker's words, waiting hands, work and 대표's remarks", () => {
  const s = state([agent("a", "in_meeting"), agent("bb", "in_meeting"), agent("ccc", "working")], {
    tasks: [
      { id: "t", title: "시장 조사 보고서 작성하기", description: "", assigneeId: "ccc", status: "in_progress", output: "", activeTool: "web_search", dependsOn: [], review: { mode: "none" }, revision: 0, reviews: [], createdAt: "", updatedAt: "" },
    ],
    meetings: [
      meeting({
        participantIds: ["a", "bb"],
        phase: "speaking",
        currentSpeakerId: "a",
        transcript: [
          { kind: "speech", id: "s0", speakerId: "user", content: "@a 먼저 말씀해 주세요", via: "user", at: "", endedAt: "" },
          { kind: "poll", id: "p", at: "", raises: [{ agentId: "a", reason: "x" }, { agentId: "bb", reason: "y" }], passes: [], failures: [] },
          { kind: "speech", id: "s1", speakerId: "a", content: "일정은 2주면 충분합니다", via: "hand", at: "" },
        ],
      }),
    ],
  });
  const { agents, boss } = planOverlays(s, new Map());
  assert.deepEqual(agents.get("a")!.bubble, { text: "일정은 2주면 충분합니다", tone: "speech" });
  assert.equal(agents.get("a")!.talking, true);
  assert.equal(agents.get("bb")!.handRaised, true);
  assert.equal(agents.get("a")!.handRaised, false);
  assert.deepEqual(agents.get("ccc")!.bubble, { text: "🔧 web_search", tone: "work" });
  assert.equal(boss, undefined, "대표 spoke before the current speaker");
});

test("대표 goes to the whiteboard of a meeting they joined, otherwise sits at their desk", () => {
  const layout = buildLayout(3);
  const s = state([agent("a", "in_meeting"), agent("bb", "in_meeting")], { meetings: [meeting({ participantIds: ["a", "bb"] })] });
  assert.equal(planBossGoal(s, layout).key, "boss-desk");
  s.meetings[0].userJoined = true;
  const goal = planBossGoal(s, layout);
  assert.deepEqual(goal.spot, layout.meeting.hostSpot);
  assert.equal(goal.pose, "stand");
  s.meetings[0].status = "done";
  assert.equal(planBossGoal(s, layout).key, "boss-desk");
});

test("overlays: a reviewer shows what they review, a chatting employee shows their reply", () => {
  const task = {
    id: "t", title: "보도자료", description: "", assigneeId: "a", status: "review" as const, output: "초안",
    dependsOn: [], review: { mode: "agent" as const, reviewerId: "bb" }, revision: 0, reviews: [], reviewing: true,
    createdAt: "", updatedAt: "",
  };
  const s = state([agent("a"), agent("bb", "working"), agent("ccc")], {
    tasks: [task],
    chats: [{ agentId: "ccc", replying: true, messages: [{ id: "m", from: "agent", content: "네 대표님, 바로 확인하겠습니다", at: "" }] }],
  });
  const errands = new Map<string, Errand>([["a", { kind: "report", title: "보도자료", since: 1, review: true }]]);
  const { agents } = planOverlays(s, errands);
  assert.deepEqual(agents.get("bb")!.bubble, { text: "🔍 보도자료 검토", tone: "work" });
  assert.deepEqual(agents.get("ccc")!.bubble, { text: "💬 네 대표님, 바로 확인하겠습니다", tone: "speech" });
  assert.equal(agents.get("ccc")!.talking, true);
  assert.match(agents.get("a")!.bubble!.text, /검토 부탁드립니다/);
});

test("대표 talking over the current speaker doesn't put 대표's words in the speaker's bubble", () => {
  const s = state([agent("a", "in_meeting"), agent("bb", "in_meeting")], {
    meetings: [
      meeting({
        participantIds: ["a", "bb"],
        userJoined: true,
        phase: "speaking",
        currentSpeakerId: "a",
        transcript: [
          { kind: "speech", id: "s1", speakerId: "a", content: "제 생각에는", via: "hand", at: "" },
          { kind: "speech", id: "s2", speakerId: "user", content: "@bb 의견도 듣고 싶어요", via: "user", at: "", endedAt: "" },
        ],
      }),
    ],
  });
  const { agents, boss } = planOverlays(s, new Map());
  assert.equal(agents.get("a")!.bubble!.text, "제 생각에는");
  assert.equal(boss, "@bb 의견도 듣고 싶어요");
});
