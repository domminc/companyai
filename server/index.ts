import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { type Actor, Company, EngineError } from "../engine/company";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLLM, AVAILABLE_MODELS, DEFAULT_MODEL, describeError, type LLM, MockLLM } from "../engine/llm";
import { JsonFileStore } from "../engine/store";
import {
  atLeast,
  AuthError,
  AuthStore,
  clearedCookie,
  FailureLimiter,
  readCookie,
  type Role,
  SESSION_COOKIE,
  sessionCookie,
  type User,
} from "./auth";
import { keyHint, SettingsStore } from "./settings";

try {
  process.loadEnvFile();
} catch {
  // no .env file - fine
}

const PORT = Number(process.env.PORT ?? 8787);
const DATA_FILE = resolve(process.env.COMPANYAI_DATA ?? "data/company.json");
const STATIC_DIR = resolve("dist");

const settings = await SettingsStore.open(join(dirname(DATA_FILE), "settings.json"));
const mockDelay = Number(process.env.COMPANYAI_MOCK_DELAY_MS ?? 25);
const envHasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Where Claude's key comes from: .env (wins), the key entered in the app, or none (demo mode). */
function claudeSource(): "env" | "app" | "none" {
  if (process.env.COMPANYAI_PROVIDER === "mock") return "none";
  if (envHasKey || process.env.COMPANYAI_PROVIDER === "anthropic") return "env";
  return settings.anthropicApiKey ? "app" : "none";
}

function chooseLLM(): LLM {
  const source = claudeSource();
  if (source === "env") return new AnthropicLLM();
  if (source === "app") return new AnthropicLLM(new Anthropic({ apiKey: settings.anthropicApiKey }));
  return new MockLLM(mockDelay);
}

const company = await Company.open({ llm: chooseLLM(), store: new JsonFileStore(DATA_FILE) });
const auth = await AuthStore.open(process.env.COMPANYAI_AUTH ?? join(dirname(DATA_FILE), "auth.json"));
const loginLimiter = new FailureLimiter();

// ------------------------------------------------------------------ routing

interface Ctx {
  params: Record<string, string>;
  body: any;
  /** The signed-in person; undefined while login is off. */
  user?: User;
  req: IncomingMessage;
  res: ServerResponse;
}
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
/** Who may call a route when login is on. By default reads need a viewer, changes a member. */
type Access = Role | "public";
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; access: Access }[] = [];

function route(method: string, path: string, handler: Handler, access?: Access) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$",
  );
  routes.push({ method, pattern, keys, handler, access: access ?? (method === "GET" ? "viewer" : "member") });
}

function actorOf(user?: User): Actor | undefined {
  return user && { name: user.displayName, owner: user.role === "owner" };
}

// ------------------------------------------------------------------ accounts

function isSecure(req: IncomingMessage) {
  return req.headers["x-forwarded-proto"] === "https";
}

function signIn(ctx: Ctx, user: User) {
  const { token, maxAge } = auth.issue(user.id);
  ctx.res.setHeader("set-cookie", sessionCookie(token, maxAge, isSecure(ctx.req)));
}

/** Lets the launcher tell this app apart from whatever else might be on the port. */
route("GET", "/api/health", () => ({ app: "companyai" }), "public");
route("GET", "/api/auth/me", ({ user }) => ({ enabled: auth.enabled, user: user ?? null }), "public");
route(
  "POST",
  "/api/auth/setup",
  async (ctx) => {
    const user = await auth.setup(ctx.body);
    // Tabs that were open without login lose their stream and land on the login screen.
    presence.closeAll();
    signIn(ctx, user);
    company.as(actorOf(user), () => company.note(`${user.displayName}님이 소유자 계정을 만들어 로그인을 켰습니다.`));
    return { enabled: true, user };
  },
  "public",
);
route(
  "POST",
  "/api/auth/login",
  async (ctx) => {
    const key = ctx.req.socket.remoteAddress ?? "?";
    loginLimiter.check(key);
    try {
      const user = await auth.login(ctx.body.username, ctx.body.password);
      loginLimiter.reset(key);
      signIn(ctx, user);
      return { enabled: true, user };
    } catch (err) {
      loginLimiter.fail(key);
      throw err;
    }
  },
  "public",
);
route(
  "POST",
  "/api/auth/logout",
  ({ res }) => {
    res.setHeader("set-cookie", clearedCookie());
    return { ok: true };
  },
  "public",
);
route(
  "POST",
  "/api/auth/disable",
  async ({ user, body, res }) => {
    if (!user) throw new AuthError("로그인이 이미 꺼져 있습니다.");
    await auth.disable(user.id, body.password);
    res.setHeader("set-cookie", clearedCookie());
    company.note(`${user.displayName}님이 로그인을 껐습니다. 이제 누구나 바로 들어올 수 있습니다.`);
    presence.closeAll();
    return { enabled: false, user: null };
  },
  "owner",
);
route("PATCH", "/api/auth/me", async ({ user, body }) => {
  if (!user) throw new AuthError("로그인이 꺼져 있습니다.");
  const updated = await auth.update(user.id, { displayName: body.displayName, password: body.password });
  presence.refresh(updated);
  return updated;
}, "viewer");

