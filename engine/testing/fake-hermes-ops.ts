/**
 * The cron and kanban side of the fake gateway: Hermes' own `/api/jobs`, and the DeskRPG plugin's
 * `/p/<profile>/deskrpg/cron/*`, `/deskrpg/info` and `/deskrpg/kanban/*` routes, in memory.
 * Work moves on by itself: a card with an assignee goes ready → running → done, and a job that is
 * run now is "running" for a moment and then records a run.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface FakeOpsOptions {
  /** Serve the DeskRPG plugin routes (default true). Hermes' core /api/jobs is always there. */
  plugin?: boolean;
  /** How long each step of simulated work takes. */
  workMs?: number;
}

interface Job {
  id: string;
  profile: string;
  name: string;
  prompt: string;
  schedule: { kind: string; display: string };
  schedule_display: string;
  repeat: { times: number | null; completed: number };
  enabled: boolean;
  state: string;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string | null;
  skills: string[];
  model: string | null;
  provider: string | null;
}

interface Run {
  id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary: string;
  result_text: string;
}

interface Card {
  id: string;
  title: string;
  body: string | null;
  status: string;
  assignee: string | null;
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  latest_summary: string | null;
  result: string | null;
  comments: { id: number; author: string; body: string; created_at: number }[];
  events: { id: number; kind: string; payload: unknown; created_at: number }[];
  runs: { id: number; profile: string | null; status: string; outcome: string | null; summary: string | null; started_at: number; ended_at: number | null }[];
}

export interface FakeOps {
  handle(req: IncomingMessage, res: ServerResponse, profile: string, path: string, url: URL): Promise<boolean>;
  jobs: Job[];
  runs: Map<string, Run[]>;
  boards: Map<string, { slug: string; name: string; cards: Card[] }>;
  dispose(): void;
}

const COLUMNS = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];

