/**
 * A stand-in for a Hermes Agent API Server, following the documented Runs contract:
 * `GET /v1/capabilities`, `POST /v1/runs`, `GET /v1/runs/{id}/events` (SSE with the event name
 * inside the JSON), and `/p/<profile>/...` for named profiles. Like the real gateway it leaves the
 * events stream open after `run.completed`.
 *
 * Used by the tests, and runnable for local UI work: `npm run fake-hermes`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRunRequest {
  profile: string;
  input: string;
  instructions?: string;
  authorization?: string;
}

export type FakeReply = string | { error: string } | { tool: string; text: string } | { hang: true };

export interface FakeHermesOptions {
  /** Owner key; also accepted for every profile. */
  apiKey?: string;
  /** Profile name -> its own key. Profiles not listed here return 404. "default" always exists. */
  profiles?: Record<string, string | undefined>;
  reply?: (req: FakeRunRequest) => FakeReply;
  /** Reject this many run submissions with 429 before accepting (tests the retry). */
  rateLimitFirst?: number;
  chunkDelayMs?: number;
}

export interface FakeHermes {
  url: string;
  runs: FakeRunRequest[];
  /** Run ids a client asked to stop. */
  stopped: string[];
  close(): Promise<void>;
}

/** Default behaviour: raise a hand twice per profile, then pass; answer turns and tasks in Korean. */
export function defaultFakeReply(): (req: FakeRunRequest) => FakeReply {
  const polls = new Map<string, number>();
  return (req) => {
    if (req.input.startsWith("📋 [Meeting poll:")) {
      const n = (polls.get(req.profile) ?? 0) + 1;
      polls.set(req.profile, n);
      return n <= 2 ? `SPEAK: ${req.profile} 프로필 관점을 보태고 싶습니다` : "PASS";
    }
    if (req.input.startsWith("📋 [Meeting:")) {
      return `(Hermes ${req.profile}) 실제 도구로 확인해 보니 일정상 2주가 적당합니다. 제가 조사 결과를 정리해 공유하겠습니다.`;
    }
    if (req.input.includes("Reply with only a JSON object")) {
      const ids = [...req.input.matchAll(/id=(\S+) name=(\S+)/g)];
      return JSON.stringify({
        summary: "Hermes 서기가 정리한 회의록입니다.",
        decisions: ["2주 안에 1차 결과를 공유한다"],
        actionItems: ids.map(([, id, name]) => ({ title: `${name} 후속 작업`, description: "회의 결정사항 실행", assigneeId: id })),
      });
    }
    return { tool: "web_search", text: `## 결과 (Hermes ${req.profile})\n\n요청한 작업을 도구로 조사해 정리했습니다.` };
  };
}

export async function startFakeHermes(opts: FakeHermesOptions = {}, port = 0): Promise<FakeHermes> {
  const reply = opts.reply ?? defaultFakeReply();
  const runs: FakeRunRequest[] = [];
  const stopped: string[] = [];
  const pending = new Map<string, FakeRunRequest>();
  let rateLimited = 0;
  let seq = 0;

  const authorized = (req: IncomingMessage, profile: string) => {
    const header = req.headers.authorization ?? "";
    const keys = [opts.apiKey, opts.profiles?.[profile]].filter(Boolean);
    return keys.length === 0 || keys.some((k) => header === `Bearer ${k}`);
  };
  const knownProfile = (profile: string) => profile === "default" || (opts.profiles && profile in opts.profiles);

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = url.pathname.match(/^(?:\/p\/([^/]+))?(\/.*)$/)!;
    const profile = m[1] ? decodeURIComponent(m[1]) : "default";
    const path = m[2];

    if (!knownProfile(profile)) return json(res, 404, { error: "unknown profile" });
    if (!authorized(req, profile)) return json(res, 401, { error: "invalid api key" });

    if (req.method === "GET" && path === "/v1/capabilities") {
      return json(res, 200, { object: "hermes.api_server.capabilities", features: { run_submission: true, run_events_sse: true } });
    }

    if (req.method === "POST" && path === "/v1/runs") {
      if (rateLimited < (opts.rateLimitFirst ?? 0)) {
        rateLimited++;
        res.writeHead(429, { "retry-after": "0" });
        return res.end("too many concurrent runs");
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (!body.input) return json(res, 400, { error: "Missing 'input' field" });
      const run: FakeRunRequest = { profile, input: body.input, instructions: body.instructions, authorization: req.headers.authorization };
      runs.push(run);
      const runId = `run_${++seq}`;
      pending.set(runId, run);
      return json(res, 202, { run_id: runId, status: "started" });
    }

    const stop = path.match(/^\/v1\/runs\/([^/]+)\/stop$/);
    if (req.method === "POST" && stop) {
      stopped.push(stop[1]);
      return json(res, 200, { status: "stopping" });
    }

    const events = path.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && events) {
      const run = pending.get(events[1]);
      if (!run) return json(res, 404, { error: "unknown run" });
      pending.delete(events[1]);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      const send = (event: string, fields: Record<string, unknown>) =>
        res.write(`id: ${seq}\ndata: ${JSON.stringify({ event, run_id: events[1], timestamp: Date.now() / 1000, ...fields })}\n\n`);
      const answer = reply(run);
      if (typeof answer === "object" && "hang" in answer) return; // never answers
      if (typeof answer === "object" && "error" in answer) {
        send("run.failed", { error: answer.error });
        return; // stream deliberately left open
      }
      const text = typeof answer === "string" ? answer : "text" in answer ? answer.text : "";
      if (typeof answer === "object" && "tool" in answer) {
        send("tool.started", { tool: answer.tool, preview: "..." });
        send("tool.completed", { tool: answer.tool, duration: 0.1, error: false });
      }
      for (const piece of text.match(/\S+\s*/g) ?? [text]) {
        if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
        send("message.delta", { delta: piece });
      }
      send("run.completed", { output: text, usage: {} });
      return; // like Hermes, keep the connection open after the terminal event
    }

    json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    runs,
    stopped,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// `npm run fake-hermes`: a local gateway with a few profiles for trying the UI.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_HERMES_PORT ?? 8642);
  const fake = await startFakeHermes(
    { apiKey: "dev-key", profiles: { researcher: undefined, coder: undefined }, chunkDelayMs: Number(process.env.FAKE_HERMES_DELAY_MS ?? 30) },
    port,
  );
  console.log(`Fake Hermes gateway on ${fake.url}  (API key: dev-key, profiles: default, researcher, coder)`);
}