/** Accounts only make sense once there is an owner to manage them. */
function requireLogin() {
  if (!auth.enabled) throw new AuthError("먼저 🔐 로그인 설정에서 소유자 계정을 만드세요.", 409);
}

// ------------------------------------------------------------------ Claude key

function claudeStatus() {
  const source = claudeSource();
  return { provider: company.provider, source, ...(source === "app" ? { keyHint: keyHint(settings.anthropicApiKey!) } : {}) };
}

route("GET", "/api/settings/claude", () => claudeStatus());
route("PUT", "/api/settings/claude", async ({ body }) => {
  if (claudeSource() === "env") throw new EngineError("서버의 .env에 있는 키를 쓰고 있습니다. 바꾸려면 .env를 고치세요.", 409);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) throw new EngineError("API 키를 입력하세요.");
  const client = new Anthropic({ apiKey });
  try {
    await client.models.retrieve(DEFAULT_MODEL); // cheap check that the key works
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new EngineError("이 API 키로 Claude에 연결할 수 없습니다. 키를 다시 확인하세요.", 400);
    }
    throw new EngineError(`키를 확인하지 못했습니다: ${describeError(err)}`, 502);
  }
  await settings.setAnthropicApiKey(apiKey);
  company.setLLM(new AnthropicLLM(client));
  company.note("Claude API 키를 등록했습니다. 이제 Claude 직원들이 실제로 일합니다.");
  streams.announce({ type: "provider", provider: company.provider });
  return claudeStatus();
}, "owner");
route("DELETE", "/api/settings/claude", async () => {
  if (claudeSource() === "env") throw new EngineError("서버의 .env에 있는 키는 앱에서 지울 수 없습니다.", 409);
  await settings.setAnthropicApiKey(undefined);
  company.setLLM(new MockLLM(mockDelay));
  company.note("Claude API 키를 지웠습니다. 데모 모드로 돌아갑니다.");
  streams.announce({ type: "provider", provider: company.provider });
  return claudeStatus();
}, "owner");

route("GET", "/api/users", () => (requireLogin(), auth.users()), "owner");
route("POST", "/api/users", async ({ body }) => {
  requireLogin();
  const created = await auth.create(body);
  company.note(`${created.displayName}님(${created.role})의 계정을 만들었습니다.`);
  return created;
}, "owner");
route("PATCH", "/api/users/:id", async ({ params, body }) => {
  requireLogin();
  const updated = await auth.update(params.id, body);
  presence.refresh(updated);
  if (body.password !== undefined) presence.close(params.id);
  return updated;
}, "owner");
route("DELETE", "/api/users/:id", async ({ params, user }) => {
  requireLogin();
  const target = auth.get(params.id);
  await auth.remove(params.id);
  presence.close(params.id);
  if (params.id === user?.id) presence.closeAll();
  if (target) company.note(`${target.displayName}님의 계정을 지웠습니다.`);
  return { ok: true };
}, "owner");

route("GET", "/api/state", () => ({
  state: company.snapshot(),
  provider: company.provider,
  models: AVAILABLE_MODELS,
}));
route("PATCH", "/api/company", ({ body }) => (company.updateCompany(body), company.snapshot()), "owner");

route("POST", "/api/recruit", ({ body }) => company.recruit(String(body.jobDescription ?? "")));
route("GET", "/api/gateways", () => company.snapshot().gateways);
route("POST", "/api/gateways", ({ body }) => company.addGateway(body), "owner");
route("POST", "/api/gateways/:id/test", ({ params }) => company.testGateway(params.id));
route("DELETE", "/api/gateways/:id", ({ params }) => (company.removeGateway(params.id), { ok: true }), "owner");

