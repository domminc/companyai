/**
 * The Cloudflare Worker. The whole company lives in one Durable Object: it holds the running
 * engine (tasks in progress, meetings, who is online) in memory, and saves everything to Neon
 * Postgres through Hyperdrive. Files go to R2. The browser app is served from static assets.
 *
 * A Durable Object can be evicted when it is idle, so nothing is kept only in memory: every change
 * is written to Postgres, and work that was running when the object was stopped is put back in the
 * queue when it wakes up. While work is running an alarm keeps ticking so it is not stopped.
 */
import { DurableObject } from "cloudflare:workers";
import { Company } from "../engine/company";
import { createApp, type App } from "../server/app";
import { AuthStore } from "../server/auth";
import { chooseLLM, claudeEnvFrom } from "../server/claude";
import { createCipher, derivedSecret } from "../server/crypto";
import { createDb } from "../server/db";
import { migrate } from "../server/migrations";
import { PgPersistence, PostgresStore } from "../server/pg-store";
import { SettingsStore } from "../server/settings";
import { R2FileStore } from "./files-r2";

export interface Env {
  ASSETS: Fetcher;
  COMPANY: DurableObjectNamespace<CompanyDO>;
  HYPERDRIVE: Hyperdrive;
  FILES: R2Bucket;
  /** Encrypts the saved Claude key and signs login sessions. Required. */
  APP_SECRET?: string;
  /** Locks a fresh deployment until the owner account is made with this token. Required. */
  SETUP_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  COMPANYAI_PROVIDER?: string;
}

const TICK_MS = 30_000;

class SetupError extends Error {}

export class CompanyDO extends DurableObject<Env> {
  private ready?: Promise<{ app: App; company: Company }>;

  /** Opens the database and the engine on first use. A failure (bad config) is retried on the next request. */
  private start() {
    this.ready ??= this.init().catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async init() {
    const { env } = this;
    const secret = env.APP_SECRET?.trim();
    if (!secret || secret.length < 16) throw new SetupError("APP_SECRET이 설정되지 않았습니다 (16자 이상의 긴 임의 문자열이 필요합니다).");
    if (!env.SETUP_TOKEN?.trim() || env.SETUP_TOKEN.trim().length < 8) throw new SetupError("SETUP_TOKEN이 설정되지 않았습니다 (8자 이상).");
    if (!env.HYPERDRIVE) throw new SetupError("Hyperdrive 연결이 설정되지 않았습니다.");
    if (!env.FILES) throw new SetupError("R2 버킷(FILES)이 연결되지 않았습니다.");

    const db = createDb(env.HYPERDRIVE.connectionString, { pool: false });
    await migrate(db);
    const claude = claudeEnvFrom({ ...env } as unknown as Record<string, string | undefined>);
    const settings = await SettingsStore.open(new PgPersistence(db, "settings"), await createCipher(secret, "settings"));
    const auth = await AuthStore.open(new PgPersistence(db, "auth"), { signingSecret: await derivedSecret(secret, "session") });
    const files = new R2FileStore(env.FILES);
    const company = await Company.open({ llm: chooseLLM(claude, settings), store: new PostgresStore(db), files });
    const app = createApp({ runtime: "workers", company, auth, settings, claude, files, setupToken: env.SETUP_TOKEN.trim() });
    return { app, company };
  }

  async fetch(req: Request): Promise<Response> {
    let ctx: { app: App; company: Company };
    try {
      ctx = await this.start();
    } catch (err) {
      const message = err instanceof SetupError ? err.message : "서버를 시작하지 못했습니다. 데이터베이스 연결을 확인하세요.";
      if (!(err instanceof SetupError)) console.error(err);
      return Response.json({ error: message }, { status: 503 });
    }
    try {
      return await ctx.app.fetch(req);
    } finally {
      await this.tick(ctx);
    }
  }

  /** Keeps the object awake while there is work, and polls Hermes for what its employees are doing. */
  private async tick({ company, app }: { company: Company; app: App }) {
    const watching = app.presence.count > 0;
    if (company.busy || watching) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async alarm() {
    let ctx: { app: App; company: Company };
    try {
      ctx = await this.start();
    } catch {
      return;
    }
    if (ctx.company.hasGateways) await ctx.company.syncHermesWork().catch(() => {});
    await this.tick(ctx);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    // Only Cloudflare may say who is calling; anything the browser sent under this name is dropped.
    const headers = new Headers(req.headers);
    headers.set("x-companyai-client-ip", req.headers.get("cf-connecting-ip") ?? "?");
    const forwarded = new Request(req, { headers });
    return env.COMPANY.get(env.COMPANY.idFromName("company")).fetch(forwarded);
  },
};
