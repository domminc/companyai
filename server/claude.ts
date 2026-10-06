import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLLM, type LLM, MockLLM } from "../engine/llm";
import type { SettingsStore } from "./settings";

/** What the environment says about Claude, as plain values so Node (process.env) and Workers (bindings) both fit. */
export interface ClaudeEnv {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  /** "mock" forces demo mode; "anthropic" forces the real thing. */
  provider?: string;
  mockDelayMs: number;
}

export function claudeEnvFrom(env: Record<string, string | undefined>): ClaudeEnv {
  return {
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    authToken: env.ANTHROPIC_AUTH_TOKEN || undefined,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    provider: env.COMPANYAI_PROVIDER || undefined,
    mockDelayMs: Number(env.COMPANYAI_MOCK_DELAY_MS ?? 25),
  };
}

/** Where Claude's key comes from: the environment (wins), the key entered in the app, or none (demo mode). */
export function claudeSource(env: ClaudeEnv, settings: SettingsStore): "env" | "app" | "none" {
  if (env.provider === "mock") return "none";
  if (env.apiKey || env.authToken || env.provider === "anthropic") return "env";
  return settings.anthropicApiKey ? "app" : "none";
}

export function chooseLLM(env: ClaudeEnv, settings: SettingsStore): LLM {
  const source = claudeSource(env, settings);
  if (source === "env") return new AnthropicLLM(new Anthropic({ apiKey: env.apiKey, authToken: env.authToken, baseURL: env.baseURL }));
  if (source === "app") return new AnthropicLLM(new Anthropic({ apiKey: settings.anthropicApiKey, baseURL: env.baseURL }));
  return new MockLLM(env.mockDelayMs);
}
