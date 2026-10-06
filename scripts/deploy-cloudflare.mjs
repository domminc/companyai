#!/usr/bin/env node
/**
 * Puts CompanyAI on Cloudflare in one command. Safe to run again (it updates what exists).
 *
 *   npm run cf:deploy
 *
 * It asks for the three values it needs (the token is typed hidden and never saved to disk). To skip
 * the questions, set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and NEON_DATABASE_URL beforehand.
 * Works on Mac, Linux and Windows (needs Node.js 22).
 *
 * It creates the R2 bucket for files and a Hyperdrive config for your Neon database (caching off,
 * because the app writes and reads its own data), builds the UI, and deploys the Worker.
 * First deploy only: APP_SECRET (encrypts the stored Claude key, signs logins) and SETUP_TOKEN
 * (needed to create the owner account) are generated if you don't provide them, and SETUP_TOKEN is
 * printed once. They are never rotated by later deploys.
 * Optional: ANTHROPIC_API_KEY (or enter the key later inside the app), WORKER_NAME (default "companyai").
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const name = (env.WORKER_NAME || "companyai").trim();
const bucket = `${name}-files`;
const hyperdriveName = `${name}-db`;
const dryRun = process.argv.includes("--dry-run");
const CONFIG = join(ROOT, "wrangler.deploy.jsonc");
const SECRETS = join(ROOT, ".wrangler-secrets.json");

const WIN = process.platform === "win32";

/** Asks on the terminal; `hidden` keeps what is typed off the screen. */
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => rl.output.write(text.startsWith(question) ? text : "");
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) console.log();
      resolve(answer.trim());
    });
  });
}

async function need(key, question, hidden, hint) {
  if (env[key]) return;
  if (!process.stdin.isTTY) fail(`${key} 가 필요합니다. ${hint}`);
  console.log(`\n${hint}`);
  env[key] = await ask(`${question}: `, hidden);
  if (!env[key]) fail(`${key} 값이 비어 있습니다.`);
}

const say = (m) => console.log(`\n▶ ${m}`);
function fail(m) {
  console.error(`\n✖ ${m}\n`);
  process.exit(1);
}

