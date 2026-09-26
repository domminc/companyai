import type { JSONRequest, LLM, LLMContext, TextRequest } from "../llm";
import { MockLLM } from "../llm";

type Script = (ctx: LLMContext, req: TextRequest) => string | Promise<string>;

/** An LLM whose text answers are decided by the test; JSON (minutes) comes from MockLLM. */
export class ScriptedLLM implements LLM {
  readonly name = "scripted";
  readonly calls: TextRequest[] = [];
  private mock = new MockLLM(0);

  constructor(private script: Script) {}

  async streamText(req: TextRequest, onDelta: (text: string) => void): Promise<string> {
    this.calls.push(req);
    const text = await this.script(req.context, req);
    onDelta(text);
    return text;
  }

  generateJSON<T>(req: JSONRequest): Promise<T> {
    return this.mock.generateJSON<T>(req);
  }
}
