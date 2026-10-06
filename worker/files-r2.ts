import type { FileStore } from "../engine/files";

/** Files in a Cloudflare R2 bucket, through the Worker's binding. */
export class R2FileStore implements FileStore {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, data: Uint8Array, opts: { contentType: string }) {
    await this.bucket.put(key, data, { httpMetadata: { contentType: opts.contentType } });
  }

  async get(key: string) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { data: new Uint8Array(await obj.arrayBuffer()), contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
  }

  async delete(keys: string | string[]) {
    await this.bucket.delete(keys);
  }
}