function wrangler(args, { allowFail = false, quiet = false } = {}) {
  const r = spawnSync("npx", ["--no-install", "wrangler", ...args], { cwd: ROOT, encoding: "utf8", shell: WIN, env: { ...env, CI: env.CI ?? "1" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!quiet && out.trim()) console.log(out.trim().split("\n").filter((l) => !/Proxy environment variables/.test(l)).join("\n"));
  if (r.status !== 0 && !allowFail) fail(`wrangler ${args.slice(0, 3).join(" ")} 실패`);
  return { ok: r.status === 0, out };
}

// ------------------------------------------------------------------ checks
if (!dryRun) {
  await need("CLOUDFLARE_API_TOKEN", "Cloudflare API 토큰 (입력해도 화면에 안 보입니다)", true, "Cloudflare 대시보드 → My Profile → API Tokens 에서 만든 토큰 (Workers·R2·Hyperdrive 편집 권한).");
  await need("CLOUDFLARE_ACCOUNT_ID", "Cloudflare 계정 ID (32자리)", false, "계정 ID: dash.cloudflare.com 에 로그인했을 때 주소창의 /dash.cloudflare.com/ 바로 뒤 32글자.");
  await need("NEON_DATABASE_URL", "Neon 연결 주소 (postgresql://…)", true, "Neon 프로젝트 → Connect → 'Connection pooling' 을 끄고 나온 postgresql://… 주소 전체.");
}
const neonUrl = (env.NEON_DATABASE_URL || "").trim();
if (!dryRun && !/^postgres(ql)?:\/\//.test(neonUrl)) fail("NEON_DATABASE_URL 은 postgresql:// 로 시작하는 주소여야 합니다.");
if (/-pooler\./.test(neonUrl)) {
  console.warn("! 주소에 -pooler 가 들어 있습니다. Hyperdrive 가 이미 연결 풀을 관리하므로 Neon 의 직접(Direct) 연결 주소를 쓰는 편이 안전합니다.");
}

// ------------------------------------------------------------------ R2 + Hyperdrive
let hyperdriveId = "00000000000000000000000000000000";
if (!dryRun) {
  say(`R2 버킷 "${bucket}" 준비`);
  const buckets = wrangler(["r2", "bucket", "list"], { quiet: true }).out;
  if (new RegExp(`name:\\s*${bucket}\\s*$`, "m").test(buckets)) console.log("이미 있습니다.");
  else {
    const made = wrangler(["r2", "bucket", "create", bucket], { allowFail: true });
    if (!made.ok && !/already exists/i.test(made.out)) fail("R2 버킷을 만들지 못했습니다. R2 를 처음 쓰신다면 Cloudflare 대시보드 → R2 에서 먼저 사용 설정(결제 수단 등록)을 해 주세요.");
  }

  say(`Hyperdrive "${hyperdriveName}" 준비 (Neon 연결, 캐시 끔)`);
  const listing = wrangler(["hyperdrive", "list"], { quiet: true }).out;
  const row = listing.split("\n").find((l) => l.includes(hyperdriveName));
  const existing = row?.match(/[0-9a-f]{32}/)?.[0] ?? listing.match(new RegExp(`id:\\s*([0-9a-f]{32})[\\s\\S]{0,200}?name:\\s*${hyperdriveName}`))?.[1];
  if (existing) {
    wrangler(["hyperdrive", "update", existing, "--connection-string", neonUrl, "--caching-disabled"], { quiet: true });
    hyperdriveId = existing;
    console.log(`기존 설정을 갱신했습니다 (${existing}).`);
  } else {
    const created = wrangler(["hyperdrive", "create", hyperdriveName, "--connection-string", neonUrl, "--caching-disabled"], { quiet: true });
    const id = created.out.match(/[0-9a-f]{32}/)?.[0];
    if (!id) fail(`Hyperdrive 를 만들었는데 id 를 읽지 못했습니다:\n${created.out}`);
    hyperdriveId = id;
    console.log(`만들었습니다 (${id}).`);
  }
}

// ------------------------------------------------------------------ config for this account
say("배포 설정 만들기");
const template = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
const deployConfig = template
  .replace(/("name":\s*)"companyai"/, `$1"${name}"`)
  .replace(/"id":\s*"0{32}"/, `"id": "${hyperdriveId}"`)
  .replace(/"bucket_name":\s*"companyai-files"/, `"bucket_name": "${bucket}"`);
writeFileSync(CONFIG, deployConfig);

// ------------------------------------------------------------------ secrets (only the ones missing)
say("비밀 값 확인");
const existingSecrets = new Set();
if (!dryRun) {
  const listed = wrangler(["secret", "list", "--config", CONFIG, "--format", "json"], { allowFail: true, quiet: true });
  if (listed.ok) {
    try {
      for (const s of JSON.parse(listed.out.slice(listed.out.indexOf("[")))) existingSecrets.add(s.name);
    } catch {}
  }
}
const secrets = {};
const fresh = [];
for (const key of ["APP_SECRET", "SETUP_TOKEN"]) {
  if (env[key]) secrets[key] = env[key];
  else if (!existingSecrets.has(key)) {
    if (env.CI === "true" && !dryRun) fail(`${key} 가 없습니다. GitHub 저장소 Secrets 에 ${key} 를 추가해 주세요 (APP_SECRET: 긴 임의 문자열, SETUP_TOKEN: 소유자 계정을 만들 때 쓸 코드).`);
    secrets[key] = randomBytes(24).toString("base64url");
    fresh.push(key);
  }
}
if (env.ANTHROPIC_API_KEY) secrets.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
console.log(Object.keys(secrets).length ? `올릴 비밀 값: ${Object.keys(secrets).join(", ")}` : "새로 올릴 비밀 값 없음 (기존 값 유지)");

// ------------------------------------------------------------------ build + deploy
say("화면(UI) 빌드");
const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: WIN });
if (build.status !== 0) fail("빌드 실패");

say(dryRun ? "배포 모의 실행" : "Worker 배포");
const args = ["deploy", "--config", CONFIG];
if (dryRun) args.push("--dry-run");
if (Object.keys(secrets).length && !dryRun) {
  writeFileSync(SECRETS, JSON.stringify(secrets), { mode: 0o600 });
  args.push("--secrets-file", SECRETS);
}
try {
  const out = wrangler(args).out;
  const url = out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  if (!dryRun) {
    console.log("\n✅ 배포 완료");
    if (url) console.log(`   주소: ${url}`);
    if (fresh.includes("SETUP_TOKEN")) {
      console.log(`\n   설정 코드(SETUP_TOKEN): ${secrets.SETUP_TOKEN}`);
      console.log("   → 위 주소를 열면 '소유자 계정 만들기' 화면이 나옵니다. 이 코드를 한 번 입력하면 됩니다. 지금 복사해 두세요 (다시 보여드리지 않습니다).");
    } else {
      console.log("   처음 열면 소유자 계정을 만들어야 합니다 (SETUP_TOKEN 이 필요합니다).");
    }
  }
} finally {
  rmSync(SECRETS, { force: true });
}
