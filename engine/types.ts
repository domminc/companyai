export type AgentStatus = "idle" | "working" | "in_meeting";

/**
 * Where an agent's thinking runs.
 * - `claude`: this app calls the Claude API directly; `persona` is the agent's identity.
 * - `hermes`: the agent is a Hermes Agent profile on a registered gateway. Identity comes from
 *   the profile's own SOUL.md, and the agent has whatever tools, skills and memory the profile has.
 */
/** Anthropic server tools a Claude employee may use: web search + fetch, and a code sandbox. */
export type AgentTool = "web" | "code";

export const AGENT_TOOLS: AgentTool[] = ["web", "code"];

export interface ExternalWork {
  kind: "kanban" | "cron";
  title: string;
  /** Kanban board slug. */
  board?: string;
}

export type AgentRuntime =
  | { kind: "claude"; model: string; tools?: AgentTool[] }
  | { kind: "hermes"; gatewayId: string; profile: string; profileKey?: string; hasProfileKey?: boolean };

export interface Agent {
  id: string;
  name: string;
  role: string;
  /** Personality, working style and expertise. Claude agents use it as their identity. */
  persona: string;
  skills: string[];
  runtime: AgentRuntime;
  status: AgentStatus;
  /** Work a Hermes employee is doing on the gateway itself (a kanban card, a cron job). */
  external?: ExternalWork;
  hiredAt: string;
  stats: { tasksDone: number; meetingsAttended: number };
}

export interface HermesGateway {
  id: string;
  name: string;
  /** Base URL of the Hermes API Server, e.g. http://localhost:8642 */
  url: string;
  /** Redacted to `hasApiKey` in everything that leaves the server. */
  apiKey?: string;
  hasApiKey?: boolean;
  createdAt: string;
}

export type TaskStatus = "todo" | "in_progress" | "review" | "done" | "failed";

/**
 * Who signs off a finished task: nobody, 대표 (the human), or another AI employee.
 * With a reviewer, finished work goes to `review` instead of `done`.
 */
export type ReviewMode = "none" | "human" | "agent";

export interface TaskReview {
  mode: ReviewMode;
  /** For mode "agent": the colleague who reviews. */
  reviewerId?: string;
}