route("POST", "/api/agents", async ({ body }) => {
  if (body.hermes) await company.verifyHermesProfile(body.hermes);
  return company.hire(body);
});
route("PATCH", "/api/agents/:id", ({ params, body }) => company.updateAgent(params.id, body));
route("DELETE", "/api/agents/:id", ({ params }) => (company.fire(params.id), { ok: true }), "owner");

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

/**
 * Who is here: one entry per open event stream. With login on, everyone online is shown to
 * everyone (and walks around the 3D office as a visitor).
 */
const presence = (() => {
  /** Each open stream, with how to shut it down (end the response and stop its subscription). */
  const conns = new Map<ServerResponse, { user?: User; close: () => void }>();
  const online = () => {
    const seen = new Map<string, User>();
    for (const { user } of conns.values()) if (user) seen.set(user.id, user);
    return [...seen.values()].map(({ id, displayName, role }) => ({ id, displayName, role }));
  };
  const broadcast = () => {
    const frame = `data: ${JSON.stringify({ type: "presence", online: online() })}\n\n`;
    for (const res of conns.keys()) res.write(frame);
  };
  return {
    add(res: ServerResponse, user: User | undefined, close: () => void) {
      conns.set(res, { user, close });
      broadcast();
    },
    remove(res: ServerResponse) {
      if (conns.delete(res)) broadcast();
    },
    /** A changed name or role shows up at once. */
    refresh(user: User) {
      for (const conn of conns.values()) if (conn.user?.id === user.id) conn.user = user;
      broadcast();
    },
    /** A removed account (or changed password) loses its live streams. */
    close(userId: string) {
      for (const conn of [...conns.values()]) if (conn.user?.id === userId) conn.close();
    },
    closeAll() {
      for (const conn of [...conns.values()]) conn.close();
    },
    /** Something every open app should hear about that isn't company state. */
    announce(data: unknown) {
      const frame = `data: ${JSON.stringify(data)}\n\n`;
      for (const res of conns.keys()) res.write(frame);
    },
  };
})();
const streams = presence;

function handleEvents(req: IncomingMessage, res: ServerResponse, user?: User) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: "state", state: company.snapshot() });
  const unsubscribe = company.subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unsubscribe();
    presence.remove(res);
    res.end();
  };
  presence.add(res, user, close);
  req.on("close", close);
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

/** Browsers send Origin on cross-site requests; a change from another site is refused. */
function crossSite(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);

  const user = auth.enabled ? auth.verify(readCookie(req.headers.cookie, SESSION_COOKIE)) : undefined;
  const needLogin = () => sendJSON(res, 401, { error: "로그인이 필요합니다.", login: true });

  if (url.pathname === "/api/events" && method === "GET") {
    if (auth.enabled && !user) return needLogin();
    return handleEvents(req, res, user);
  }
  if (method !== "GET" && crossSite(req)) return sendJSON(res, 403, { error: "다른 사이트에서 온 요청은 받지 않습니다." });

  for (const r of routes) {
    const match = r.method === method && url.pathname.match(r.pattern);
    if (!match) continue;
    try {
      if (auth.enabled && r.access !== "public") {
        if (!user) return needLogin();
        if (!atLeast(user.role, r.access)) {
          const why = user.role === "viewer" ? "보기 전용 계정은 바꿀 수 없습니다." : "소유자만 할 수 있습니다.";
          return sendJSON(res, 403, { error: why });
        }
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      const body = method === "GET" ? {} : await readBody(req);
      const result = await company.as(actorOf(user), () => r.handler({ params, body, user, req, res }));
      sendJSON(res, 200, result);
    } catch (err) {
      if (err instanceof EngineError || err instanceof AuthError) return sendJSON(res, err.status, { error: err.message });
      console.error(err);
      sendJSON(res, 500, { error: "서버 오류가 발생했습니다." });
    }
    return;
  }
  sendJSON(res, 404, { error: "Not found" });
});

const stopHermesSync = company.startHermesSync(Number(process.env.COMPANYAI_HERMES_SYNC_MS ?? 15_000));

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ${PORT}번 포트를 다른 프로그램이 쓰고 있습니다. 다른 번호로 켜 주세요 (예: PORT=8788 npm start).\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`CompanyAI engine listening on http://localhost:${PORT}`);
  console.log(`  LLM provider: ${company.provider}${company.provider === "mock" ? " (set ANTHROPIC_API_KEY to use Claude)" : ""}`);
  console.log(`  Data file:    ${DATA_FILE}`);
  console.log(`  Login:        ${auth.enabled ? `on (${auth.users().length} accounts)` : "off - create an owner account in the app to turn it on"}`);
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
