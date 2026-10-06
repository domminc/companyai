/**
 * Optional login. With no accounts the app is open, as a single-person tool. Creating the owner
 * account turns login on for everyone; the owner can then add members and read-only viewers.
 *
 * Accounts live next to the company data in `auth.json` (0600): scrypt password hashes and the
 * HMAC secret that signs session cookies. Sessions are stateless signed tokens that carry the
 * account's session version, so a password change or removal signs every device out.
 */
import { createHmac, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { FilePersistence, type Persistence } from "./persistence";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type Role = "owner" | "member" | "viewer";
export const ROLES: Role[] = ["owner", "member", "viewer"];
const RANK: Record<Role, number> = { viewer: 0, member: 1, owner: 2 };

export function atLeast(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  sessionVersion: number;
  createdAt: string;
}

export type User = Omit<StoredUser, "passwordHash" | "sessionVersion">;

export interface AuthFile {
  secret: string;
  users: StoredUser[];
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const SESSION_COOKIE = "companyai_session";
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

function publicUser({ passwordHash, sessionVersion, ...user }: StoredUser): User {
  void passwordHash;
  void sessionVersion;
  return user;
}

const randomBytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${hex(salt)}$${hex(hash)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Stands in for a missing account's hash so a failed lookup costs the same as a wrong password. */
const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;

function validUsername(username: unknown): string {
  const u = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(u)) throw new AuthError("아이디는 영문 소문자·숫자·_.- 2~32자여야 합니다.");
  return u;
}

function validPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new AuthError(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`);
  return password;
}

function validRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) throw new AuthError("역할은 owner, member, viewer 중 하나입니다.");
  return role as Role;
}

export class AuthStore {
  private constructor(
    private persistence: Persistence<AuthFile>,
    private data: AuthFile,
    /** A secret from the environment signs sessions instead of the stored one. */
    private signingSecret?: string,
  ) {}

  static async open(persistence: Persistence<AuthFile>, opts: { signingSecret?: string } = {}): Promise<AuthStore> {
    const data = await persistence.load();
    if (data && (!data.secret || !Array.isArray(data.users))) throw new Error("계정 데이터가 올바르지 않습니다.");
    return new AuthStore(persistence, data ?? { secret: randomBytes(32).toString("hex"), users: [] }, opts.signingSecret);
  }

  static openFile(file: string, opts: { signingSecret?: string } = {}): Promise<AuthStore> {
    return AuthStore.open(new FilePersistence<AuthFile>(file), opts);
  }

  /** Login is required once any account exists. */
  get enabled(): boolean {
    return this.data.users.length > 0;
  }

  users(): User[] {
    return this.data.users.map(publicUser);
  }

  get(id: string): User | undefined {
    const user = this.data.users.find((u) => u.id === id);
    return user && publicUser(user);
  }

  private save() {
    return this.persistence.save(this.data);
  }

  /** The first account: the owner. Only while there are none. */
  async setup(input: { username: unknown; password: unknown; displayName?: unknown }): Promise<User> {
    if (this.enabled) throw new AuthError("이미 소유자 계정이 있습니다.", 409);
    return this.create({ ...input, role: "owner" });
  }

  async create(input: { username: unknown; password: unknown; displayName?: unknown; role: unknown }): Promise<User> {
    const username = validUsername(input.username);
    const password = validPassword(input.password);
    const role = validRole(input.role);
    if (this.data.users.some((u) => u.username === username)) throw new AuthError("이미 있는 아이디입니다.", 409);
    const displayName = (typeof input.displayName === "string" && input.displayName.trim()) || username;
    const user: StoredUser = {
      id: `usr_${randomUUID().slice(0, 10)}`,
      username,
      displayName: displayName.slice(0, 40),
      role,
      passwordHash: await hashPassword(password),
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    await this.save();
    return publicUser(user);
  }

  async login(username: unknown, password: unknown): Promise<User> {
    const name = typeof username === "string" ? username.trim().toLowerCase() : "";
    const user = this.data.users.find((u) => u.username === name);
    // Hash even for unknown names so timing doesn't reveal which accounts exist.
    const ok = await verifyPassword(typeof password === "string" ? password : "", user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new AuthError("아이디 또는 비밀번호가 올바르지 않습니다.", 401);
    return publicUser(user);
  }

  async update(id: string, patch: { displayName?: unknown; password?: unknown; role?: unknown }): Promise<User> {
    const user = this.data.users.find((u) => u.id === id);
    if (!user) throw new AuthError("계정을 찾을 수 없습니다.", 404);
    if (patch.role !== undefined) {
      const role = validRole(patch.role);
      if (user.role === "owner" && role !== "owner" && this.owners() === 1) throw new AuthError("마지막 소유자의 역할은 바꿀 수 없습니다.", 409);
      user.role = role;
    }
    if (typeof patch.displayName === "string" && patch.displayName.trim()) user.displayName = patch.displayName.trim().slice(0, 40);
    if (patch.password !== undefined) {
      user.passwordHash = await hashPassword(validPassword(patch.password));
      user.sessionVersion += 1; // sign out everywhere
    }
    await this.save();
    return publicUser(user);
  }

  async remove(id: string): Promise<void> {
    const user = this.data.users.find((u) => u.id === id);
    if (!user) throw new AuthError("계정을 찾을 수 없습니다.", 404);
    if (user.role === "owner" && this.owners() === 1 && this.data.users.length > 1) {
      throw new AuthError("다른 계정이 남아 있으면 마지막 소유자는 지울 수 없습니다. 로그인 끄기를 쓰세요.", 409);
    }
    this.data.users = this.data.users.filter((u) => u !== user);
    await this.save();
  }

  /** Back to the open, single-person mode: every account goes. The owner's password confirms it. */
  async disable(ownerId: string, password: unknown): Promise<void> {
    const owner = this.data.users.find((u) => u.id === ownerId);
    if (!owner || owner.role !== "owner") throw new AuthError("소유자만 로그인을 끌 수 있습니다.", 403);
    if (!(await verifyPassword(typeof password === "string" ? password : "", owner.passwordHash))) {
      throw new AuthError("비밀번호가 올바르지 않습니다.", 401);
    }
    this.data.users = [];
    this.data.secret = randomBytes(32).toString("hex"); // old cookies die with it
    await this.save();
  }

  private owners() {
    return this.data.users.filter((u) => u.role === "owner").length;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingSecret ?? this.data.secret).update(payload).digest("base64url");
  }

  /** A signed session token: `<userId>.<sessionVersion>.<expires>.<mac>`. */
  issue(userId: string): { token: string; maxAge: number } {
    const user = this.data.users.find((u) => u.id === userId);
    if (!user) throw new AuthError("계정을 찾을 수 없습니다.", 404);
    const maxAge = SESSION_DAYS * 86400;
    const payload = `${user.id}.${user.sessionVersion}.${Math.floor(Date.now() / 1000) + maxAge}`;
    return { token: `${payload}.${this.sign(payload)}`, maxAge };
  }

  verify(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const parts = token.split(".");
    if (parts.length !== 4) return undefined;
    const [id, version, expires, mac] = parts;
    const expected = Buffer.from(this.sign(`${id}.${version}.${expires}`));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    if (Number(expires) * 1000 < Date.now()) return undefined;
    const user = this.data.users.find((u) => u.id === id);
    if (!user || String(user.sessionVersion) !== version) return undefined;
    return publicUser(user);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Slows password guessing: at most `limit` failures per key in `windowMs`. */
export class FailureLimiter {
  private failures = new Map<string, number[]>();
  constructor(
    private limit = 10,
    private windowMs = 10 * 60_000,
  ) {}

  check(key: string) {
    const recent = (this.failures.get(key) ?? []).filter((t) => Date.now() - t < this.windowMs);
    this.failures.set(key, recent);
    if (recent.length >= this.limit) throw new AuthError("로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.", 429);
  }

  fail(key: string) {
    this.failures.set(key, [...(this.failures.get(key) ?? []), Date.now()]);
  }

  reset(key: string) {
    this.failures.delete(key);
  }
}
