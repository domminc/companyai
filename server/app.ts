/**
 * The CompanyAI HTTP API as a plain `Request -> Response` function, so the same code runs in the
 * Node server on a Mac and inside a Cloudflare Durable Object. Everything that touches the host
 * (disk, the process, static files, launchd) is handed in or lives in the entry points.
 */
import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { type Actor, Company, EngineError } from "../engine/company";
import { AnthropicLLM, AVAILABLE_MODELS, DEFAULT_MODEL, describeError, MockLLM } from "../engine/llm";
import { atLeast, AuthError, type AuthStore, clearedCookie, FailureLimiter, readCookie, type Role, SESSION_COOKIE, sessionCookie, type User } from "./auth";
import { type ClaudeEnv, claudeSource } from "./claude";
import { type FileStore, MAX_FILE_BYTES } from "../engine/files";
import { type Connection, Presence } from "./presence";
import { keyHint, type SettingsStore } from "./settings";

export type Access = Role | "public";

export interface Ctx {
  params: Record<string, string>;
  /** Parsed JSON body ({} for GET, and for routes declared `raw`). */
  body: any;
  /** The signed-in person; undefined while login is off. */
  user?: User;
  req: Request;
  /** Adds a Set-Cookie to the response. */
  setCookie(value: string): void;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface Router {
  add(method: string, path: string, handler: Handler, access?: Access, opts?: { raw?: boolean }): void;
}

/** What differs between hosts. Everything optional here is a feature that host may not have. */
export interface AppDeps {
  runtime: "node" | "workers";
  company: Company;
  auth: AuthStore;
  settings: SettingsStore;
  claude: ClaudeEnv;
  files?: FileStore;
  /** A fresh public deployment stays locked until the owner account exists, which takes this token. */
  setupToken?: string;
  /** Routes only some hosts have (auto-start, the Hermes on this computer). */
  extraRoutes?: (router: Router, app: AppContext) => void;
  features?: { autostart?: boolean; localHermes?: boolean };
}

export interface AppContext {
  company: Company;
  auth: AuthStore;
  presence: Presence;
}

export interface App {
  fetch(req: Request): Promise<Response>;
  presence: Presence;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  access: Access;
  raw: boolean;
}

const json = (status: number, data: unknown, headers?: Headers) => {
  const h = headers ?? new Headers();
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
};

function actorOf(user?: User): Actor | undefined {
  return user && { name: user.displayName, owner: user.role === "owner" };
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Browsers send Origin on cross-site requests; a change from another site is refused. */
function crossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

function clientAddress(req: Request): string {
  return req.headers.get("x-companyai-client-ip") ?? req.headers.get("cf-connecting-ip") ?? "?";
}

function isSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

export function createApp(deps: AppDeps): App {
  const { company, auth, settings, claude, files } = deps;
  const presence = new Presence();
  const loginLimiter = new FailureLimiter();
  const routes: Route[] = [];

  const router: Router = {
    add(method, path, handler, access, opts) {
      const keys: string[] = [];
      const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
      routes.push({ method, pattern, keys, handler, access: access ?? (method === "GET" ? "viewer" : "member"), raw: !!opts?.raw });
    },
  };
  const route = router.add.bind(router);

  const locked = () => !!deps.setupToken && !auth.enabled;

  // ---------------------------------------------------------------- accounts

  const signIn = (ctx: Ctx, user: User) => {
    const { token, maxAge } = auth.issue(user.id);
    ctx.setCookie(sessionCookie(token, maxAge, isSecure(ctx.req)));
  };

  /** Lets the launcher tell this app apart from whatever else might be on the port. */
  route("GET", "/api/health", () => ({ app: "companyai", runtime: deps.runtime }), "public");
  route("GET", "/api/auth/me", ({ user }) => ({ enabled: auth.enabled, user: user ?? null, setupRequired: locked() }), "public");
  route(
    "POST",
    "/api/auth/setup",
    async (ctx) => {
      if (deps.setupToken) {
        const key = `setup:${clientAddress(ctx.req)}`;
        loginLimiter.check(key);
        if (typeof ctx.body.setupToken !== "string" || !sameSecret(ctx.body.setupToken, deps.setupToken)) {
          loginLimiter.fail(key);
          throw new AuthError("설정 코드가 맞지 않습니다. 배포할 때 만든 SETUP_TOKEN을 입력하세요.", 403);
        }
      }
      const user = await auth.setup(ctx.body);
      // Tabs that were open without login lose their stream and land on the login screen.
      presence.closeAll();
      signIn(ctx, user);
      company.as(actorOf(user), () => company.note(`${user.displayName}님이 소유자 계정을 만들어 로그인을 켰습니다.`));
      return { enabled: true, user, setupRequired: false };
    },
    "public",
  );
  route(
    "POST",
    "/api/auth/login",
    async (ctx) => {
      const key = clientAddress(ctx.req);
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
    (ctx) => {
      ctx.setCookie(clearedCookie());
      return { ok: true };
    },
    "public",
  );
  route(
    "POST",
    "/api/auth/disable",
    async (ctx) => {
      if (deps.setupToken) throw new AuthError("공개 배포에서는 로그인을 끌 수 없습니다.", 409);
      if (!ctx.user) throw new AuthError("로그인이 이미 꺼져 있습니다.");
      await auth.disable(ctx.user.id, ctx.body.password);
      ctx.setCookie(clearedCookie());
      company.note(`${ctx.user.displayName}님이 로그인을 껐습니다. 이제 누구나 바로 들어올 수 있습니다.`);
      presence.closeAll();
      return { enabled: false, user: null };
    },
    "owner",
  );
  route(
    "PATCH",
    "/api/auth/me",
    async ({ user, body }) => {
      if (!user) throw new AuthError("로그인이 꺼져 있습니다.");
      const updated = await auth.update(user.id, { displayName: body.displayName, password: body.password });
      presence.refresh(updated);
      return updated;
    },
    "viewer",
  );

  /** Accounts only make sense once there is an owner to manage them. */
  const requireLogin = () => {
    if (!auth.enabled) throw new AuthError("먼저 🔐 로그인 설정에서 소유자 계정을 만드세요.", 409);
  };

  route("GET", "/api/users", () => (requireLogin(), auth.users()), "owner");
  route(
    "POST",
    "/api/users",
    async ({ body }) => {
      requireLogin();
      const created = await auth.create(body);
      company.note(`${created.displayName}님(${created.role})의 계정을 만들었습니다.`);
      return created;
    },
    "owner",
  );
  route(
    "PATCH",
    "/api/users/:id",
    async ({ params, body }) => {
      requireLogin();
      const updated = await auth.update(params.id, body);
      presence.refresh(updated);
      if (body.password !== undefined) presence.close(params.id);
      return updated;
    },
    "owner",
  );
  route(
    "DELETE",
    "/api/users/:id",
    async ({ params, user }) => {
      requireLogin();
      const target = auth.get(params.id);
      await auth.remove(params.id);
      presence.close(params.id);
      if (params.id === user?.id) presence.closeAll();
      if (target) company.note(`${target.displayName}님의 계정을 지웠습니다.`);
      return { ok: true };
    },
    "owner",
  );

  // ------------------------------------------------------------- Claude key

  const claudeStatus = () => {
    const source = claudeSource(claude, settings);
    return { provider: company.provider, source, ...(source === "app" ? { keyHint: keyHint(settings.anthropicApiKey!) } : {}) };
  };

  route("GET", "/api/settings/claude", () => claudeStatus());
  route(
    "PUT",
    "/api/settings/claude",
    async ({ body }) => {
      if (claudeSource(claude, settings) === "env") throw new EngineError("서버 설정(환경 변수)에 있는 키를 쓰고 있습니다. 바꾸려면 그 설정을 고치세요.", 409);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (!apiKey) throw new EngineError("API 키를 입력하세요.");
      if (!settings.canStoreKey) throw new EngineError("서버에 APP_SECRET이 없어서 키를 앱에 저장할 수 없습니다. 서버 설정으로 ANTHROPIC_API_KEY를 넣어 주세요.", 409);
      const client = new Anthropic({ apiKey, baseURL: claude.baseURL });
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
      presence.announce({ type: "provider", provider: company.provider });
      return claudeStatus();
    },
    "owner",
  );
  route(
    "DELETE",
    "/api/settings/claude",
    async () => {
      if (claudeSource(claude, settings) === "env") throw new EngineError("서버 설정(환경 변수)에 있는 키는 앱에서 지울 수 없습니다.", 409);
      await settings.setAnthropicApiKey(undefined);
      company.setLLM(new MockLLM(claude.mockDelayMs));
      company.note("Claude API 키를 지웠습니다. 데모 모드로 돌아갑니다.");
      presence.announce({ type: "provider", provider: company.provider });
      return claudeStatus();
    },
    "owner",
  );

  // -------------------------------------------------------------- the company

  route("GET", "/api/runtime", () => ({
    runtime: deps.runtime,
    features: { autostart: !!deps.features?.autostart, localHermes: !!deps.features?.localHermes, files: !!files },
  }));
  route("GET", "/api/state", () => ({ state: company.snapshot(), provider: company.provider, models: AVAILABLE_MODELS }));
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
  route("POST", "/api/tasks/:id/review", ({ params, body }) => company.reviewTask(params.id, { approve: body.approve === true, comment: body.comment }));

  // Files attached to a task: the browser sends the bytes as the body and the name in the query.
  route(
    "POST",
    "/api/tasks/:id/files",
    async ({ params, req }) => {
      const name = new URL(req.url).searchParams.get("name")?.trim();
      if (!name) throw new EngineError("파일 이름이 필요합니다.");
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > MAX_FILE_BYTES) throw new EngineError(`파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB까지 첨부할 수 있습니다.`, 413);
      const data = new Uint8Array(await req.arrayBuffer());
      return company.addAttachment(params.id, { name, contentType: req.headers.get("content-type") ?? undefined, data });
    },
    "member",
    { raw: true },
  );
  route("GET", "/api/tasks/:id/files/:fileId", async ({ params }) => {
    const { ref, data, contentType } = await company.getAttachment(params.id, params.fileId);
    // Always a download, never rendered from our own origin: an uploaded HTML file must not run as part of the app.
    return new Response(data as unknown as BodyInit, {
      headers: {
        "content-type": contentType,
        "content-length": String(data.byteLength),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  });
  route("DELETE", "/api/tasks/:id/files/:fileId", async ({ params }) => (await company.removeAttachment(params.id, params.fileId), { ok: true }));

  route("POST", "/api/chats/:agentId", ({ params, body }) => company.chat(params.agentId, String(body.content ?? "")));
  route("DELETE", "/api/chats/:agentId", ({ params }) => (company.clearChat(params.agentId), { ok: true }));

  route("POST", "/api/meetings", ({ body }) => company.startMeeting(body));
  route("POST", "/api/meetings/:id/cancel", ({ params }) => company.cancelMeeting(params.id));
  route("POST", "/api/meetings/:id/messages", ({ params, body }) => company.postMeetingMessage(params.id, String(body.content ?? "")));
  route("POST", "/api/meetings/:id/grant", ({ params, body }) => company.grantFloor(params.id, String(body.agentId ?? "")));
  route("POST", "/api/meetings/:id/end", ({ params }) => company.endMeeting(params.id));
  route("POST", "/api/meetings/:id/join", ({ params, body }) => company.joinMeeting(params.id, body.joined !== false));
  route("POST", "/api/meetings/:id/outcome", ({ params, body }) => company.registerOutcome(params.id, body));
  route("POST", "/api/meetings/:id/action-items/:index/promote", ({ params }) => company.promoteActionItem(params.id, Number(params.index)));

  deps.extraRoutes?.(router, { company, auth, presence });

  // ------------------------------------------------------------ live events

  function events(req: Request, user?: User): Response {
    const encoder = new TextEncoder();
    let conn: Connection | undefined;
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (frame: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            cleanup();
          }
        };
        send(`data: ${JSON.stringify({ type: "state", state: company.snapshot() })}\n\n`);
        const unsubscribe = company.subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => send(": ping\n\n"), 20_000);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsubscribe();
          if (conn) presence.remove(conn);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        conn = { user, send, close: cleanup };
        presence.add(conn);
        req.signal.addEventListener("abort", cleanup);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
  }

  // ------------------------------------------------------------- dispatcher

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const user = auth.enabled ? auth.verify(readCookie(req.headers.get("cookie") ?? undefined, SESSION_COOKIE)) : undefined;
    const needLogin = () => json(401, { error: "로그인이 필요합니다.", login: true });
    const needSetup = () => json(403, { error: "처음 설정이 필요합니다.", setup: true });

    if (url.pathname === "/api/events" && method === "GET") {
      if (locked()) return needSetup();
      if (auth.enabled && !user) return needLogin();
      return events(req, user);
    }
    if (method !== "GET" && crossSite(req)) return json(403, { error: "다른 사이트에서 온 요청은 받지 않습니다." });

    for (const r of routes) {
      const match = r.method === method && url.pathname.match(r.pattern);
      if (!match) continue;
      const cookies: string[] = [];
      try {
        if (r.access !== "public") {
          if (locked()) return needSetup();
          if (auth.enabled) {
            if (!user) return needLogin();
            if (!atLeast(user.role, r.access)) {
              return json(403, { error: user.role === "viewer" ? "보기 전용 계정은 바꿀 수 없습니다." : "소유자만 할 수 있습니다." });
            }
          }
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
        let body: any = {};
        if (method !== "GET" && !r.raw) {
          const text = await req.text();
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              throw new EngineError("요청 본문이 올바른 JSON이 아닙니다.");
            }
          }
        }
        const ctx: Ctx = { params, body, user, req, setCookie: (v) => cookies.push(v) };
        const result = await company.as(actorOf(user), () => r.handler(ctx));
        const headers = new Headers();
        for (const c of cookies) headers.append("set-cookie", c);
        if (result instanceof Response) {
          for (const c of cookies) result.headers.append("set-cookie", c);
          return result;
        }
        return json(200, result, headers);
      } catch (err) {
        if (err instanceof EngineError || err instanceof AuthError) return json(err.status, { error: err.message });
        console.error(err);
        return json(500, { error: "서버 오류가 발생했습니다." });
      }
    }
    return json(404, { error: "Not found" });
  }

  return { fetch, presence };
}
