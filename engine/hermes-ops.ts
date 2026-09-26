/**
 * Hermes automations (cron jobs) and the Hermes kanban board, through the DeskRPG plugin API
 * (https://github.com/dandacompany/deskrpg-hermes-plugin).
 *
 * - Cron is profile-scoped: `/p/<profile>/deskrpg/cron/jobs`, authenticated with the profile's
 *   key. Without the plugin, Hermes' own `/api/jobs` does the same minus run history.
 * - Kanban is owner-scoped: `/deskrpg/kanban/*` with the gateway (owner) key, and every call
 *   names its board with `?board=<slug>`. Cards are assigned to profiles, which is how a card
 *   lands on one of our Hermes employees.
 */
import { HermesClient, HermesError } from "./hermes";

export interface HermesJob {
  id: string;
  name: string;
  prompt: string;
  /** Human-readable schedule ("every 1h", "0 9 * * *"). */
  schedule: string;
  enabled: boolean;
  /** "scheduled" | "paused" | "running" | "completed" ... as Hermes reports it. */
  state: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  repeat?: { times: number | null; completed: number };
}

export interface HermesJobRun {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  summary: string;
  resultText: string;
}

export type JobsSource = "plugin" | "core";

export interface JobInput {
  name: string;
  schedule: string;
  prompt: string;
}

type RawJob = Record<string, unknown> & { schedule?: unknown; repeat?: unknown };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function normalizeJob(raw: RawJob): HermesJob {
  const schedule =
    str(raw.schedule_display) ??
    (raw.schedule && typeof raw.schedule === "object" ? str((raw.schedule as Record<string, unknown>).display) : str(raw.schedule)) ??
    "";
  const repeat = raw.repeat && typeof raw.repeat === "object" ? (raw.repeat as { times?: number | null; completed?: number }) : undefined;
  return {
    id: String(raw.id),
    name: str(raw.name) ?? String(raw.id),
    prompt: str(raw.prompt) ?? "",
    schedule,
    enabled: raw.enabled !== false,
    state: str(raw.state) ?? (raw.enabled === false ? "paused" : "scheduled"),
    nextRunAt: str(raw.next_run_at),
    lastRunAt: str(raw.last_run_at),
    lastStatus: str(raw.last_status),
    lastError: str(raw.last_error),
    ...(repeat ? { repeat: { times: repeat.times ?? null, completed: repeat.completed ?? 0 } } : {}),
  };
}

const seg = encodeURIComponent;

/** One Hermes profile's cron jobs. */
export class HermesJobs {
  constructor(
    private client: HermesClient,
    private profile: string,
    public source?: JobsSource,
  ) {}

  private get pluginRoot() {
    return `/p/${seg(this.profile || "default")}/deskrpg/cron/jobs`;
  }

  private path(suffix = "") {
    return this.source === "plugin" ? `${this.pluginRoot}${suffix}` : `/api/jobs${suffix}`;
  }

  private call<T>(method: string, suffix = "", body?: unknown) {
    // Plugin paths carry their own /p/<profile>; core paths get the client's prefix.
    return this.client.json<T>(method, this.path(suffix), body, { prefixed: this.source !== "plugin" });
  }

  /** Plugin if its routes answer, else Hermes' core jobs API. */
  async detect(): Promise<JobsSource> {
    if (this.source) return this.source;
    try {
      await this.client.json("GET", this.pluginRoot, undefined, { prefixed: false });
      this.source = "plugin";
    } catch (err) {
      if (!(err instanceof HermesError && err.status === 404)) throw err;
      this.source = "core";
    }
    return this.source;
  }

  async list(): Promise<HermesJob[]> {
    await this.detect();
    const res = await this.call<{ jobs?: RawJob[] }>("GET", "?include_disabled=true");
    return (res.jobs ?? []).map(normalizeJob);
  }

  async create(input: JobInput): Promise<HermesJob> {
    await this.detect();
    const res = await this.call<{ job: RawJob }>("POST", "", { name: input.name, schedule: input.schedule, prompt: input.prompt });
    return normalizeJob(res.job);
  }

  async update(jobId: string, patch: Partial<JobInput>): Promise<HermesJob> {
    await this.detect();
    const res =
      this.source === "plugin"
        ? await this.call<{ job: RawJob }>("PUT", `/${seg(jobId)}`, { updates: patch })
        : await this.call<{ job: RawJob }>("PATCH", `/${seg(jobId)}`, patch);
    return normalizeJob(res.job);
  }

  async act(jobId: string, action: "pause" | "resume" | "run"): Promise<void> {
    await this.detect();
    await this.call("POST", `/${seg(jobId)}/${action}`, {});
  }

