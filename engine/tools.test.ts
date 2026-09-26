import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { Company } from "./company";
import { AnthropicLLM, MockLLM, serverTools } from "./llm";
import { ScriptedLLM } from "./testing/scripted-llm";

test("server tools: dynamic-filtering web tools alone, plain ones next to the code sandbox or on Haiku", () => {
  const types = (model: string, tools: ("web" | "code")[]) => serverTools(model, tools).map((t) => t.type);
  assert.deepEqual(types("claude-opus-5", []), []);
  assert.deepEqual(types("claude-opus-5", ["web"]), ["web_search_20260209", "web_fetch_20260209"]);
  assert.deepEqual(types("claude-opus-5", ["code"]), ["code_execution_20260120"]);
  assert.deepEqual(types("claude-opus-5", ["web", "code"]), ["web_search_20250305", "web_fetch_20250910", "code_execution_20260120"]);
  assert.deepEqual(types("claude-haiku-4-5", ["web"]), ["web_search_20250305", "web_fetch_20250910"]);
});

/** A stand-in for client.beta.messages.stream: replays events, keeps a snapshot like the SDK does. */
function fakeClient(rounds: { events: unknown[]; message: Partial<Anthropic.Beta.BetaMessage> }[]) {
  const requests: Anthropic.Beta.MessageCreateParams[] = [];
  let i = 0;
  const stream = (params: Anthropic.Beta.MessageCreateParams) => {
    requests.push(structuredClone(params));
    const round = rounds[i++];
    const snapshot = { content: [] as unknown[] };
    return {
      get currentMessage() {
        return snapshot;
      },
      async *[Symbol.asyncIterator]() {
        for (const e of round.events as { type: string; index: number; content_block?: object; input?: unknown }[]) {
          if (e.type === "content_block_start") snapshot.content[e.index] = e.content_block;
          // The SDK parses a tool block's input from its JSON deltas; `input` stands in for them.
          if (e.type === "content_block_stop" && e.input) snapshot.content[e.index] = { ...(snapshot.content[e.index] as object), input: e.input };
          yield e;
        }
      },
      finalMessage: async () => ({ stop_reason: "end_turn", content: [], ...round.message }),
    };
  };
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, requests };
}

test("AnthropicLLM reports server tools, separates text around them and resumes a paused turn", async () => {
  const toolUse = { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "원달러 환율" } };
  const { client, requests } = fakeClient([
    {
      events: [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "찾아볼게요." } },
        { type: "content_block_start", index: 1, content_block: { ...toolUse, input: {} } },
        { type: "content_block_stop", index: 1, input: toolUse.input },
      ],
      message: { stop_reason: "pause_turn", content: [{ type: "text", text: "찾아볼게요.", citations: null }, toolUse] as never },
    },
    {
      events: [
        { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] } },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "1,380원입니다." } },
      ],
      message: { stop_reason: "end_turn" },
    },
  ]);
  const llm = new AnthropicLLM(client);
  const tools: (string | null)[] = [];
  let streamed = "";
  const out = await llm.streamText(
    { model: "claude-opus-5", system: "", prompt: "환율?", context: { kind: "chat", agentName: "a", role: "r", message: "환율?" }, tools: ["web"] },
    (t) => (streamed += t),
    (t) => tools.push(t),
  );
  assert.equal(out, "찾아볼게요.\n\n1,380원입니다.");
  assert.equal(streamed, out);
  assert.deepEqual(tools, ["web_search", "web_search: 원달러 환율", null, null]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.at(-1), { role: "assistant", content: [{ type: "text", text: "찾아볼게요.", citations: null }, toolUse] });
  assert.deepEqual(requests[0].tools?.map((t) => (t as { name: string }).name), ["web_search", "web_fetch"]);
});

test("employees get their tools for work and 1:1 chat, not for meeting chatter", async () => {
  const llm = new ScriptedLLM((ctx) => (ctx.kind === "poll" ? "PASS" : "좋습니다"));
  const company = await Company.open({ llm });
  const a = company.hire({ name: "가", role: "리서처", tools: ["web", "code", "bogus" as never] });
  const b = company.hire({ name: "나", role: "PM" });
  assert.deepEqual(a.runtime, { kind: "claude", model: "claude-opus-5", tools: ["web", "code"] });
  company.createTask({ title: "시장 조사", assigneeId: a.id });
  company.chat(a.id, "안녕하세요");
  await company.settle();
  company.startMeeting({ topic: "주간 회의", participantIds: [b.id, a.id] });
  await company.settle();

  const byKind = (kind: string) => llm.calls.filter((c) => c.context.kind === kind);
  assert.deepEqual(byKind("task")[0].tools, ["web", "code"]);
  assert.deepEqual(byKind("chat")[0].tools, ["web", "code"]);
  assert.ok(byKind("meeting").every((c) => c.tools === undefined));
  assert.ok(byKind("poll").every((c) => c.tools === undefined));

  company.updateAgent(a.id, { tools: [] });
  assert.deepEqual(company.snapshot().agents.find((x) => x.id === a.id)!.runtime, { kind: "claude", model: "claude-opus-5", tools: [] });
});

test("the offline provider shows the tool chip while it 'searches'", async () => {
  const company = await Company.open({ llm: new MockLLM(0) });
  const a = company.hire({ name: "가", role: "리서처", tools: ["web"] });
  const seen: string[] = [];
  company.subscribe((e) => {
    if (e.type === "task.updated" && e.task.activeTool) seen.push(e.task.activeTool);
  });
  company.createTask({ title: "경쟁사 가격", assigneeId: a.id });
  await company.settle();
  assert.deepEqual(seen, ["web_search: 경쟁사 가격"]);
  assert.equal(company.snapshot().tasks[0].activeTool, undefined);
});
