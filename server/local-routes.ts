/** Routes that only make sense on the Mac running the Node server: auto-start and the Hermes on this computer. */
import { homedir } from "node:os";
import { EngineError } from "../engine/company";
import type { AppContext, Router } from "./app";
import { AutostartError, disable as disableAutostart, enable as enableAutostart, run as runCommand, status as autostartStatus } from "./autostart";
import { discoverLocalHermes, sameGateway } from "./hermes-local";

export function localRoutes(router: Router, { company }: AppContext) {
  router.add(
    "GET",
    "/api/hermes/local",
    async () => {
      const { key: _key, ...local } = await discoverLocalHermes({ home: homedir() });
      const connected = !!local.url && company.snapshot().gateways.some((g) => sameGateway(g.url, local.url!));
      return { ...local, connected };
    },
    "owner",
  );
  router.add(
    "POST",
    "/api/hermes/local/connect",
    async () => {
      const local = await discoverLocalHermes({ home: homedir() });
      if (!local.found || !local.url || !local.key) {
        throw new EngineError("이 컴퓨터에서 설정된 Hermes를 찾지 못했습니다. 설치 명령을 먼저 실행해 주세요.", 404);
      }
      const existing = company.snapshot().gateways.find((g) => sameGateway(g.url, local.url!));
      if (existing) return existing;
      return company.addGateway({ name: "이 컴퓨터의 Hermes", url: local.url, apiKey: local.key });
    },
    "owner",
  );

  const env = () => ({
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    launcher: process.env.COMPANYAI_LAUNCHER,
    runner: runCommand,
  });
  const guard = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AutostartError) throw new EngineError(err.message, 409);
      throw err;
    }
  };
  router.add("GET", "/api/settings/autostart", () => autostartStatus(env()), "owner");
  router.add(
    "PUT",
    "/api/settings/autostart",
    async ({ body }) => {
      const result = await guard(() => (body.enabled ? enableAutostart(env()) : disableAutostart(env())));
      company.note(result.enabled ? "컴퓨터에 로그인하면 CompanyAI가 자동으로 켜지도록 설정했습니다." : "자동 시작을 껐습니다.");
      return result;
    },
    "owner",
  );
}