  async remove(jobId: string): Promise<void> {
    await this.detect();
    await this.call("DELETE", `/${seg(jobId)}`);
  }

  /** Recent runs with their results; only the plugin keeps these. */
  async runs(jobId: string, limit = 10): Promise<HermesJobRun[]> {
    if ((await this.detect()) !== "plugin") return [];
    const res = await this.call<{ runs?: Record<string, unknown>[] }>("GET", `/${seg(jobId)}/runs?limit=${limit}`);
    return (res.runs ?? []).map((r) => ({
      id: String(r.id),
      startedAt: str(r.started_at),
      endedAt: str(r.ended_at),
      status: str(r.status) ?? "unknown",
      summary: str(r.summary) ?? "",
      resultText: str(r.result_text) ?? "",
    }));
  }
}

// ---------------------------------------------------------------------------------------------
// Kanban

/** DeskRPG's column order. */
export const KANBAN_COLUMNS = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"] as const;

export const KANBAN_ACTIONS = [
  "reassign",
  "reclaim",
  "specify",
  "decompose",
  "estimate",
  "approve",
  "request-changes",
  "unblock",
  "terminate",
  "archive",
] as const;
export type KanbanAction = (typeof KANBAN_ACTIONS)[number];

export interface KanbanBoardMeta {
  slug: string;
  name?: string;
  description?: string;
  is_current?: boolean;
  total?: number;
  archived?: boolean;
}

export interface KanbanCard {
  id: string;
  title: string;
  status: string;
  body?: string | null;
  assignee?: string | null;
  priority?: number | null;
  created_at?: number | string | null;
  latest_summary?: string | null;
  [key: string]: unknown;
}

export interface KanbanBoard {
  columns: { name: string; tasks: KanbanCard[] }[];
  assignees?: string[];
}

export interface KanbanCardDetail {
  task: KanbanCard & { result?: string | null };
  comments: { id: string | number; author: string; body: string; created_at: number | string }[];
  events: { id: string | number; kind: string; payload: unknown; created_at: number | string }[];
  runs: { id: string | number; profile?: string; status?: string; outcome?: string; summary?: string | null; started_at?: number | string; ended_at?: number | string | null }[];
  links?: { parents: string[]; children: string[] };
}

export interface KanbanCardInput {
  title: string;
  body?: string;
  assignee?: string;
  priority?: number;
  triage?: boolean;
}

/** The gateway's kanban, through the owner key. */
export class HermesKanban {
  constructor(private client: HermesClient) {}

  private call<T>(method: string, path: string, body?: unknown) {
    return this.client.json<T>(method, path, body, { prefixed: false });
  }

  /** Plugin metadata, or null when the plugin isn't installed on this gateway. */
  async info(): Promise<Record<string, unknown> | null> {
    try {
      return await this.call<Record<string, unknown>>("GET", "/deskrpg/info");
    } catch (err) {
      if (err instanceof HermesError && err.status === 404) return null;
      throw err;
    }
  }

  boards(): Promise<{ boards: KanbanBoardMeta[]; current?: string }> {
    return this.call("GET", "/deskrpg/kanban/boards");
  }

  createBoard(slug: string, name: string): Promise<unknown> {
    return this.call("POST", "/deskrpg/kanban/boards", { slug, name });
  }

  board(slug: string): Promise<KanbanBoard> {
    return this.call("GET", `/deskrpg/kanban/board?board=${seg(slug)}`);
  }

  async createCard(slug: string, input: KanbanCardInput): Promise<KanbanCard> {
    const body: Record<string, unknown> = { title: input.title };
    if (input.body) body.body = input.body;
    if (input.assignee) body.assignee = input.assignee;
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.triage) body.triage = true;
    const res = await this.call<{ task: KanbanCard }>("POST", `/deskrpg/kanban/tasks?board=${seg(slug)}`, body);
    return res.task;
  }

  card(slug: string, id: string): Promise<KanbanCardDetail> {
    return this.call("GET", `/deskrpg/kanban/tasks/${seg(id)}?board=${seg(slug)}`);
  }

  comment(slug: string, id: string, text: string, author: string): Promise<unknown> {
    return this.call("POST", `/deskrpg/kanban/tasks/${seg(id)}/comments?board=${seg(slug)}`, { body: text, author });
  }

  act(slug: string, id: string, action: KanbanAction, body: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("POST", `/deskrpg/kanban/tasks/${seg(id)}/${action}?board=${seg(slug)}`, body);
  }

  remove(slug: string, id: string): Promise<unknown> {
    return this.call("DELETE", `/deskrpg/kanban/tasks/${seg(id)}?board=${seg(slug)}`);
  }
}
