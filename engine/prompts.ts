import { speakerName, USER_DISPLAY_NAME } from "./meeting";
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

export function taskPrompt(task: Task, sourceMeeting?: Meeting): string {
  const parts = [`You have been assigned a task.`, "", `# ${task.title}`, "", task.description || "(no further description)"];
  if (sourceMeeting) {
    parts.push(
      "",
      `This task came out of the meeting "${sourceMeeting.topic}".`,
      `Meeting summary: ${sourceMeeting.summary}`,
      sourceMeeting.decisions.length ? `Decisions:\n${sourceMeeting.decisions.map((d) => `- ${d}`).join("\n")}` : "",
    );
  }
  parts.push(
    "",
    "Produce the finished deliverable itself in Markdown - not a plan to produce it.",
    "End with a short 'Next steps' list if follow-up work is needed.",
  );
  return parts.join("\n");
}

export const SECRETARY_SYSTEM = [
  "You are the meeting secretary. You write accurate, concise minutes from a transcript.",
  "Only record decisions and action items that participants actually agreed on or volunteered for.",
  "Each action item must be a self-contained task someone can execute without reading the transcript.",
  LANGUAGE_RULE,
].join("\n");

export function minutesPrompt(meeting: Meeting, state: CompanyState): string {
  const people = meeting.participantIds
    .map((id) => state.agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);
  const transcript = meeting.transcript
    .filter((e): e is SpeechEntry => e.kind === "speech" && !!e.content.trim())
    .map((e) => `${speakerName(e.speakerId, state)}: ${e.content}`)
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
          required: ["title", "description", "assigneeId"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            assigneeId: { type: "string", enum: [...participantIds, ""] },
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
