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
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export const api = {
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
};
