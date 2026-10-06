/**
 * Small WebCrypto helpers (the same API on Node and in Workers): a secret from the environment
 * is stretched into separate keys per purpose, and used to encrypt what must sit in a database,
 * such as the Anthropic API key entered in the app.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(secret: string, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("companyai"), info: enc.encode(purpose) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Cipher {
  encrypt(text: string): Promise<string>;
  decrypt(token: string): Promise<string>;
}

export async function createCipher(secret: string, purpose = "settings"): Promise<Cipher> {
  const key = await deriveKey(secret, purpose);
  return {
    async encrypt(text) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text)));
      return `v1.${b64(iv)}.${b64(body)}`;
    },
    async decrypt(token) {
      const [version, iv, body] = token.split(".");
      if (version !== "v1" || !iv || !body) throw new Error("알 수 없는 암호문 형식입니다.");
      try {
        return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(body)));
      } catch {
        throw new Error("저장된 값을 풀 수 없습니다. APP_SECRET이 바뀌었는지 확인하세요.");
      }
    },
  };
}

/** A stable per-purpose HMAC secret, so sessions are signed with something derived rather than the raw secret. */
export async function derivedSecret(secret: string, purpose: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`companyai:${purpose}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}
