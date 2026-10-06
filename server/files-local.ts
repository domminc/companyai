import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FileStore } from "../engine/files";

/** Files in a folder (with a sidecar for the content type). For a Mac running the Node server. */
export class LocalFileStore implements FileStore {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error("잘못된 파일 경로입니다.");
    return p;
  }

  async put(key: string, data: Uint8Array, opts: { contentType: string }) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    await writeFile(`${p}.type`, opts.contentType);
  }

  async get(key: string) {
    const p = this.path(key);
    try {
      const data = new Uint8Array(await readFile(p));
      const contentType = await readFile(`${p}.type`, "utf8").catch(() => "application/octet-stream");
      return { data, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const p = this.path(key);
      await rm(p, { force: true });
      await rm(`${p}.type`, { force: true });
    }
  }
}
