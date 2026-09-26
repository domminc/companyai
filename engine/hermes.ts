/**
 * Minimal client for the Hermes Agent API Server (https://github.com/NousResearch/hermes-agent).
 *
 * Uses the Runs API: `POST /v1/runs` then `GET /v1/runs/{id}/events` (SSE). A named profile on a
 * multiplexing gateway is addressed with the `/p/<profile>` prefix. Behaviour notes borrowed from
 * DeskRPG's client, which were measured against real gateways:
 * - Runs SSE frames carry the event name inside the JSON (`data: {"event": "message.delta", ...}`),
 *   while other endpoints use `event:` lines. The parser accepts both.
 * - The final answer is `run.completed.output`; deltas can include text from retried model calls.
 * - The runs stream can stay open after `run.completed`, so reading stops at the terminal event
 *   without awaiting the cancel.
 * - 429 (concurrent-run cap) and 503 are retried, honouring `Retry-After`.
 */

export type HermesErrorCode = "unreachable" | "unauthorized" | "unknown_profile" | "http_error" | "run_failed";

export class HermesError extends Error {
  constructor(
    readonly code: HermesErrorCode,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseFrame(raw: string): SseEvent | null {
  let name = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    const data = JSON.parse(dataLines.join("\n")) as unknown;
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    const resolved = name === "message" && typeof record.event === "string" && record.event ? record.event : name;
    return { event: resolved, data: record };
  } catch {
    return null; // a malformed frame must not kill the stream
  }
}

export function createSseParser() {
  let buffer = "";
  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk.replace(/\r\n/g, "\n");
      const events: SseEvent[] = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const parsed = parseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) events.push(parsed);
        boundary = buffer.indexOf("\n\n");
      }
      return events;
    },
  };
}

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted", "error"]);
const MAX_RETRIES = 3;

export interface HermesRunRequest {
  input: string;
  /** Appended to the profile's own system prompt (SOUL.md stays the identity). */
  instructions?: string;
  /** Give up (and ask Hermes to stop the run) after this long. */
  timeoutMs?: number;
}

export interface HermesRunCallbacks {
  onDelta?: (text: string) => void;
  onTool?: (toolName: string | null) => void;
}

export interface HermesClientConfig {
  baseUrl: string;
  token?: string;
  /** Profile name on a multiplexing gateway; empty or "default" means the gateway's own profile. */
  profile?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class HermesClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: HermesClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  url(path: string): string {
    const profile = this.config.profile?.trim();
    const prefix = profile && profile !== "default" ? `/p/${encodeURIComponent(profile)}` : "";
    return `${this.baseUrl}${prefix}${path}`;
  }

  private async request(path: string, init: RequestInit & { signal?: AbortSignal } = {}, prefixed = true): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(prefixed ? this.url(path) : `${this.baseUrl}${path}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
          },
        });
      } catch (err) {
        if (init.signal?.aborted) throw err;
        throw new HermesError("unreachable", `Hermes 게이트웨이에 연결할 수 없습니다: ${err instanceof Error ? err.message : err}`);
      }
      if (res.ok) return res;
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        await res.text().catch(() => "");
        const retryAfter = Number(res.headers.get("Retry-After"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const body = errorText(await res.text().catch(() => ""));
      const code: HermesErrorCode =
        res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "unknown_profile" : "http_error";
      throw new HermesError(code, body || `HTTP ${res.status}`, res.status);
    }
  }

  /**
   * A JSON call to any other gateway route (DeskRPG plugin, cron jobs). With `prefixed: false`
   * the path is used as given: plugin routes spell out `/p/<profile>` themselves, and owner-scope
   * routes (kanban) take none.
   */
  async json<T>(method: string, path: string, body?: unknown, { prefixed = true } = {}): Promise<T> {
    const res = await this.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, prefixed);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Cheap reachability + auth check. */
  async capabilities(): Promise<Record<string, unknown>> {
    const res = await this.request("/v1/capabilities", { method: "GET" });
    return (await res.json()) as Record<string, unknown>;
  }

  /** Runs one agent turn and resolves with its final answer. */
  async run(req: HermesRunRequest, cb: HermesRunCallbacks = {}): Promise<string> {
    const body: Record<string, unknown> = { input: req.input };
    if (req.instructions) body.instructions = req.instructions;
    const started = await this.request("/v1/runs", { method: "POST", body: JSON.stringify(body) });
    const { run_id: runId } = (await started.json()) as { run_id?: string };
    if (!runId) throw new HermesError("http_error", "Run submission returned no run_id");

    const signal = req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined;
    try {
      const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, { method: "GET", signal });
      return await this.drain(res, cb);
    } catch (err) {
      if (!signal?.aborted) throw err;
      void this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: "{}" }).catch(() => {});
      throw new HermesError("run_failed", `응답이 ${Math.round(req.timeoutMs! / 1000)}초 안에 끝나지 않아 중단했습니다.`);
    }
  }

  private async drain(res: Response, cb: HermesRunCallbacks): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) throw new HermesError("http_error", "Run event stream has no body");
    const parser = createSseParser();
    const decoder = new TextDecoder();
    let accumulated = "";
    let final: string | null = null;
    let failure: string | null = null;
    let terminal = false;

    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        const { data } = event;
        if ((event.event === "message.delta" || event.event === "assistant.delta") && typeof data.delta === "string") {
          accumulated += data.delta;
          cb.onDelta?.(data.delta);
        } else if (event.event === "tool.started" && typeof data.tool === "string") {
          cb.onTool?.(data.tool);
        } else if (event.event === "tool.started" && typeof data.tool_name === "string") {
          cb.onTool?.(data.tool_name);
        } else if (event.event === "run.completed" && typeof data.output === "string" && data.output.trim()) {
          final = data.output;
        } else if (event.event === "run.failed" || event.event === "error") {
          failure = typeof data.error === "string" && data.error ? data.error : typeof data.message === "string" ? data.message : "Hermes run failed";
        } else if (event.event === "run.cancelled" || event.event === "run.interrupted") {
          failure = typeof data.error === "string" && data.error ? data.error : `Hermes run ${event.event.slice(4)}`;
        }
        if (TERMINAL_EVENTS.has(event.event)) {
          terminal = true;
          void reader.cancel().catch(() => {}); // never await: the stream may stay open
          break outer;
        }
      }
    }
    cb.onTool?.(null);
    if (failure) throw new HermesError("run_failed", failure);
    if (!terminal && !accumulated) throw new HermesError("run_failed", "Run event stream ended without a result");
    return final ?? accumulated;
  }
}

/** `{"error": {"message": ...}}`, `{"error": "code", "detail": ...}` or plain text → one line. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown; message?: unknown };
    const err = parsed.error as { message?: unknown } | string | undefined;
    const parts = [typeof err === "string" ? err : err?.message, parsed.detail, parsed.message].filter(
      (p): p is string => typeof p === "string" && !!p,
    );
    if (parts.length) return parts.join(": ");
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

export function describeHermesError(err: HermesError): string {
  switch (err.code) {
    case "unauthorized":
      return "Hermes 인증 실패: 게이트웨이 API 키(API_SERVER_KEY) 또는 프로필 키를 확인하세요.";
    case "unknown_profile":
      return "Hermes 프로필을 찾을 수 없습니다. 프로필 이름을 확인하세요.";
    case "unreachable":
      return err.message;
    case "run_failed":
      return `Hermes 실행 실패: ${err.message}`;
    default:
      return `Hermes 오류 (${err.status}): ${err.message}`;
  }
}
