export type AgentStatus = "idle" | "working" | "in_meeting";

export interface Agent {
  id: string;
  name: string;
  role: string;
  /** Personality, working style and expertise; becomes the agent's system prompt. */
  persona: string;
  skills: string[];
  model: string;
  status: AgentStatus;
  hiredAt: string;
  stats: { tasksDone: number; meetingsAttended: number };
}

export type TaskStatus = "todo" | "in_progress" | "done" | "failed";

export interface Task {
  id: string;
  title: string;
  description: string;
  assigneeId: string | null;
  status: TaskStatus;
  output: string;
  error?: string;
  /** Meeting that produced this task as an action item, if any. */
  sourceMeetingId?: string;
  createdAt: string;
  updatedAt: string;
}

export type MeetingStatus = "scheduled" | "running" | "done" | "failed";

export interface Utterance {
  id: string;
  agentId: string;
  round: number;
  content: string;
  at: string;
  /** Set once the speaker has finished this turn. */
  endedAt?: string;
}

export interface ActionItem {
  title: string;
  description: string;
  assigneeId: string | null;
  taskId?: string;
}

export interface Meeting {
  id: string;
  topic: string;
  agenda: string;
  participantIds: string[];
  rounds: number;
  status: MeetingStatus;
  transcript: Utterance[];
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
  /** Turn action items into tasks as soon as the meeting ends. */
  autoCreateTasks: boolean;
  error?: string;
  createdAt: string;
  endedAt?: string;
}

export interface ActivityEntry {
  id: string;
  at: string;
  level: "info" | "error";
  message: string;
}

export interface CompanyState {
  name: string;
  mission: string;
  defaultModel: string;
  agents: Agent[];
  tasks: Task[];
  meetings: Meeting[];
  activity: ActivityEntry[];
}

export type CompanyEvent =
  | { type: "state"; state: CompanyState }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.fired"; agentId: string }
  | { type: "task.updated"; task: Task }
  | { type: "task.delta"; taskId: string; text: string }
  | { type: "task.deleted"; taskId: string }
  | { type: "meeting.updated"; meeting: Meeting }
  | { type: "meeting.delta"; meetingId: string; utteranceId: string; agentId: string; round: number; text: string }
  | { type: "company.updated"; name: string; mission: string; defaultModel: string }
  | { type: "activity"; entry: ActivityEntry };

export interface HireInput {
  name: string;
  role: string;
  persona?: string;
  skills?: string[];
  model?: string;
}

export interface CandidateProfile {
  name: string;
  role: string;
  persona: string;
  skills: string[];
}
