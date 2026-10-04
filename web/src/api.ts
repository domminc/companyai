import type {
  Agent,
  AgentTool,
  CandidateProfile,
  ChatMessage,
  ChatThread,
  CompanyState,
  HermesGateway,
  HireInput,
  Meeting,
  MeetingEntry,
  Task,
  TaskReview,
} from "../../engine/types";
import type { ActionItemEdit } from "../../engine/company";
import type { Role, User } from "../../server/auth";
import type { AutostartStatus } from "../../server/autostart";
import type {
  HermesJob,
  HermesJobRun,
  JobInput,
  JobsSource,
  KanbanAction,
  KanbanBoard,
  KanbanBoardMeta,
  KanbanCard,
  KanbanCardDetail,
} from "../../engine/hermes-ops";

export type { Role, User };

/** Someone with the app open right now (only reported while login is on). */
export interface OnlineUser {
  id: string;
  displayName: string;
  role: Role;
}

export interface ClaudeStatus {
  provider: string;
  /** .env, entered in the app, or none (demo mode). */
  source: "env" | "app" | "none";
  keyHint?: string;
}

export type { AutostartStatus };

export interface LocalHermes {
  found: boolean;
  url?: string;
  reachable: boolean;
  plugin: boolean;
  /** Already registered as a gateway. */
  connected: boolean;
}

export interface AuthInfo {
  enabled: boolean;
  user: User | null;
}

/** Fired when the server says the session is gone, so the app can show the login screen. */
export const LOGGED_OUT_EVENT = "companyai:logged-out";

export type { HermesJob, HermesJobRun, JobInput, KanbanAction, KanbanBoard, KanbanBoardMeta, KanbanCard, KanbanCardDetail };

export type { ActionItemEdit, Agent, AgentTool, CandidateProfile, ChatMessage, ChatThread, CompanyState, HermesGateway, Meeting, MeetingEntry, Task, TaskReview };
export { USER_SPEAKER } from "../../engine/types";

export interface ModelOption {
  id: string;
  label: string;
}

