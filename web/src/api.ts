import type { Agent, CandidateProfile, CompanyState, HireInput, Meeting, Task } from "../../engine/types";

export type { Agent, CandidateProfile, CompanyState, Meeting, Task };

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

  recruit: (jobDescription: string) => request<CandidateProfile>("POST", "/recruit", { jobDescription }),
  hire: (input: HireInput) => request<Agent>("POST", "/agents", input),
  updateAgent: (id: string, patch: Partial<HireInput>) => request<Agent>("PATCH", `/agents/${id}`, patch),
  fire: (id: string) => request<{ ok: true }>("DELETE", `/agents/${id}`),

  createTask: (input: { title: string; description?: string; assigneeId?: string | null }) =>
    request<Task>("POST", "/tasks", input),
  updateTask: (id: string, patch: { title?: string; description?: string; assigneeId?: string | null }) =>
    request<Task>("PATCH", `/tasks/${id}`, patch),
  retryTask: (id: string) => request<Task>("POST", `/tasks/${id}/retry`),
  deleteTask: (id: string) => request<{ ok: true }>("DELETE", `/tasks/${id}`),

  startMeeting: (input: { topic: string; agenda?: string; participantIds: string[]; rounds?: number; createTasks?: boolean }) =>
    request<Meeting>("POST", "/meetings", input),
  cancelMeeting: (id: string) => request<Meeting>("POST", `/meetings/${id}/cancel`),
  promoteActionItem: (id: string, index: number) => request<Task>("POST", `/meetings/${id}/action-items/${index}/promote`),
};