export function createFakeOps(opts: FakeOpsOptions = {}): FakeOps {
  const plugin = opts.plugin ?? true;
  const workMs = opts.workMs ?? 1500;
  const jobs: Job[] = [];
  const runs = new Map<string, Run[]>();
  const boards = new Map<string, { slug: string; name: string; cards: Card[] }>([["default", { slug: "default", name: "기본 보드", cards: [] }]]);
  const timers = new Set<NodeJS.Timeout>();
  let seq = 0;
  const later = (fn: () => void, ms = workMs) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    timers.add(t);
  };
  const iso = () => new Date().toISOString();
  const secs = () => Math.floor(Date.now() / 1000);

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return true;
  };
  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  };

  // ------------------------------------------------------------------ cron

  const createJob = (profile: string, body: Record<string, unknown>): Job => {
    const display = String(body.schedule);
    const job: Job = {
      id: `job${++seq}`,
      profile,
      name: String(body.name),
      prompt: String(body.prompt ?? ""),
      schedule: { kind: display.includes(" ") ? "cron" : "interval", display },
      schedule_display: display,
      repeat: { times: null, completed: 0 },
      enabled: body.paused !== true,
      state: body.paused === true ? "paused" : "scheduled",
      created_at: iso(),
      next_run_at: new Date(Date.now() + 3600_000).toISOString(),
      last_run_at: null,
      last_status: null,
      last_error: null,
      deliver: "local",
      skills: [],
      model: null,
      provider: null,
    };
    jobs.push(job);
    return job;
  };

  const runJob = (job: Job) => {
    job.state = "running";
    const run: Run = { id: `r${++seq}`, started_at: iso(), ended_at: null, status: "running", summary: "", result_text: "" };
    runs.set(job.id, [run, ...(runs.get(job.id) ?? [])]);
    later(() => {
      run.ended_at = iso();
      run.status = "ok";
      run.summary = `${job.name} 완료`;
      run.result_text = `## ${job.name}\n\n(Hermes ${job.profile}) 정기 작업을 실행했습니다.\n\n- 지시: ${job.prompt}\n- 결과: 특이사항 없음`;
      job.state = job.enabled ? "scheduled" : "paused";
      job.last_run_at = run.ended_at;
      job.last_status = "ok";
      job.repeat.completed += 1;
    });
  };

  async function cron(req: IncomingMessage, res: ServerResponse, profile: string, rest: string, url: URL, style: "plugin" | "core") {
    const mine = jobs.filter((j) => j.profile === profile);
    if (rest === "" || rest === "/") {
      if (req.method === "GET") {
        const all = url.searchParams.get("include_disabled") === "true";
        return json(res, 200, { jobs: mine.filter((j) => all || j.enabled) });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (!body.name || !body.schedule) return json(res, 400, { error: "invalid_field", detail: "name and schedule are required" });
        return json(res, style === "plugin" ? 201 : 200, { job: createJob(profile, body) });
      }
    }
    const m = rest.match(/^\/([^/]+)(?:\/(pause|resume|run|runs))?$/);
    const job = m && mine.find((j) => j.id === decodeURIComponent(m[1]));
    if (!m || !job) return json(res, 404, { error: "job_not_found" });
    const action = m[2];
    if (!action) {
      if (req.method === "GET") return json(res, 200, { job });
      if (req.method === "DELETE") {
        jobs.splice(jobs.indexOf(job), 1);
        return json(res, 200, { ok: true });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const body = await readBody(req);
        const updates = (style === "plugin" ? body.updates : body) as Record<string, unknown>;
        if (typeof updates?.name === "string") job.name = updates.name;
        if (typeof updates?.prompt === "string") job.prompt = updates.prompt;
        if (typeof updates?.schedule === "string") job.schedule_display = job.schedule.display = updates.schedule;
        return json(res, 200, { job });
      }
    }
    if (action === "runs" && style === "plugin" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return json(res, 200, { runs: (runs.get(job.id) ?? []).slice(0, limit), limit });
    }
    if (req.method === "POST" && action === "pause") {
      job.enabled = false;
      job.state = "paused";
      return json(res, 200, { job });
    }
    if (req.method === "POST" && action === "resume") {
      job.enabled = true;
      job.state = "scheduled";
      return json(res, 200, { job });
    }
    if (req.method === "POST" && action === "run") {
      runJob(job);
      return json(res, style === "plugin" ? 202 : 200, { accepted: true, job });
    }
    return json(res, 404, { error: "not found" });
  }

  // ---------------------------------------------------------------- kanban

  const event = (card: Card, kind: string, payload: unknown = {}) =>
    card.events.push({ id: ++seq, kind, payload, created_at: secs() });

  /** ready → running → done, the way a Hermes worker would take a card. */
  const work = (card: Card) => {
    if (!card.assignee || card.status !== "ready") return;
    later(() => {
      if (card.status !== "ready") return;
      card.status = "running";
      card.started_at = secs();
      card.runs.push({ id: ++seq, profile: card.assignee, status: "running", outcome: null, summary: null, started_at: secs(), ended_at: null });
      event(card, "claimed", { profile: card.assignee });
      later(() => {
        if (card.status !== "running") return;
        const run = card.runs.at(-1)!;
        run.status = "done";
        run.outcome = "completed";
        run.ended_at = secs();
        run.summary = `${card.title} 처리 완료`;
        card.status = "done";
        card.completed_at = secs();
        card.latest_summary = run.summary;
        card.result = `## ${card.title}\n\n(Hermes ${card.assignee}) 카드를 처리했습니다.\n\n1. 요구사항 확인\n2. 작업 수행\n3. 결과 정리`;
        event(card, "completed", { summary: run.summary });
      });
    });
  };

  const view = (card: Card) => {
    const { comments, events, runs: cardRuns, result, ...rest } = card;
    void events;
    void cardRuns;
    void result;
    return { ...rest, comment_count: comments.length };
  };

  async function kanban(req: IncomingMessage, res: ServerResponse, rest: string, url: URL) {
    if (rest === "/boards") {
      if (req.method === "GET") {
        return json(res, 200, {
          boards: [...boards.values()].map((b) => ({ slug: b.slug, name: b.name, is_current: b.slug === "default", total: b.cards.length, archived: false })),
          current: "default",
        });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const slug = String(body.slug ?? "");
        if (!slug || boards.has(slug)) return json(res, 400, { error: "invalid_field", detail: "slug" });
        boards.set(slug, { slug, name: String(body.name ?? slug), cards: [] });
        return json(res, 201, { board: { slug, name: body.name ?? slug } });
      }
    }
    if (rest === "/profiles" && req.method === "GET") return json(res, 200, { profiles: [] });

    const slug = url.searchParams.get("board");
    if (!slug) return json(res, 400, { error: "missing_board", detail: "?board= is required" });
    const board = boards.get(slug);
    if (!board) return json(res, 404, { error: "board_not_found" });

    if (rest === "/board" && req.method === "GET") {
      return json(res, 200, {
        columns: COLUMNS.map((name) => ({ name, tasks: board.cards.filter((c) => c.status === name).map(view) })),
        tenants: [],
        assignees: [...new Set(board.cards.map((c) => c.assignee).filter(Boolean))],
        latest_event_id: seq,
        now: secs(),
      });
    }
    if (rest === "/tasks" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.title) return json(res, 400, { error: "invalid_field", detail: "title" });
      const card: Card = {
        id: `t_${(++seq).toString(16).padStart(6, "0")}`,
        title: String(body.title),
        body: typeof body.body === "string" ? body.body : null,
        status: body.triage ? "triage" : body.assignee ? "ready" : "todo",
        assignee: typeof body.assignee === "string" ? body.assignee : null,
        priority: typeof body.priority === "number" ? body.priority : 0,
        created_at: secs(),
        started_at: null,
        completed_at: null,
        latest_summary: null,
        result: null,
        comments: [],
        events: [],
        runs: [],
      };
      event(card, "created");
      board.cards.push(card);
      work(card);
      return json(res, 201, { task: view(card) });
    }
    const m = rest.match(/^\/tasks\/([^/]+)(?:\/([a-z-]+))?$/);
    const card = m && board.cards.find((c) => c.id === decodeURIComponent(m[1]));
    if (!m || !card) return json(res, 404, { error: "task_not_found" });
    const action = m[2];
    if (!action) {
      if (req.method === "GET") {
        return json(res, 200, {
          task: { ...view(card), result: card.result },
          comments: card.comments,
          events: card.events,
          attachments: null,
          links: { parents: [], children: [] },
          runs: card.runs,
        });
      }
      if (req.method === "DELETE") {
        board.cards.splice(board.cards.indexOf(card), 1);
        return json(res, 200, { ok: true });
      }
    }
    if (req.method !== "POST") return json(res, 404, { error: "not found" });
    const body = await readBody(req);
    switch (action) {
      case "comments":
        card.comments.push({ id: ++seq, author: String(body.author ?? "deskrpg"), body: String(body.body), created_at: secs() });
        return json(res, 201, { comment: card.comments.at(-1) });
      case "approve":
        if (!["running", "ready", "blocked", "review"].includes(card.status)) return json(res, 409, { error: "invalid_transition", detail: "not in a completable status" });
        card.status = "done";
        card.result = typeof body.result === "string" && body.result ? body.result : card.result;
        event(card, "completed");
        return json(res, 200, {});
      case "request-changes":
        if (!body.comment) return json(res, 400, { error: "invalid_field", detail: "comment" });
        card.comments.push({ id: ++seq, author: "deskrpg", body: String(body.comment), created_at: secs() });
        if (card.status !== "review" && card.status !== "done") return json(res, 409, { error: "invalid_transition", detail: "not in review" });
        card.status = "ready";
        work(card);
        return json(res, 200, { outcome: "reopened" });
      case "reassign":
        card.assignee = String(body.profile);
        if (card.status === "todo") card.status = "ready";
        work(card);
        return json(res, 200, {});
      case "unblock":
        card.status = "ready";
        work(card);
        return json(res, 200, {});
      case "reclaim":
      case "terminate":
        if (card.status !== "running") return json(res, 409, { error: "no_active_run" });
        card.status = "ready";
        work(card);
        return json(res, 200, {});
      case "archive":
        card.status = "archived";
        return json(res, 200, {});
      case "specify":
      case "decompose":
      case "estimate":
        event(card, action);
        return json(res, 200, { ok: true });
      default:
        return json(res, 404, { error: "unknown_action" });
    }
  }

  return {
    jobs,
    runs,
    boards,
    dispose: () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    async handle(req, res, profile, path, url) {
      if (path.startsWith("/api/jobs")) return cron(req, res, profile, path.slice("/api/jobs".length), url, "core");
      if (!plugin) return false;
      if (path === "/deskrpg/info" && req.method === "GET" && profile === "default") {
        return json(res, 200, { plugin: "deskrpg", version: "0.15.0-fake", capabilities: ["kanban", "cron"], timezone: "Asia/Seoul", kanban: true });
      }
      if (path.startsWith("/deskrpg/cron/jobs")) return cron(req, res, profile, path.slice("/deskrpg/cron/jobs".length), url, "plugin");
      if (path.startsWith("/deskrpg/kanban") && profile === "default") return kanban(req, res, path.slice("/deskrpg/kanban".length), url);
      return false;
    },
  };
}