export interface Bootstrap {
  state: CompanyState;
  provider: string;
  models: ModelOption[];
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) window.dispatchEvent(new Event(LOGGED_OUT_EVENT));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export const api = {
  me: () => request<AuthInfo>("GET", "/auth/me"),
  setupLogin: (input: { username: string; password: string; displayName: string }) => request<AuthInfo>("POST", "/auth/setup", input),
  login: (username: string, password: string) => request<AuthInfo>("POST", "/auth/login", { username, password }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout", {}),
  disableLogin: (password: string) => request<AuthInfo>("POST", "/auth/disable", { password }),
  updateMe: (patch: { displayName?: string; password?: string }) => request<User>("PATCH", "/auth/me", patch),
  users: () => request<User[]>("GET", "/users"),
  createUser: (input: { username: string; password: string; displayName: string; role: Role }) => request<User>("POST", "/users", input),
  updateUser: (id: string, patch: { displayName?: string; password?: string; role?: Role }) => request<User>("PATCH", `/users/${id}`, patch),
  deleteUser: (id: string) => request<{ ok: true }>("DELETE", `/users/${id}`),

  claudeStatus: () => request<ClaudeStatus>("GET", "/settings/claude"),
  setClaudeKey: (apiKey: string) => request<ClaudeStatus>("PUT", "/settings/claude", { apiKey }),
  removeClaudeKey: () => request<ClaudeStatus>("DELETE", "/settings/claude"),

  localHermes: () => request<LocalHermes>("GET", "/hermes/local"),
  connectLocalHermes: () => request<HermesGateway>("POST", "/hermes/local/connect"),

  autostart: () => request<AutostartStatus>("GET", "/settings/autostart"),
  setAutostart: (enabled: boolean) => request<AutostartStatus>("PUT", "/settings/autostart", { enabled }),

  bootstrap: () => request<Bootstrap>("GET", "/state"),
  updateCompany: (patch: { name?: string; mission?: string; defaultModel?: string }) =>
    request<CompanyState>("PATCH", "/company", patch),

  addGateway: (input: { name?: string; url: string; apiKey?: string }) => request<HermesGateway>("POST", "/gateways", input),
  testGateway: (id: string) => request<{ ok: true }>("POST", `/gateways/${id}/test`),
  removeGateway: (id: string) => request<{ ok: true }>("DELETE", `/gateways/${id}`),

  recruit: (jobDescription: string) => request<CandidateProfile>("POST", "/recruit", { jobDescription }),
  hire: (input: HireInput) => request<Agent>("POST", "/agents", input),
  updateAgent: (
    id: string,
    patch: Partial<Omit<HireInput, "hermes">> & { hermes?: { profile?: string; profileKey?: string } },
  ) => request<Agent>("PATCH", `/agents/${id}`, patch),
  fire: (id: string) => request<{ ok: true }>("DELETE", `/agents/${id}`),

  createTask: (input: {
    title: string;
    description?: string;
    assigneeId?: string | null;
    acceptance?: string;
    review?: TaskReview;
    dependsOn?: string[];
  }) => request<Task>("POST", "/tasks", input),
  updateTask: (
    id: string,
    patch: { title?: string; description?: string; assigneeId?: string | null; acceptance?: string; review?: TaskReview },
  ) => request<Task>("PATCH", `/tasks/${id}`, patch),
  reviewTask: (id: string, approve: boolean, comment?: string) => request<Task>("POST", `/tasks/${id}/review`, { approve, comment }),

  chat: (agentId: string, content: string) => request<ChatThread>("POST", `/chats/${agentId}`, { content }),
  clearChat: (agentId: string) => request<{ ok: true }>("DELETE", `/chats/${agentId}`),
  retryTask: (id: string) => request<Task>("POST", `/tasks/${id}/retry`),
  deleteTask: (id: string) => request<{ ok: true }>("DELETE", `/tasks/${id}`),

  startMeeting: (input: { topic: string; agenda?: string; participantIds: string[]; maxTurnsPerAgent?: number; createTasks?: boolean }) =>
    request<Meeting>("POST", "/meetings", input),
  sayInMeeting: (id: string, content: string) => request<Meeting>("POST", `/meetings/${id}/messages`, { content }),
  grantFloor: (id: string, agentId: string) => request<Meeting>("POST", `/meetings/${id}/grant`, { agentId }),
  endMeeting: (id: string) => request<Meeting>("POST", `/meetings/${id}/end`),
  joinMeeting: (id: string, joined: boolean) => request<Meeting>("POST", `/meetings/${id}/join`, { joined }),
  registerOutcome: (id: string, input: { items?: (ActionItemEdit | null)[]; review?: TaskReview }) =>
    request<Task[]>("POST", `/meetings/${id}/outcome`, input),
  cancelMeeting: (id: string) => request<Meeting>("POST", `/meetings/${id}/cancel`),
  promoteActionItem: (id: string, index: number) => request<Task>("POST", `/meetings/${id}/action-items/${index}/promote`),

  automations: (agentId: string) => request<{ source: JobsSource; jobs: HermesJob[] }>("GET", `/agents/${agentId}/automations`),
  createAutomation: (agentId: string, input: JobInput) => request<HermesJob>("POST", `/agents/${agentId}/automations`, input),
  updateAutomation: (agentId: string, jobId: string, patch: Partial<JobInput>) =>
    request<HermesJob>("PATCH", `/agents/${agentId}/automations/${enc(jobId)}`, patch),
  automationAction: (agentId: string, jobId: string, action: "pause" | "resume" | "run") =>
    request<{ ok: true }>("POST", `/agents/${agentId}/automations/${enc(jobId)}/${action}`),
  deleteAutomation: (agentId: string, jobId: string) => request<{ ok: true }>("DELETE", `/agents/${agentId}/automations/${enc(jobId)}`),
  automationRuns: (agentId: string, jobId: string) => request<HermesJobRun[]>("GET", `/agents/${agentId}/automations/${enc(jobId)}/runs`),

  kanban: (gatewayId: string) =>
    request<{ plugin: boolean; version?: string; boards: KanbanBoardMeta[]; current?: string }>("GET", `/gateways/${gatewayId}/kanban`),
  createKanbanBoard: (gatewayId: string, slug: string, name: string) =>
    request<{ ok: true }>("POST", `/gateways/${gatewayId}/kanban/boards`, { slug, name }),
  kanbanBoard: (gatewayId: string, board: string) => request<KanbanBoard>("GET", `/gateways/${gatewayId}/kanban/boards/${enc(board)}`),
  createKanbanCard: (
    gatewayId: string,
    board: string,
    input: { title: string; body?: string; assigneeId?: string; assignee?: string; priority?: number; triage?: boolean },
  ) => request<KanbanCard>("POST", `/gateways/${gatewayId}/kanban/boards/${enc(board)}/cards`, input),
  kanbanCard: (gatewayId: string, board: string, cardId: string) =>
    request<KanbanCardDetail>("GET", `/gateways/${gatewayId}/kanban/boards/${enc(board)}/cards/${enc(cardId)}`),
  deleteKanbanCard: (gatewayId: string, board: string, cardId: string) =>
    request<{ ok: true }>("DELETE", `/gateways/${gatewayId}/kanban/boards/${enc(board)}/cards/${enc(cardId)}`),
  commentKanbanCard: (gatewayId: string, board: string, cardId: string, body: string) =>
    request<{ ok: true }>("POST", `/gateways/${gatewayId}/kanban/boards/${enc(board)}/cards/${enc(cardId)}/comments`, { body }),
  kanbanAction: (gatewayId: string, board: string, cardId: string, action: KanbanAction, body: Record<string, unknown> = {}) =>
    request<unknown>("POST", `/gateways/${gatewayId}/kanban/boards/${enc(board)}/cards/${enc(cardId)}/actions/${action}`, body),
};

function enc(segment: string) {
  return encodeURIComponent(segment);
}
