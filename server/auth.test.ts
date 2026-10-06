import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atLeast, AuthError, AuthStore, FailureLimiter, readCookie } from "./auth";

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "companyai-auth-"));
  return { file: join(dir, "auth.json"), auth: await AuthStore.openFile(join(dir, "auth.json")) };
}

test("login is off until an owner exists; the owner signs in with a session that survives a restart", async () => {
  const { file, auth } = await store();
  assert.equal(auth.enabled, false);
  const owner = await auth.setup({ username: "Boss", password: "correct horse", displayName: "홍대표" });
  assert.equal(owner.username, "boss");
  assert.equal(owner.role, "owner");
  assert.equal(auth.enabled, true);
  await assert.rejects(auth.setup({ username: "other", password: "12345678" }), AuthError);

  const saved = await readFile(file, "utf8");
  assert.ok(!saved.includes("correct horse"), "only a hash is stored");
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const { token } = auth.issue(owner.id);
  const reopened = await AuthStore.openFile(file);
  assert.equal(reopened.verify(token)?.id, owner.id);
  assert.equal(reopened.verify(token.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), undefined, "tampered token");
  assert.equal(reopened.verify(`${owner.id}.1.1.x`), undefined);
});

test("wrong passwords fail the same way for unknown and known accounts", async () => {
  const { auth } = await store();
  await auth.setup({ username: "boss", password: "correct horse" });
  await assert.rejects(auth.login("boss", "wrong password"), (e: AuthError) => e.status === 401);
  await assert.rejects(auth.login("nobody", "wrong password"), (e: AuthError) => e.status === 401);
  assert.equal((await auth.login("BOSS", "correct horse")).username, "boss");
});

test("members and viewers; a password change signs out old sessions; the last owner is protected", async () => {
  const { auth } = await store();
  const owner = await auth.setup({ username: "boss", password: "correct horse" });
  const member = await auth.create({ username: "kim", password: "password1", displayName: "김팀원", role: "member" });
  const viewer = await auth.create({ username: "lee", password: "password2", role: "viewer" });
  await assert.rejects(auth.create({ username: "kim", password: "password1", role: "member" }), AuthError);
  await assert.rejects(auth.create({ username: "x", password: "password1", role: "member" }), AuthError, "too short");
  await assert.rejects(auth.create({ username: "park", password: "short", role: "member" }), AuthError);
  await assert.rejects(auth.create({ username: "park", password: "password3", role: "admin" }), AuthError);

  const { token } = auth.issue(member.id);
  assert.equal(auth.verify(token)?.displayName, "김팀원");
  await auth.update(member.id, { password: "new password" });
  assert.equal(auth.verify(token), undefined);

  await assert.rejects(auth.update(owner.id, { role: "member" }), AuthError);
  await assert.rejects(auth.remove(owner.id), AuthError);
  await auth.remove(viewer.id);
  assert.deepEqual(auth.users().map((u) => u.username), ["boss", "kim"]);

  assert.ok(atLeast("owner", "member") && atLeast("member", "viewer") && !atLeast("viewer", "member"));
});

test("turning login off needs the owner's password and invalidates every cookie", async () => {
  const { auth } = await store();
  const owner = await auth.setup({ username: "boss", password: "correct horse" });
  const { token } = auth.issue(owner.id);
  await assert.rejects(auth.disable(owner.id, "nope"), AuthError);
  await auth.disable(owner.id, "correct horse");
  assert.equal(auth.enabled, false);
  const again = await auth.setup({ username: "boss", password: "correct horse" });
  assert.equal(auth.verify(token), undefined, "an old cookie doesn't come back to life");
  assert.ok(again.id);
});

test("cookie parsing and login throttling", () => {
  assert.equal(readCookie("a=1; companyai_session=x.y%3D; b=2", "companyai_session"), "x.y=");
  const limiter = new FailureLimiter(2, 60_000);
  limiter.check("ip");
  limiter.fail("ip");
  limiter.fail("ip");
  assert.throws(() => limiter.check("ip"), AuthError);
  limiter.reset("ip");
  limiter.check("ip");
});
