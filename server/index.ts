import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { Company, EngineError } from "../engine/company";
import { AnthropicLLM, AVAILABLE_MODELS, type LLM, MockLLM } from "../engine/llm";
import { JsonFileStore } from "../engine/store";

try {
  process.loadEnvFile();
} catch {
  // no .env file - fine
}

const PORT = Number(process.env.PORT ?? 8787);
const DATA_FILE = resolve(process.env.COMPANYAI_DATA ?? "data/company.json");
const STATIC_DIR = resolve("dist");

function chooseLLM(): LLM {
  const choice = process.env.COMPANYAI_PROVIDER;
  const mockDelay = Number(process.env.COMPANYAI_MOCK_DELAY_MS ?? 25);
  if (choice === "mock") return new MockLLM(mockDelay);
  if (choice === "anthropic") return new AnthropicLLM();
  const hasCredentials = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return hasCredentials ? new AnthropicLLM() : new MockLLM(mockDelay);
}

const company = await Company.open({ llm: chooseLLM(), store: new JsonFileStore(DATA_FILE) });

// ------------------------------------------------------------------ routing

type Handler = (ctx: { params: Record<string, string>; body: any }) => unknown | Promise<unknown>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$",
  );
  routes.push({ method, pattern, keys, handler });
}

route("GET", "/api/state", () => ({
  state: company.snapshot(),
  provider: company.provider,
  models: AVAILABLE_MODELS,
}));
route("PATCH", "/api/company", ({ body }) => (company.updateCompany(body), company.snapshot()));

route("POST", "/api/recruit", ({ body }) => company.recruit(String(body.jobDescription ?? "")));
route("GET", "/api/gateways", () => company.snapshot().gateways);
route("POST", "/api/gateways", ({ body }) => company.addGateway(body));
route("POST", "/api/gateways/:id/test", ({ params }) => company.testGateway(params.id));
route("DELETE", "/api/gateways/:id", ({ params }) => (company.removeGateway(params.id), { ok: true }));

route("POST", "/api/agents", async ({ body }) => {
  if (body.hermes) await company.verifyHermesProfile(body.hermes);
  return company.hire(body);
});
route("PATCH", "/api/agents/:id", ({ params, body }) => company.updateAgent(params.id, body));
route("DELETE", "/api/agents/:id", ({ params }) => (company.fire(params.id), { ok: true }));

// Hermes employees' automations (cron jobs on their profile)
route("GET", "/api/agents/:id/automations", ({ params }) => company.listAutomations(params.id));
route("POST", "/api/agents/:id/automations", ({ params, body }) => company.createAutomation(params.id, body));
route("PATCH", "/api/agents/:id/automations/:job", ({ params, body }) => company.updateAutomation(params.id, params.job, body));
route("DELETE", "/api/agents/:id/automations/:job", async ({ params }) => (await company.automationAction(params.id, params.job, "delete"), { ok: true }));
route("GET", "/api/agents/:id/automations/:job/runs", ({ params }) => company.automationRuns(params.id, params.job));
route("POST", "/api/agents/:id/automations/:job/:action", async ({ params }) => {
  const action = params.action;
  if (action !== "pause" && action !== "resume" && action !== "run") throw new EngineError(`알 수 없는 동작: ${action}`, 404);
  await company.automationAction(params.id, params.job, action);
  return { ok: true };
});

// The gateway's Hermes kanban (DeskRPG plugin)
const kanban = "/api/gateways/:id/kanban";
route("GET", kanban, ({ params }) => company.kanbanOverview(params.id));
route("POST", `${kanban}/boards`, ({ params, body }) => company.kanbanCreateBoard(params.id, body));
route("GET", `${kanban}/boards/:board`, ({ params }) => company.kanbanBoard(params.id, params.board));
route("POST", `${kanban}/boards/:board/cards`, ({ params, body }) => company.kanbanCreateCard(params.id, params.board, body));
route("GET", `${kanban}/boards/:board/cards/:card`, ({ params }) => company.kanbanCard(params.id, params.board, params.card));
route("DELETE", `${kanban}/boards/:board/cards/:card`, ({ params }) => company.kanbanDeleteCard(params.id, params.board, params.card));
route("POST", `${kanban}/boards/:board/cards/:card/comments`, ({ params, body }) =>
  company.kanbanComment(params.id, params.board, params.card, String(body.body ?? "")),
);
route("POST", `${kanban}/boards/:board/cards/:card/actions/:action`, ({ params, body }) =>
  company.kanbanAction(params.id, params.board, params.card, params.action as never, body ?? {}),
);

