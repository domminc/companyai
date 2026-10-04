import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AutostartEnv, disable, enable, LABEL, plistPath, renderPlist, status } from "./autostart";

async function setup(over: Partial<AutostartEnv> = {}, launchctl: (args: string[]) => { code: number; output?: string } = () => ({ code: 0 })) {
  const home = await mkdtemp(join(tmpdir(), "companyai-as-"));
  const launcher = join(home, "CompanyAI & Co", "CompanyAI.command");
  await mkdir(join(home, "CompanyAI & Co"), { recursive: true });
  await writeFile(launcher, "#!/bin/bash\n");
  const calls: string[][] = [];
  const env: AutostartEnv = {
    platform: "darwin",
    home,
    uid: 501,
    launcher,
    runner: async (cmd, args) => {
      assert.equal(cmd, "launchctl");
      calls.push(args);
      const r = launchctl(args);
      return { code: r.code, output: r.output ?? "" };
    },
    ...over,
  };
  return { env, calls, home, launcher };
}

test("the job runs the installed launcher under caffeinate, quietly, and only restarts after a crash", async () => {
  const { launcher } = await setup();
  const plist = renderPlist(launcher);
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-i<\/string>\s*<string>\/bin\/bash<\/string>/);
  assert.match(plist, /CompanyAI &amp; Co/, "paths are XML-escaped");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /COMPANYAI_NO_BROWSER<\/key>\s*<string>1/);
});

test("turning it on writes the plist, reloads the job and reports it enabled", async () => {
  let loaded = false;
  const { env, calls, home } = await setup({}, (args) => {
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "print") return { code: loaded ? 0 : 113 };
    return { code: 0 };
  });
  assert.equal((await status(env)).enabled, false);
  const result = await enable(env);
  assert.equal(result.enabled, true);
  assert.ok(result.logFile?.endsWith("logs/server.log"));
  assert.match(await readFile(plistPath(home), "utf8"), /caffeinate/);
  const verbs = calls.map((c) => c[0]);
  assert.ok(verbs.indexOf("bootout") < verbs.indexOf("bootstrap"), "reloads from scratch");
  assert.deepEqual(calls.find((c) => c[0] === "bootstrap"), ["bootstrap", "gui/501", plistPath(home)]);
  assert.deepEqual(calls.find((c) => c[0] === "enable"), ["enable", `gui/501/${LABEL}`]);
});

test("turning it off unloads the job and removes the plist", async () => {
  let loaded = true;
  const { env, home } = await setup({}, (args) => {
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "print") return { code: loaded ? 0 : 113 };
    return { code: 0 };
  });
  await enable(env);
  loaded = true;
  const result = await disable(env);
  assert.equal(result.enabled, false);
  await assert.rejects(stat(plistPath(home)));
});

test("a launchctl refusal leaves nothing behind and says why", async () => {
  const { env, home } = await setup({}, (args) => (args[0] === "bootstrap" ? { code: 5, output: "Bootstrap failed: 5: Input/output error" } : { code: 0 }));
  await assert.rejects(enable(env), /Input\/output error/);
  await assert.rejects(stat(plistPath(home)));
});

test("not offered on other systems or for a copy that wasn't installed by the installer", async () => {
  const linux = await setup({ platform: "linux" });
  const s1 = await status(linux.env);
  assert.equal(s1.supported, false);
  assert.match(s1.reason ?? "", /Mac/);
  await assert.rejects(enable(linux.env));
  const dev = await setup({ launcher: undefined });
  assert.equal((await status(dev.env)).supported, false);
  await assert.rejects(enable(dev.env), /설치/);
  assert.equal(linux.calls.length + dev.calls.length, 0, "launchctl is never touched");
});
