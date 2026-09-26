import type { Agent, CompanyState, Meeting, Task } from "./types";

const LANGUAGE_RULE = "Reply in the same language the request is written in.";

export function agentSystemPrompt(agent: Agent, state: CompanyState): string {
  const colleagues = state.agents
    .filter((a) => a.id !== agent.id)
    .map((a) => `- ${a.name} (${a.role})`)
    .join("\n");
  return [
    `You are ${agent.name}, working as ${agent.role} at ${state.name}.`,
    state.mission ? `Company mission: ${state.mission}` : "",
    "",
    "About you:",
    agent.persona,
    agent.skills.length ? `Your strengths: ${agent.skills.join(", ")}.` : "",
    "",
    colleagues ? `Your colleagues:\n${colleagues}` : "You are currently the only member of the company.",
    "",
    "You work entirely in text: you cannot browse, run code or contact anyone outside this conversation.",
    "When information is missing, state your assumptions briefly and proceed instead of asking questions.",
    LANGUAGE_RULE,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
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

export function meetingTurnPrompt(meeting: Meeting, state: CompanyState, speaker: Agent, round: number): string {
  const nameOf = (id: string) => state.agents.find((a) => a.id === id)?.name ?? "(former member)";
  const participants = meeting.participantIds
    .map((id) => state.agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a)
    .map((a) => `- ${a.name} (${a.role})${a.id === speaker.id ? " <- you" : ""}`)
    .join("\n");
  const transcript = meeting.transcript
    .filter((u) => u.content)
    .map((u) => `[Round ${u.round}] ${nameOf(u.agentId)}: ${u.content}`)
    .join("\n\n");
  const isLast = round === meeting.rounds;
  return [
    `You are in a meeting. Topic: ${meeting.topic}`,
    meeting.agenda ? `Agenda:\n${meeting.agenda}` : "",
    "",
    `Participants:\n${participants}`,
    "",
    transcript ? `Transcript so far:\n${transcript}` : "You are the first to speak.",
    "",
    `It is your turn in round ${round} of ${meeting.rounds}.`,
    isLast
      ? "This is the final round: help the group converge. State what you will personally take on."
      : "Contribute from your role's perspective. Build on or challenge what others said; be concrete.",
    "Speak as you would in a real meeting: 2-5 sentences, no headings, and do not prefix your name.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
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
    .map((u) => `${people.find((p) => p.id === u.agentId)?.name ?? "?"}: ${u.content}`)
    .join("\n\n");
  return [
    `Meeting topic: ${meeting.topic}`,
    meeting.agenda ? `Agenda: ${meeting.agenda}` : "",
    "",
    "Participants (use these ids for assigneeId, or an empty string if nobody owns it):",
    ...people.map((p) => `- id=${p.id} name=${p.name} role=${p.role}`),
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
