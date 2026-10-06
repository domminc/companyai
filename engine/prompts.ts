import { entrySpeaker, speakerName, USER_DISPLAY_NAME } from "./meeting";
import type { Agent, CompanyState, Meeting, SpeechEntry, Task } from "./types";

const LANGUAGE_RULE = "Reply in the same language the request is written in.";

/** Who the agent is. Only Claude agents get this; a Hermes profile's identity is its SOUL.md. */
export function agentIdentity(agent: Agent): string {
  return [
    `You are ${agent.name}.`,
    agent.persona,
    agent.skills.length ? `Your strengths: ${agent.skills.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Where the agent works. Sent to every backend. */
export function workplaceContext(agent: Agent, state: CompanyState): string {
  const colleagues = state.agents
    .filter((a) => a.id !== agent.id)
    .map((a) => `- ${a.name} (${a.role})`)
    .join("\n");
  return [
    "<workplace>",
    `You work at ${state.name} as ${agent.role}, under the name ${agent.name}.`,
    state.mission ? `Company mission: ${state.mission}` : "",
    colleagues ? `Colleagues:\n${colleagues}` : "You are currently the only member of the company.",
    "When information is missing, state your assumptions briefly and proceed instead of asking questions.",
    LANGUAGE_RULE,
    "</workplace>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** An attached file as the agent sees it: its text, or a note on why there is none. */
export interface AttachmentForPrompt {
  name: string;
  text?: string;
  note?: string;
}

export function taskPrompt(task: Task, sourceMeeting?: Meeting, attachments: AttachmentForPrompt[] = []): string {
  const parts = [`You have been assigned a task.`, "", `# ${task.title}`, "", task.description || "(no further description)"];
  if (sourceMeeting) {
    parts.push(
      "",
      `This task came out of the meeting "${sourceMeeting.topic}".`,
      `Meeting summary: ${sourceMeeting.summary}`,
      sourceMeeting.decisions.length ? `Decisions:\n${sourceMeeting.decisions.map((d) => `- ${d}`).join("\n")}` : "",
    );
  }
  if (task.acceptance) parts.push("", `Done means: ${task.acceptance}`);
  if (attachments.length) {
    parts.push("", "Reference files were attached to this task:");
    for (const a of attachments) {
      if (a.text !== undefined) parts.push(`<file name="${a.name.replace(/"/g, "'")}">`, a.text.replace(/<\/file>/g, "<\\/file>"), "</file>");
      else parts.push(`- ${a.name}${a.note ? ` (${a.note})` : ""}`);
    }
  }
  const feedback = task.reviews.filter((r) => r.verdict === "changes").at(-1);
  if (task.revision > 0 && feedback) {
    parts.push(
      "",
      `Your previous version was sent back for changes (revision ${task.revision}).`,
      `Reviewer feedback: ${feedback.comment || "(no comment)"}`,
      task.previousOutput ? `Previous version:\n<previous>\n${task.previousOutput}\n</previous>` : "",
      "Address every point of the feedback in a complete new version.",
    );
  }
  parts.push(
    "",
    "Produce the finished deliverable itself in Markdown - not a plan to produce it.",
    "End with a short 'Next steps' list if follow-up work is needed.",
  );
  return parts.filter((p, i, all) => p !== "" || all[i - 1] !== "").join("\n");
}

/** Marker the review prompt starts with (also lets fake gateways recognise it). */
export const REVIEW_MARKER = "📋 [Review:";

export function reviewPrompt(task: Task, assigneeName: string): string {
  return [
    `${REVIEW_MARKER} ${task.title}]`,
    `${assigneeName} finished this task and asks you to review it before it counts as done.`,
    "",
    "Task:",
    task.description || "(no further description)",
    task.acceptance ? `\nDone means: ${task.acceptance}` : "",
    "",
    "Submitted work:",
    "<submission>",
    task.output,
    "</submission>",
    "",
    "Judge the submission against the task and its done-criteria, not against your own taste.",
    "Answer on the FIRST line with exactly one of:",
    "APPROVE",
    "CHANGES: <what must change, concretely>",
    "You may add a short justification on the following lines.",
  ].join("\n");
}

/** Reads a review answer. Anything unclear goes to 대표 instead of being guessed. */
export function parseVerdict(text: string): { verdict: "approved" | "changes" | "unclear"; comment: string } {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/[*_`]/g, "").replace(/^[\s>#-]+/, "").trim())
    .filter(Boolean);
  const first = lines[0] ?? "";
  const rest = lines.slice(1).join("\n").trim();
  if (/^APPROVE[DS]?\b/i.test(first)) return { verdict: "approved", comment: first.replace(/^APPROVE[DS]?\s*[:：-]?\s*/i, "") || rest };
  const changes = first.match(/^(?:CHANGES|REQUEST[_ ]CHANGES|REJECT)\b\s*[:：-]?\s*(.*)$/i);
  if (changes) return { verdict: "changes", comment: [changes[1], rest].filter(Boolean).join("\n") };
  return { verdict: "unclear", comment: text.trim().slice(0, 500) };
}

export const CHAT_MARKER = "💬 [1:1 chat";

export function chatPrompt(
  history: { from: "user" | "agent"; content: string; authorName?: string }[],
  message: string,
  agentName: string,
  authorName?: string,
): string {
  const past = history
    .slice(-20)
    .map((m) => `[${m.from === "user" ? (m.authorName ?? USER_DISPLAY_NAME) : agentName}] ${m.content}`)
    .join("\n\n");
  const who = authorName ?? USER_DISPLAY_NAME;
  return [
    `${CHAT_MARKER} with ${who}]`,
    authorName
      ? `${authorName} is a human teammate at the company (${USER_DISPLAY_NAME} runs it) and is talking to you directly.`
      : `${USER_DISPLAY_NAME} runs the company and is talking to you directly.`,
    past ? `Conversation so far:\n---\n${past}\n---` : "",
    `${who}: ${message}`,
    "",
    "Reply as yourself, conversationally and concisely. If this is a request for real work, sketch the deliverable",
    "and its done-criteria briefly; 대표 can register it as a task from this chat. Do not claim a task was created.",
  ]
    .filter(Boolean)
    .join("\n");
}

export const SECRETARY_SYSTEM = [
  "You are the meeting secretary. You write accurate, concise minutes from a transcript.",
  "Only record decisions and action items that participants actually agreed on or volunteered for.",
  "Each action item must be a self-contained task someone can execute without reading the transcript,",
  "with concrete completion criteria. List an item after the items it depends on and reference them in `after`.",
  LANGUAGE_RULE,
].join("\n");

export function minutesPrompt(meeting: Meeting, state: CompanyState): string {
  const people = meeting.participantIds
    .map((id) => state.agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);
  const transcript = meeting.transcript
    .filter((e): e is SpeechEntry => e.kind === "speech" && !!e.content.trim())
    .map((e) => `${entrySpeaker(e, state)}: ${e.content}`)
    .join("\n\n");
  return [
    `Meeting topic: ${meeting.topic}`,
    meeting.agenda ? `Agenda: ${meeting.agenda}` : "",
    "",
    "Participants (use these ids for assigneeId, or an empty string if nobody owns it):",
    ...people.map((p) => `- id=${p.id} name=${p.name} role=${p.role}`),
    `(${USER_DISPLAY_NAME} is the human running the company; never assign items to them.)`,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

export function minutesSchema(participantIds: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "decisions", "actionItems"],
    properties: {
      summary: { type: "string", description: "3-5 sentence summary of the discussion" },
      decisions: { type: "array", items: { type: "string" } },
      actionItems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "acceptance", "assigneeId", "after"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            acceptance: { type: "string", description: "Concrete completion criteria" },
            assigneeId: { type: "string", enum: [...participantIds, ""] },
            after: {
              type: "array",
              items: { type: "integer" },
              description: "0-based indexes of EARLIER action items that must be finished before this one can start",
            },
          },
        },
      },
    },
  };
}

export const RECRUITER_SYSTEM = [
  "You are a recruiter for a company staffed by AI agents.",
  "Given a job description, invent one strong, specific candidate profile.",
  "Write the persona as a description of the candidate: their background, working style,",
  "how they communicate and what they push back on. 3-6 sentences.",
  "Give the candidate a realistic name that fits the language of the job description.",
  LANGUAGE_RULE,
].join("\n");

export function recruitPrompt(jobDescription: string, state: CompanyState): string {
  const team = state.agents.map((a) => `- ${a.name} (${a.role})`).join("\n");
  return [
    `Company: ${state.name}`,
    state.mission ? `Mission: ${state.mission}` : "",
    team ? `Current team:\n${team}` : "The team is empty.",
    "",
    "Job description:",
    jobDescription,
  ].join("\n");
}

export const CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "role", "persona", "skills"],
  properties: {
    name: { type: "string" },
    role: { type: "string", description: "Short job title" },
    persona: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
  },
};
