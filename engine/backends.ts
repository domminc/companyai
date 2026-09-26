import { HermesClient } from "./hermes";
import type { LLM, LLMContext } from "./llm";

type Effort = "low" | "medium" | "high";

export interface AgentTurn {
  /** Who the agent is. Claude agents use it; Hermes agents already have SOUL.md. */
  identity: string;
  /** Layers that apply to every backend: workplace context, meeting protocol. */
  instructions: string;
  prompt: string;
  effort?: Effort;
  context: LLMContext;
}

export interface TurnCallbacks {
  onDelta?: (text: string) => void;
  /** Tool the agent is using right now; null when it stops. */
  onTool?: (tool: string | null) => void;
}

/** One agent's brain. Anything that can take a prompt and stream back an answer. */
export interface AgentBackend {
  readonly kind: "claude" | "hermes";
  run(turn: AgentTurn, cb?: TurnCallbacks): Promise<string>;
}

export class ClaudeBackend implements AgentBackend {
  readonly kind = "claude";
  constructor(
    private llm: LLM,
    private model: string,
  ) {}

  run(turn: AgentTurn, cb: TurnCallbacks = {}): Promise<string> {
    return this.llm.streamText(
      {
        model: this.model,
        system: [turn.identity, turn.instructions].filter(Boolean).join("\n\n"),
        prompt: turn.prompt,
        effort: turn.effort,
        context: turn.context,
      },
      (text) => cb.onDelta?.(text),
    );
  }
}

/** A hung gateway must not stall a meeting forever. */
const HERMES_TIMEOUT_MS: Record<LLMContext["kind"], number> = {
  poll: 2 * 60_000,
  review: 5 * 60_000,
  chat: 5 * 60_000,
  meeting: 5 * 60_000,
  minutes: 5 * 60_000,
  recruit: 5 * 60_000,
  task: 30 * 60_000,
};

export class HermesBackend implements AgentBackend {
  readonly kind = "hermes";
  constructor(private client: HermesClient) {}

  run(turn: AgentTurn, cb: TurnCallbacks = {}): Promise<string> {
    // Identity is deliberately not sent: Hermes appends `instructions` after the profile's own
    // system prompt, and a second identity next to SOUL.md makes the agent unstable.
    return this.client.run(
      { input: turn.prompt, instructions: turn.instructions, timeoutMs: HERMES_TIMEOUT_MS[turn.context.kind] },
      cb,
    );
  }
}
