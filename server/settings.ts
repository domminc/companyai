/**
 * App settings entered in the UI rather than in .env: for now the Anthropic API key, so the app
 * can be switched from demo mode to real Claude without editing files. Stored through a
 * Persistence (a file next to the company data on a Mac, a row in Postgres on Cloudflare).
 * With a cipher the key is encrypted at rest. A key in the environment always wins.
 */
import type { Cipher } from "./crypto";
import { FilePersistence, type Persistence } from "./persistence";

interface SettingsFile {
  anthropicApiKey?: string;
  /** The same key, encrypted; written instead of the plain one when a cipher is in use. */
  anthropicApiKeyEnc?: string;
}

export class SettingsStore {
  private constructor(
    private persistence: Persistence<SettingsFile>,
    private cipher: Cipher | undefined,
    private apiKey: string | undefined,
  ) {}

  static async open(persistence: Persistence<SettingsFile>, cipher?: Cipher): Promise<SettingsStore> {
    const data = (await persistence.load()) ?? {};
    let key = data.anthropicApiKey;
    if (data.anthropicApiKeyEnc) {
      if (!cipher) throw new Error("저장된 API 키가 암호화되어 있습니다. APP_SECRET을 설정하세요.");
      key = await cipher.decrypt(data.anthropicApiKeyEnc);
    }
    return new SettingsStore(persistence, cipher, key);
  }

  static openFile(file: string): Promise<SettingsStore> {
    return SettingsStore.open(new FilePersistence<SettingsFile>(file));
  }

  get anthropicApiKey(): string | undefined {
    return this.apiKey;
  }

  /** Whether a key can be saved safely: databases need a cipher; a 0600 file doesn't. */
  get canStoreKey(): boolean {
    return !!this.cipher || this.persistence instanceof FilePersistence;
  }

  async setAnthropicApiKey(key: string | undefined) {
    if (key && !this.canStoreKey) throw new Error("서버에 APP_SECRET이 없어서 키를 안전하게 저장할 수 없습니다.");
    this.apiKey = key;
    const next: SettingsFile = {};
    if (key) {
      if (this.cipher) next.anthropicApiKeyEnc = await this.cipher.encrypt(key);
      else next.anthropicApiKey = key;
    }
    await this.persistence.save(next);
  }
}

/** "sk-ant-…wxyz": enough to recognise a key without revealing it. */
export function keyHint(key: string): string {
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…";
}
