import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Somewhere one JSON document lives: a file on a Mac, a row in Postgres on Cloudflare. */
export interface Persistence<T> {
  load(): Promise<T | undefined>;
  save(value: T): Promise<void>;
}

/** A JSON file, written atomically and readable only by its owner (it may hold password hashes). */
export class FilePersistence<T> implements Persistence<T> {
  constructor(private file: string) {}

  async load(): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`${this.file}을(를) 읽을 수 없습니다: ${(err as Error).message}`);
    }
  }

  async save(value: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/** Only in memory; for tests. */
export class MemoryPersistence<T> implements Persistence<T> {
  value?: T;
  async load() {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  async save(value: T) {
    this.value = structuredClone(value);
  }
}
