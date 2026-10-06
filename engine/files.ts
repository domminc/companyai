/**
 * Where uploaded and generated files live. R2 on Cloudflare, a folder on a Mac. The engine only
 * ever sees this small interface.
 */
export interface FileStore {
  put(key: string, data: Uint8Array, opts: { contentType: string }): Promise<void>;
  /** The whole file, or null when it doesn't exist. */
  get(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  delete(keys: string | string[]): Promise<void>;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A name that is safe in a storage key and a download header. */
export function safeName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/\u0000-\u001f"<>|?*:]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 120);
}

/** Text the agents can read right in their prompt. */
export function isTextual(name: string, contentType: string): boolean {
  if (/^text\//.test(contentType)) return true;
  if (/(json|xml|yaml|toml|javascript|typescript|csv|markdown|x-sh|sql)/.test(contentType)) return true;
  return /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|log|html?|css|jsx?|tsx?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql|r|tex|srt|vtt)$/i.test(name);
}

export class MemoryFileStore implements FileStore {
  files = new Map<string, { data: Uint8Array; contentType: string }>();
  async put(key: string, data: Uint8Array, opts: { contentType: string }) {
    this.files.set(key, { data: new Uint8Array(data), contentType: opts.contentType });
  }
  async get(key: string) {
    const f = this.files.get(key);
    return f ? { data: new Uint8Array(f.data), contentType: f.contentType } : null;
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.files.delete(k);
  }
}
