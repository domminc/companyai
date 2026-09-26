/**
 * Decides where every employee should be and what floats over their head, from engine state.
 * Pure (no three.js): the scene just walks actors to these goals.
 */
import type { Agent, CompanyState, Meeting, SpeechEntry } from "../../../engine/types";
import type { OfficeLayout, Spot } from "./layout";

export type Activity = "work" | "idle" | "meeting" | "report" | "break";

export interface Goal {
  /** Changes whenever the destination changes; the scene re-plans a path then. */
  key: string;
  spot: Spot;
  pose: "sit" | "stand";
  activity: Activity;
}

/** Short-lived things the office does on its own: walking over to report, a coffee break. */
export type Errand =
  | { kind: "report"; title: string; since: number }
  | { kind: "break"; spot: number; until: number };

export type BubbleTone = "speech" | "work" | "report" | "think" | "note";

export interface Overlay {
  bubble?: { text: string; tone: BubbleTone };
  handRaised: boolean;
  talking: boolean;
  typing: boolean;
}

/** Stable desk per agent: by hiring order, so nobody swaps desks when a colleague leaves. */
export function deskAssignments(agents: Agent[]): Map<string, number> {
  const sorted = [...agents].sort((a, b) => a.hiredAt.localeCompare(b.hiredAt) || a.id.localeCompare(b.id));
  return new Map(sorted.map((a, i) => [a.id, i]));
}

/** Running meetings; the first gets the meeting room, any others meet in the lounge. */
export function runningMeetings(state: CompanyState): Meeting[] {
  return state.meetings.filter((m) => m.status === "running");
}

export function planGoals(state: CompanyState, layout: OfficeLayout, errands: Map<string, Errand>): Map<string, Goal> {
  const goals = new Map<string, Goal>();
  const desks = deskAssignments(state.agents);
  const meetings = runningMeetings(state);
  let reporters = 0;

  for (const agent of state.agents) {
    const meetingIndex = meetings.findIndex((m) => m.participantIds.includes(agent.id));
    if (agent.status === "in_meeting" && meetingIndex !== -1) {
      const meeting = meetings[meetingIndex];
      const seat = meeting.participantIds.indexOf(agent.id);
      const spot =
        meetingIndex === 0
          ? layout.meeting.seats[seat % layout.meeting.seats.length]
          : layout.lounge.spots[seat % layout.lounge.spots.length];
      goals.set(agent.id, { key: `meeting:${meeting.id}:${seat}`, spot, pose: meetingIndex === 0 ? "sit" : "stand", activity: "meeting" });
      continue;
    }

    const errand = errands.get(agent.id);
    if (errand?.kind === "report") {
      const r = layout.boss.reportSpot;
      const offset = (reporters++ % 3) * 0.7;
      goals.set(agent.id, { key: `report:${errand.since}`, spot: { ...r, x: r.x + offset }, pose: "stand", activity: "report" });
      continue;
    }
    if (errand?.kind === "break" && agent.status === "idle") {
      const spot = layout.lounge.spots[errand.spot % layout.lounge.spots.length];
      goals.set(agent.id, { key: `break:${errand.spot}`, spot, pose: "stand", activity: "break" });
      continue;
    }

    const desk = layout.desks[(desks.get(agent.id) ?? 0) % layout.desks.length];
    goals.set(agent.id, {
      key: `desk:${desks.get(agent.id)}`,
      spot: desk.seat,
      pose: "sit",
      activity: agent.status === "working" ? "work" : "idle",
    });
  }
  return goals;
}

function clip(text: string, max: number, fromEnd = false): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return fromEnd ? `…${t.slice(-max)}` : `${t.slice(0, max)}…`;
}

function lastSpeech(meeting: Meeting): SpeechEntry | undefined {
  for (let i = meeting.transcript.length - 1; i >= 0; i--) {
    const e = meeting.transcript[i];
    if (e.kind === "speech") return e;
  }
  return undefined;
}

/** Hands still up from the last poll: raised, but someone else got the floor. */
function waitingHands(meeting: Meeting): Set<string> {
  let pollAt = -1;
  for (let i = meeting.transcript.length - 1; i >= 0; i--) {
    if (meeting.transcript[i].kind === "poll") {
      pollAt = i;
      break;
    }
  }
  if (pollAt === -1 || meeting.phase !== "speaking") return new Set();
  const poll = meeting.transcript[pollAt];
  if (poll.kind !== "poll") return new Set();
  return new Set(poll.raises.map((r) => r.agentId).filter((id) => id !== meeting.currentSpeakerId));
}

export interface Overlays {
  agents: Map<string, Overlay>;
  /** What 대표 (the user) last said in a running meeting. */
  boss?: string;
}

export function planOverlays(state: CompanyState, errands: Map<string, Errand>): Overlays {
  const agents = new Map<string, Overlay>();
  const meetings = runningMeetings(state);
  let boss: string | undefined;

  for (const agent of state.agents) {
    const overlay: Overlay = { handRaised: false, talking: false, typing: false };
    const meeting = meetings.find((m) => m.participantIds.includes(agent.id));
    const errand = errands.get(agent.id);

    if (meeting && agent.status === "in_meeting") {
      if (meeting.phase === "speaking" && meeting.currentSpeakerId === agent.id) {
        const speech = lastSpeech(meeting);
        overlay.talking = true;
        overlay.bubble = { text: speech?.content ? clip(speech.content, 90, true) : "…", tone: "speech" };
      } else if (meeting.phase === "polling") {
        overlay.bubble = { text: "🤔", tone: "think" };
      } else if (meeting.phase === "summarizing" && meeting.participantIds[0] === agent.id) {
        overlay.bubble = { text: "📝 회의록 정리 중", tone: "note" };
      }
      overlay.handRaised = waitingHands(meeting).has(agent.id);
    } else if (errand?.kind === "report") {
      overlay.bubble = { text: `✅ "${clip(errand.title, 16)}" 완료했습니다`, tone: "report" };
    } else if (agent.status === "working") {
      const task = state.tasks.find((t) => t.assigneeId === agent.id && t.status === "in_progress");
      overlay.typing = true;
      if (task) overlay.bubble = { text: task.activeTool ? `🔧 ${task.activeTool}` : `💻 ${clip(task.title, 14)}`, tone: "work" };
    }
    agents.set(agent.id, overlay);
  }

  for (const meeting of meetings) {
    const speech = lastSpeech(meeting);
    if (speech?.speakerId === "user") boss = clip(speech.content, 70);
  }
  return { agents, boss };
}
