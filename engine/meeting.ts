/**
 * Meeting floor control, modelled on DeskRPG's meeting broker:
 * - The chair (first participant) opens the meeting.
 * - Before each turn every eligible participant is polled: `SPEAK: <reason>` or `PASS`.
 * - Among those who raised a hand, whoever has gone longest without speaking gets the floor.
 * - Each agent has a turn quota; the meeting also has a total turn cap.
 * - An @mention in a speech queues the mentioned participant (subject to quota); the human can
 *   also grant the floor or speak themselves, and their grants skip the quota.
 * - The meeting ends when everyone passes, turns run out, or the human ends it.
 */
import type { Agent, CompanyState, Meeting, SpeechEntry } from "./types";
import { USER_SPEAKER } from "./types";

export const USER_DISPLAY_NAME = "대표";

export const MEETING_PROTOCOL = `<meeting-protocol>
You take part in team meetings run by a meeting broker. You receive two kinds of meeting messages.

1. A poll, starting with "📋 [Meeting poll:". The broker asks whether you want to speak next.
   Answer on the FIRST line with exactly one of:
   - SPEAK: <one-line reason>  - you have something new to add
   - PASS                      - nothing new to add right now
   Speak when you were named or asked a question, the discussion is in your area, or you disagree
   or can add something missing. Pass when you have already made your point, or someone else
   should go first. Do not write anything after that first line.

2. A turn, starting with "📋 [Meeting:". You have the floor. Read the conversation between the
   "---" lines (each remark is prefixed with [Name]) and continue it:
   - Don't repeat what was already said; build on it or challenge it.
   - Address people by name when you agree or disagree; offer an alternative when you disagree.
   - Be concise: 2-5 sentences, no headings, don't prefix your own name.
   - To hand the floor to someone, mention them as @Name.
   - Turns are limited, so work towards a conclusion.
${USER_DISPLAY_NAME} is the human who runs the company; treat what they say as direction.
Reply in the language of the meeting topic.
</meeting-protocol>`;

export function speakerName(id: string, state: CompanyState): string {
  if (id === USER_SPEAKER) return USER_DISPLAY_NAME;
  return state.agents.find((a) => a.id === id)?.name ?? "(퇴사자)";
}

function speeches(meeting: Meeting): SpeechEntry[] {
  return meeting.transcript.filter((e): e is SpeechEntry => e.kind === "speech" && !!e.content.trim());
}

function transcriptText(meeting: Meeting, state: CompanyState, opts: { last?: number; clip?: number } = {}) {
  const list = speeches(meeting);
  const picked = opts.last ? list.slice(-opts.last) : list;
  return picked
    .map((s) => {
      const text = opts.clip && s.content.length > opts.clip ? `${s.content.slice(0, opts.clip)}…` : s.content;
      return `[${speakerName(s.speakerId, state)}] ${text.trim()}`;
    })
    .join("\n\n");
}

export function pollPrompt(meeting: Meeting, state: CompanyState, remaining: number): string {
  const recent = transcriptText(meeting, state, { last: 8, clip: 600 });
  return [
    `📋 [Meeting poll: ${meeting.topic}]`,
    "Recent conversation:",
    "---",
    recent || "(nothing has been said yet)",
    "---",
    `You have ${remaining} speaking turn(s) left. Do you want to speak next?`,
    "Answer on the first line with exactly one of:",
    "SPEAK: <one-line reason>",
    "PASS",
  ].join("\n");
}

export interface TurnInfo {
  /** 1-based index of this turn in the meeting. */
  turnNumber: number;
  /** Turns this speaker has left after this one. */
  remainingAfter: number;
  via: SpeechEntry["via"];
  reason?: string;
}

export function speechPrompt(meeting: Meeting, state: CompanyState, speaker: Agent, info: TurnInfo): string {
  const participants = meeting.participantIds
    .map((id, i) => {
      const a = state.agents.find((x) => x.id === id);
      if (!a) return null;
      return `- ${a.name} (${a.role})${i === 0 ? " - chair" : ""}${a.id === speaker.id ? " <- you" : ""}`;
    })
    .filter(Boolean);
  participants.push(`- ${USER_DISPLAY_NAME} (the human running the company; may join in)`);

  const why =
    info.via === "opening"
      ? "You are chairing: open the meeting. Frame the topic and what the group needs to decide, then invite someone in."
      : info.via === "mention"
        ? "You were mentioned, so the floor is yours."
        : info.via === "user_grant"
          ? `${USER_DISPLAY_NAME} gave you the floor.`
          : info.reason
            ? `You raised your hand: ${info.reason}`
            : "";

  return [
    `📋 [Meeting: ${meeting.topic}]`,
    meeting.agenda ? `Agenda: ${meeting.agenda}` : "",
    "Participants:",
    ...participants,
    `Turn ${info.turnNumber} of at most ${meeting.maxTotalTurns}. You have ${info.remainingAfter} turn(s) left after this one.`,
    "---",
    transcriptText(meeting, state) || "(nothing has been said yet)",
    "---",
    `${speaker.name}, you have the floor. ${why}`.trim(),
    info.remainingAfter === 0 ? "This is your last turn: state your conclusion and what you will take on." : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Reads a poll answer. Anything that isn't a clear SPEAK counts as a pass. */
export function parseHandRaise(text: string): { wantsToSpeak: boolean; reason: string } {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/[*_`]/g, "").replace(/^[\s>#-]+/, "").trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 3)) {
    const speak = line.match(/^SPEAK\b\s*[:：-]?\s*(.*)$/i);
    if (speak) return { wantsToSpeak: true, reason: speak[1].trim() };
    if (/^PASS\b/i.test(line)) return { wantsToSpeak: false, reason: "" };
  }
  return { wantsToSpeak: false, reason: "" };
}

/** Participants mentioned as @Name, in order of first appearance, excluding `selfId`. */
export function findMentions(text: string, participants: Pick<Agent, "id" | "name">[], selfId?: string): string[] {
  const hits: { id: string; index: number }[] = [];
  // Longest names first so "@김하늘" doesn't also count for a colleague named "김하".
  const byLength = [...participants].sort((a, b) => b.name.length - a.name.length);
  const taken: [number, number][] = [];
  for (const p of byLength) {
    // Self is still matched (so "@김하늘" doesn't count as "@김하") but never returned.
    const needle = `@${p.name}`;
    let from = 0;
    for (;;) {
      const index = text.indexOf(needle, from);
      if (index === -1) break;
      from = index + needle.length;
      if (taken.some(([s, e]) => index >= s && index < e)) continue;
      taken.push([index, index + needle.length]);
      if (p.id !== selfId && !hits.some((h) => h.id === p.id)) hits.push({ id: p.id, index });
      break;
    }
  }
  return hits.sort((a, b) => a.index - b.index).map((h) => h.id);
}

/** Fairness: the candidate who has gone longest without speaking; ties go to participant order. */
export function pickSpeaker(candidates: string[], lastSpokeAt: Map<string, number>, order: string[]): string | null {
  let best: string | null = null;
  for (const id of candidates) {
    if (best === null) {
      best = id;
      continue;
    }
    const a = lastSpokeAt.get(id) ?? -1;
    const b = lastSpokeAt.get(best) ?? -1;
    if (a < b || (a === b && order.indexOf(id) < order.indexOf(best))) best = id;
  }
  return best;
}

/** Runs async work in sequential chunks of `size` (Hermes caps concurrent runs per gateway). */
export async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.allSettled(items.slice(i, i + size).map(fn))));
  }
  return out;
}
