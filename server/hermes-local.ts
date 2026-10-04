/**
 * Finds the Hermes Agent running on this same computer, so the owner connects it with one click
 * instead of copying a URL and key. The key is read from Hermes' own `.env` on the server and
 * never sent to the browser.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LocalHermes {
  /** Hermes' API server is configured on this computer (a key exists). */
  found: boolean;
  url?: string;
  /** It answered with that key. */
  reachable: boolean;
  /** The DeskRPG plugin (kanban, cron) answered. */
  plugin: boolean;
}

export interface LocalHermesWithKey extends LocalHermes {
  key?: string;
}

export function hermesHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.HERMES_HOME?.trim() || join(home, ".hermes");
}

/** KEY=VALUE lines of a .env file: comments, blank lines and one level of quotes handled. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(["'])(.*)\1/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

/** Where the API server listens: always a loopback address, because this is for the same computer. */
export function localUrl(config: Record<string, string>): string {
  const port = Number(config.API_SERVER_PORT) || 8642;
  return `http://127.0.0.1:${port}`;
}

export async function discoverLocalHermes(opts: {
  home: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<LocalHermesWithKey> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let config: Record<string, string>;
  try {
    config = parseEnv(await readFile(join(hermesHome(env, opts.home), ".env"), "utf8"));
  } catch {
    return { found: false, reachable: false, plugin: false };
  }
  const key = config.API_SERVER_KEY;
  const enabled = !/^(false|0|no|off)$/i.test(config.API_SERVER_ENABLED ?? "true");
  if (!key || !enabled) return { found: false, reachable: false, plugin: false };

  const url = localUrl(config);
  const get = async (path: string) => {
    try {
      const res = await fetchImpl(`${url}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2500) });
      return res.ok;
    } catch {
      return false;
    }
  };
  const reachable = await get("/v1/capabilities");
  return { found: true, url, key, reachable, plugin: reachable && (await get("/deskrpg/info")) };
}

/** Same gateway, whichever way its address is spelled. */
export function sameGateway(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      const host = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(x.hostname) ? "local" : x.hostname;
      return `${host}:${x.port || (x.protocol === "https:" ? "443" : "80")}`;
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
}
