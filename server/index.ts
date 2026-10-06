/** The Node server: for a Mac (or any computer). The Cloudflare version is in worker/. */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { Company } from "../engine/company";
import { JsonFileStore } from "../engine/store-file";
import { createApp } from "./app";
import { AuthStore } from "./auth";
import { chooseLLM, claudeEnvFrom } from "./claude";
import { LocalFileStore } from "./files-local";
import { localRoutes } from "./local-routes";
import { SettingsStore } from "./settings";

try {
  process.loadEnvFile();
} catch {
  // no .env file - fine
}

const PORT = Number(process.env.PORT ?? 8787);
const DATA_FILE = resolve(process.env.COMPANYAI_DATA ?? "data/company.json");
const DATA_DIR = dirname(DATA_FILE);
const STATIC_DIR = resolve("dist");

const claude = claudeEnvFrom(process.env);
const settings = await SettingsStore.openFile(join(DATA_DIR, "settings.json"));
const auth = await AuthStore.openFile(process.env.COMPANYAI_AUTH ?? join(DATA_DIR, "auth.json"));
const files = new LocalFileStore(join(DATA_DIR, "files"));
const company = await Company.open({ llm: chooseLLM(claude, settings), store: new JsonFileStore(DATA_FILE), files });

const app = createApp({
  runtime: "node",
  company,
  auth,
  settings,
  claude,
  files,
  extraRoutes: localRoutes,
  features: { autostart: true, localHermes: true },
});

// ------------------------------------------------------------- Node <-> Web

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === "x-companyai-client-ip") continue; // only the adapter may say who is calling
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  headers.set("x-companyai-client-ip", req.socket.remoteAddress ?? "?");
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method,
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  res.flushHeaders();
  const reader = response.body.getReader();
  // A browser that goes away cancels the stream, which lets the app clean up its subscription.
  res.on("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once("drain", r));
    }
  } catch {
    // cancelled
  }
  res.end();
}

// ------------------------------------------------------------------ static

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(pathname: string, res: ServerResponse) {
  if (!existsSync(STATIC_DIR)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("UI가 빌드되지 않았습니다. 개발 중에는 `npm run dev`로 http://localhost:5173 을 여세요.");
    return;
  }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(STATIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(STATIC_DIR, "index.html"); // SPA fallback
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (!path.startsWith("/api/")) return serveStatic(path, res);
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    await send(res, await app.fetch(toRequest(req, abort.signal)));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "서버 오류가 발생했습니다." }));
  }
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