export interface ReviewRecord {
  /** USER_SPEAKER or the reviewing agent's id. */
  by: string;
  verdict: "approved" | "changes";
  comment: string;
  /** The revision that was reviewed (0 = first attempt). */
  revision: number;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assigneeId: string | null;
  status: TaskStatus;
  output: string;
  error?: string;
  /** Tool the agent is using right now (Hermes agents). */
  activeTool?: string;
  /** Meeting that produced this task as an action item, if any. */
  sourceMeetingId?: string;
  /** What "done" means; reviewers check against it. */
  acceptance?: string;
  /** Tasks that must be done before this one starts. */
  dependsOn: string[];
  review: TaskReview;
  /** How many times the work was sent back for changes. */
  revision: number;
  reviews: ReviewRecord[];
  /** The rejected output the agent is revising. */
  previousOutput?: string;
  /** An AI reviewer is looking at it right now. */
  reviewing?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MeetingStatus = "scheduled" | "running" | "done" | "failed";

/** What a running meeting is doing right now. */
export type MeetingPhase = "polling" | "speaking" | "summarizing";

export type MeetingEndReason = "all_passed" | "turn_limit" | "no_candidates" | "ended_by_user";

/** The human running the company, as a meeting speaker. */
export const USER_SPEAKER = "user";

/** How a speaker got the floor. */
export type FloorVia = "opening" | "hand" | "mention" | "user_grant" | "user";

export interface SpeechEntry {
  kind: "speech";
  id: string;
  /** Agent id, or USER_SPEAKER. */
  speakerId: string;
  content: string;
  via: FloorVia;
  /** The one-line reason given when raising a hand. */
  reason?: string;
  at: string;
  /** Set once the speaker has finished this turn. */
  endedAt?: string;
  /** A signed-in teammate other than 대표 who spoke (speakerId is still USER_SPEAKER). */
  authorName?: string;
}

export interface PollEntry {
  kind: "poll";
  id: string;
  at: string;
  raises: { agentId: string; reason: string }[];
  passes: string[];
  /** Participants the poll could not reach. Distinct from passing. */
  failures: { agentId: string; reason: string }[];
}

export interface NoticeEntry {
  kind: "notice";
  id: string;
  at: string;
  text: string;
}

export type MeetingEntry = SpeechEntry | PollEntry | NoticeEntry;

export interface ActionItem {
  title: string;
  description: string;
  /** Completion criteria. */
  acceptance: string;
  assigneeId: string | null;
  /** Indexes of earlier items that must finish first. */
  after: number[];
  /** Kept when the draft is registered (the human can drop items). */
  include: boolean;
  taskId?: string;
}

/** Meeting results: none yet, a draft awaiting review, or registered as tasks. */
export type MeetingOutcome = "none" | "draft" | "registered";

export interface Meeting {
  id: string;
  topic: string;
  agenda: string;
  /** The first participant chairs: they open the meeting. */
  participantIds: string[];
  /** Speaking turns each agent may take. */
  maxTurnsPerAgent: number;
  /** Hard cap on agent turns for the whole meeting. */
  maxTotalTurns: number;
  status: MeetingStatus;
  phase?: MeetingPhase;
  /** Agent currently holding the floor (phase === "speaking"). */
  currentSpeakerId?: string;
  transcript: MeetingEntry[];
  /** Agents waiting for the floor because they were @mentioned or the user granted it. */
  floorQueue: { agentId: string; by: "user" | "mention" }[];
  endRequested?: boolean;
  endReason?: MeetingEndReason;
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
  /** Turn action items into tasks as soon as the meeting ends (otherwise they wait as a draft). */
  autoCreateTasks: boolean;
  outcome: MeetingOutcome;
  /** 대표 is in the room (joined, or spoke). */
  userJoined?: boolean;
  error?: string;
  createdAt: string;
  endedAt?: string;
}

export interface ActivityEntry {
  id: string;
  at: string;
  level: "info" | "error";
  message: string;
  /** The signed-in person whose action this was (only when login is on). */
  by?: string;
}

export interface ChatMessage {
  id: string;
  from: "user" | "agent";
  content: string;
  /** For "user" messages from a signed-in teammate other than 대표. */
  authorName?: string;
  at: string;
  /** Set once an agent reply has finished streaming. */
  endedAt?: string;
  error?: boolean;
}

/** A 1:1 conversation between 대표 and one employee. */
export interface ChatThread {
  agentId: string;
  messages: ChatMessage[];
  replying: boolean;
  /** Server tool the agent is using while replying. */
  activeTool?: string;
}

export interface CompanyState {
  name: string;
  mission: string;
  defaultModel: string;
  gateways: HermesGateway[];
  agents: Agent[];
  tasks: Task[];
  meetings: Meeting[];
  chats: ChatThread[];
  activity: ActivityEntry[];
}

export type CompanyEvent =
  | { type: "state"; state: CompanyState }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.fired"; agentId: string }
  | { type: "gateways.updated"; gateways: HermesGateway[] }
  | { type: "task.updated"; task: Task }
  | { type: "task.delta"; taskId: string; text: string }
  | { type: "task.deleted"; taskId: string }
  | { type: "meeting.updated"; meeting: Meeting }
  | { type: "meeting.delta"; meetingId: string; entryId: string; text: string }
  | { type: "chat.updated"; thread: ChatThread }
  | { type: "chat.delta"; agentId: string; messageId: string; text: string }
  | { type: "chat.cleared"; agentId: string }
  | { type: "company.updated"; name: string; mission: string; defaultModel: string }
  | { type: "activity"; entry: ActivityEntry };

export interface HireInput {
  name: string;
  role: string;
  persona?: string;
  skills?: string[];
  /** Claude agents: model id. Defaults to the company default. */
  model?: string;
  /** Claude agents: server tools they may use. */
  tools?: AgentTool[];
  /** Hermes agents: gateway + profile ("default" is the gateway's own profile). */
  hermes?: { gatewayId: string; profile?: string; profileKey?: string };
}

export interface CandidateProfile {
  name: string;
  role: string;
  persona: string;
  skills: string[];
}
