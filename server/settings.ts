/**
 * App settings entered in the UI rather than in .env: for now the Anthropic API key, so the app
 * can be switched from demo mode to real Claude without editing files. Kept next to the company
 * data in `settings.json` (0600). A key in the environment always wins.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface SettingsFile {
  anthropicApiKey?: string;
}

export class SettingsStore {
  private constructor(
    private file: string,
    private data: SettingsFile,
  ) {}

  static async open(file: string): Promise<SettingsStore> {
    try {
      return new SettingsStore(file, JSON.parse(await readFile(file, "utf8")) as SettingsFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file}을(를) 읽을 수 없습니다: ${(err as Error).message}`);
      return new SettingsStore(file, {});
    }
  }

  get anthropicApiKey(): string | undefined {
    return this.data.anthropicApiKey;
  }

  async setAnthropicApiKey(key: string | undefined) {
    this.data.anthropicApiKey = key;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/** "sk-ant-…wxyz": enough to recognise a key without revealing it. */
export function keyHint(key: string): string {
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…";
}
