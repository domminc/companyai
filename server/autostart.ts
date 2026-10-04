/**
 * Start CompanyAI when the Mac user logs in, and keep it up: a launchd LaunchAgent that the owner
 * switches on and off from the app. Only for the copy the Mac installer made (it tells us which
 * launcher script to run through COMPANYAI_LAUNCHER); a developer's `npm run dev` is left alone.
 *
 * The job runs under `caffeinate -i`, so an idle Mac Mini doesn't sleep while the office is open
 * (the display may still sleep), restarts only after a crash (a clean exit, such as the launcher
 * finding the app already running, stays exited), and doesn't pop a browser open at every login.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LABEL = "com.companyai.app";

export interface Runner {
  (cmd: string, args: string[]): Promise<{ code: number; output: string }>;
}

export const run: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      // A failing exit has a numeric code; "command not found" and timeouts carry a string.
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });

export interface AutostartEnv {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  /** The installed launcher script, from COMPANYAI_LAUNCHER. */
  launcher?: string;
  runner: Runner;
}

export interface AutostartStatus {
  supported: boolean;
  /** Why not, in words for the person using the app. */
  reason?: string;
  enabled: boolean;
  logFile?: string;
}

export class AutostartError extends Error {}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

export function logFileFor(launcher: string) {
  return join(dirname(launcher), "logs", "server.log");
}

export function renderPlist(launcher: string): string {
  const log = logFileFor(launcher);
  const args = ["/usr/bin/caffeinate", "-i", "/bin/bash", launcher];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COMPANYAI_NO_BROWSER</key>
    <string>1</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function unsupported(env: AutostartEnv): string | undefined {
  if (env.platform !== "darwin") return "자동 시작은 Mac에서만 지원합니다.";
  if (!env.launcher) return "설치 프로그램으로 설치한 앱에서만 쓸 수 있습니다. (한 줄 설치 명령을 다시 실행해 보세요)";
  return undefined;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const domain = (env: AutostartEnv) => `gui/${env.uid}`;

export async function status(env: AutostartEnv): Promise<AutostartStatus> {
  const reason = unsupported(env);
  if (reason) return { supported: false, reason, enabled: false };
  const loaded = (await env.runner("launchctl", ["print", `${domain(env)}/${LABEL}`])).code === 0;
  const enabled = loaded && (await exists(plistPath(env.home)));
  return { supported: true, enabled, logFile: logFileFor(env.launcher!) };
}

export async function enable(env: AutostartEnv): Promise<AutostartStatus> {
  const reason = unsupported(env);
  if (reason) throw new AutostartError(reason);
  if (!(await exists(env.launcher!))) throw new AutostartError(`실행 파일을 찾을 수 없습니다: ${env.launcher}`);
  const file = plistPath(env.home);
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(logFileFor(env.launcher!)), { recursive: true });
  await writeFile(file, renderPlist(env.launcher!), { mode: 0o644 });
  // Reload from scratch so a changed launcher path takes effect; ignore "not loaded".
  await env.runner("launchctl", ["bootout", `${domain(env)}/${LABEL}`]);
  const boot = await env.runner("launchctl", ["bootstrap", domain(env), file]);
  if (boot.code !== 0) {
    await rm(file, { force: true });
    throw new AutostartError(`자동 시작을 켜지 못했습니다: ${boot.output || `launchctl 종료 코드 ${boot.code}`}`);
  }
  await env.runner("launchctl", ["enable", `${domain(env)}/${LABEL}`]);
  return status(env);
}

export async function disable(env: AutostartEnv): Promise<AutostartStatus> {
  const reason = unsupported(env);
  if (reason) throw new AutostartError(reason);
  await env.runner("launchctl", ["bootout", `${domain(env)}/${LABEL}`]);
  await rm(plistPath(env.home), { force: true });
  return status(env);
}
