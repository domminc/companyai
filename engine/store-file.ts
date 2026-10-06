import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "./store";
import type { CompanyState } from "./types";

export class JsonFileStore implements Store {
  constructor(private path: string) {}

  async load(): Promise<CompanyState | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as CompanyState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(state: CompanyState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a half-written file.
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.path);
  }
}
