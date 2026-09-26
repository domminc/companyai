import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5";

export const AVAILABLE_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
] as const;

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Structured context about the request. The Anthropic provider ignores it (the
 * prompt already carries everything); the mock provider uses it to fake output.
 */
export type LLMContext =
  | { kind: "task"; agentName: string; role: string; title: string }
  | { kind: "meeting"; agentName: string; role: string; topic: string; round: number; rounds: number }
  | { kind: "recruit"; jobDescription: string }
  | { kind: "minutes"; topic: string; participants: { id: string; name: string; role: string }[] };

export interface TextRequest {
  model: string;
  system: string;
  prompt: string;
  effort?: Effort;
  context: LLMContext;
}

export interface JSONRequest extends TextRequest {
  schema: Record<string, unknown>;
}

export interface LLM {
  readonly name: string;
  streamText(req: TextRequest, onDelta: (text: string) => void): Promise<string>;
  generateJSON<T>(req: JSONRequest): Promise<T>;
}

// Server-side refusal fallback: a policy decline is re-run on Anthropic's
// recommended fallback model inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function fallbackOptions(model: string) {
  const supported = model.startsWith("claude-opus-5") || model.startsWith("claude-fable");
  return supported ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {};
}

// Haiku 4.5 rejects `effort`.
function effortOption(model: string, effort?: Effort) {
  return effort && !model.startsWith("claude-haiku") ? { effort } : {};
}

function withEffort(model: string, effort?: Effort) {
  const option = effortOption(model, effort);
  return "effort" in option ? { output_config: option } : {};
}

function assertNotRefused(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === "refusal") {
    const detail = message.stop_details?.explanation ?? message.stop_details?.category ?? "no details";
    throw new Error(`The model declined this request (${detail}).`);
  }
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API 인증 실패: ANTHROPIC_API_KEY를 확인하세요.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic API 요청 한도 초과: 잠시 후 다시 시도하세요.";
  if (err instanceof Anthropic.BadRequestError) return `잘못된 요청: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API 오류 (${err.status ?? "network"}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export class AnthropicLLM implements LLM {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(client = new Anthropic()) {
    this.client = client;
  }

  async streamText(req: TextRequest, onDelta: (text: string) => void): Promise<string> {
    const stream = this.client.beta.messages.stream({
      model: req.model,
      max_tokens: 64000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      ...withEffort(req.model, req.effort),
      ...fallbackOptions(req.model),
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        onDelta(event.delta.text);
      }
    }
    const message = await stream.finalMessage();
    assertNotRefused(message);
    return textOf(message);
  }

  async generateJSON<T>(req: JSONRequest): Promise<T> {
    const message = await this.client.beta.messages.create({
      model: req.model,
      max_tokens: 16000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: {
        ...effortOption(req.model, req.effort),
        format: { type: "json_schema", schema: req.schema },
      },
      ...fallbackOptions(req.model),
    });
    assertNotRefused(message);
    if (message.stop_reason === "max_tokens") throw new Error("Structured response was truncated.");
    return JSON.parse(textOf(message)) as T;
  }
}

/** Offline provider so the whole app can be tried without an API key. */
export class MockLLM implements LLM {
  readonly name = "mock";

  constructor(private delayMs = 25) {}

  async streamText(req: TextRequest, onDelta: (text: string) => void): Promise<string> {
    const text = mockText(req.context);
    const chunks = text.match(/\S+\s*/g) ?? [text];
    for (const chunk of chunks) {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      onDelta(chunk);
    }
    return text;
  }

  async generateJSON<T>(req: JSONRequest): Promise<T> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs * 10));
    const ctx = req.context;
    if (ctx.kind === "recruit") {
      const pick = MOCK_NAMES[Math.floor(Math.random() * MOCK_NAMES.length)];
      const role = ctx.jobDescription.split(/[\n.,]/)[0].trim().slice(0, 40) || "제너럴리스트";
      return {
        name: pick,
        role,
        persona: `${pick}은(는) "${role}" 포지션에 지원한 후보입니다. 꼼꼼하고 협업을 즐기며, 결론부터 말하고 근거를 덧붙이는 스타일입니다.`,
        skills: ["문제 정의", "커뮤니케이션", "실행력"],
      } as T;
    }
    if (ctx.kind === "minutes") {
      return {
        summary: `"${ctx.topic}"에 대해 ${ctx.participants.length}명이 논의했습니다. (mock 모드 요약)`,
        decisions: [`${ctx.topic} 관련 1차 실행안을 진행한다`],
        actionItems: ctx.participants.map((p) => ({
          title: `${ctx.topic} - ${p.role} 관점 실행안 작성`,
          description: `회의 결정사항을 바탕으로 ${p.role} 관점의 구체적인 실행안을 작성합니다.`,
          assigneeId: p.id,
        })),
      } as T;
    }
    throw new Error(`MockLLM cannot generate JSON for ${ctx.kind}`);
  }
}

const MOCK_NAMES = ["김하늘", "이도윤", "박서연", "최민준", "정유나", "강지호"];

function mockText(ctx: LLMContext): string {
  switch (ctx.kind) {
    case "task":
      return [
        `## ${ctx.title}`,
        "",
        `${ctx.role} ${ctx.agentName}입니다. 요청하신 작업 결과를 정리했습니다.`,
        "",
        "1. 목표와 범위를 정의했습니다.",
        "2. 핵심 리스크 세 가지를 파악하고 대응책을 마련했습니다.",
        "3. 다음 단계로 이해관계자 리뷰를 제안합니다.",
        "",
        "*(mock 모드 응답입니다. ANTHROPIC_API_KEY를 설정하면 실제 Claude가 일합니다.)*",
      ].join("\n");
    case "meeting":
      return ctx.round === ctx.rounds
        ? `${ctx.role} 입장에서 정리하면, "${ctx.topic}"은(는) 작게 시작해서 빠르게 검증하는 방향에 동의합니다. 제가 맡을 부분을 이번 주 안에 초안으로 공유하겠습니다.`
        : `${ctx.role}로서 보면 "${ctx.topic}"에서 가장 중요한 건 우선순위입니다. 먼저 사용자 가치가 가장 큰 항목부터 정하고, 제 쪽에서는 필요한 리소스를 추정해 보겠습니다.`;
    default:
      return "";
  }
}