route("POST", "/api/tasks", ({ body }) => company.createTask(body));
route("PATCH", "/api/tasks/:id", ({ params, body }) => company.updateTask(params.id, body));
route("POST", "/api/tasks/:id/retry", ({ params }) => company.retryTask(params.id));
route("DELETE", "/api/tasks/:id", ({ params }) => (company.deleteTask(params.id), { ok: true }));
route("POST", "/api/tasks/:id/review", ({ params, body }) =>
  company.reviewTask(params.id, { approve: body.approve === true, comment: body.comment }),
);

route("POST", "/api/chats/:agentId", ({ params, body }) => company.chat(params.agentId, String(body.content ?? "")));
route("DELETE", "/api/chats/:agentId", ({ params }) => (company.clearChat(params.agentId), { ok: true }));

route("POST", "/api/meetings", ({ body }) => company.startMeeting(body));
route("POST", "/api/meetings/:id/cancel", ({ params }) => company.cancelMeeting(params.id));
route("POST", "/api/meetings/:id/messages", ({ params, body }) => company.postMeetingMessage(params.id, String(body.content ?? "")));
route("POST", "/api/meetings/:id/grant", ({ params, body }) => company.grantFloor(params.id, String(body.agentId ?? "")));
route("POST", "/api/meetings/:id/end", ({ params }) => company.endMeeting(params.id));
route("POST", "/api/meetings/:id/join", ({ params, body }) => company.joinMeeting(params.id, body.joined !== false));
route("POST", "/api/meetings/:id/outcome", ({ params, body }) => company.registerOutcome(params.id, body));
route("POST", "/api/meetings/:id/action-items/:index/promote", ({ params }) =>
  company.promoteActionItem(params.id, Number(params.index)),
);

function sendJSON(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EngineError("요청 본문이 올바른 JSON이 아닙니다.");
  }
}

function handleEvents(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: "state", state: company.snapshot() });
  const unsubscribe = company.subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(pathname: string, res: ServerResponse) {
  if (!existsSync(STATIC_DIR)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("UI가 빌드되지 않았습니다. 개발 중에는 `npm run dev`로 http://localhost:5173 을 여세요.");
    return;
  }
  let file = normalize(join(STATIC_DIR, pathname));
  if (!file.startsWith(STATIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(STATIC_DIR, "index.html"); // SPA fallback
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (url.pathname === "/api/events" && method === "GET") return handleEvents(req, res);
  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);

  for (const r of routes) {
    const match = r.method === method && url.pathname.match(r.pattern);
    if (!match) continue;
    try {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      const body = method === "GET" ? {} : await readBody(req);
      sendJSON(res, 200, await r.handler({ params, body }));
    } catch (err) {
      if (err instanceof EngineError) return sendJSON(res, err.status, { error: err.message });
      console.error(err);
      sendJSON(res, 500, { error: "서버 오류가 발생했습니다." });
    }
    return;
  }
  sendJSON(res, 404, { error: "Not found" });
});

const stopHermesSync = company.startHermesSync(Number(process.env.COMPANYAI_HERMES_SYNC_MS ?? 15_000));

server.listen(PORT, () => {
  console.log(`CompanyAI engine listening on http://localhost:${PORT}`);
  console.log(`  LLM provider: ${company.provider}${company.provider === "mock" ? " (set ANTHROPIC_API_KEY to use Claude)" : ""}`);
  console.log(`  Data file:    ${DATA_FILE}`);
});

async function shutdown() {
  stopHermesSync();
  server.close();
  // Running work is recovered (re-queued) on the next start.
  await company.flush();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
