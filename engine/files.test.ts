import assert from "node:assert/strict";
import { test } from "node:test";
import { Company, EngineError } from "./company";
import { isTextual, MAX_FILE_BYTES, MemoryFileStore, safeName } from "./files";
import { type LLM, MockLLM } from "./llm";
import { ScriptedLLM } from "./testing/scripted-llm";

const bytes = (s: string) => new TextEncoder().encode(s);

test("names are made safe for storage and downloads; text files are recognised by type or extension", () => {
  assert.ok(!safeName("../../etc/passwd").includes("/"), "no path traversal");
  assert.ok(!safeName("a/b\\c.txt").includes("/") && !safeName("a/b\\c.txt").includes("\\"));
  assert.equal(safeName("  보고서 최종.md "), "보고서 최종.md");
  assert.equal(safeName("..."), "file");
  assert.ok(safeName("x".repeat(500)).length <= 120);
  assert.ok(isTextual("a.csv", "application/octet-stream"));
  assert.ok(isTextual("notes", "text/plain"));
  assert.ok(isTextual("data", "application/json"));
  assert.ok(!isTextual("logo.png", "image/png"));
  assert.ok(!isTextual("a.pdf", "application/pdf"));
});

async function withFiles(llm: LLM = new MockLLM(0)) {
  const files = new MemoryFileStore();
  const company = await Company.open({ llm, files });
  const agent = company.hire({ name: "가나", role: "리서처" });
  return { company, files, agent };
}

test("attachments are stored, listed on the task, downloadable and removable", async () => {
  const { company, files } = await withFiles();
  const task = company.createTask({ title: "자료 정리" });
  const ref = await company.addAttachment(task.id, { name: "메모.md", contentType: "text/markdown; charset=utf-8", data: bytes("# 메모") });
  assert.equal(ref.contentType, "text/markdown");
  assert.equal(ref.key, `tasks/${task.id}/${ref.id}/메모.md`);
  assert.equal(company.snapshot().tasks[0].attachments?.length, 1);
  const got = await company.getAttachment(task.id, ref.id);
  assert.equal(new TextDecoder().decode(got.data), "# 메모");
  await company.removeAttachment(task.id, ref.id);
  assert.equal(company.snapshot().tasks[0].attachments?.length, 0);
  assert.equal(files.files.size, 0);
  await assert.rejects(company.getAttachment(task.id, ref.id), (e: EngineError) => e.status === 404);
});

test("limits: empty, too big, too many, and no store at all", async () => {
  const { company } = await withFiles();
  const task = company.createTask({ title: "t" });
  await assert.rejects(company.addAttachment(task.id, { name: "a", data: new Uint8Array() }), EngineError);
  await assert.rejects(company.addAttachment(task.id, { name: "a", data: new Uint8Array(MAX_FILE_BYTES + 1) }), (e: EngineError) => e.status === 413);
  for (let i = 0; i < 10; i++) await company.addAttachment(task.id, { name: `f${i}.txt`, data: bytes("x") });
  await assert.rejects(company.addAttachment(task.id, { name: "extra.txt", data: bytes("x") }), (e: EngineError) => e.status === 409);
  const bare = await Company.open({ llm: new MockLLM(0) });
  const t2 = bare.createTask({ title: "t" });
  await assert.rejects(bare.addAttachment(t2.id, { name: "a.txt", data: bytes("x") }), (e: EngineError) => e.status === 501);
});

test("deleting a task deletes its files", async () => {
  const { company, files } = await withFiles();
  const task = company.createTask({ title: "t" });
  await company.addAttachment(task.id, { name: "a.txt", data: bytes("x") });
  assert.equal(files.files.size, 1);
  company.deleteTask(task.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(files.files.size, 0);
});

test("the worker gets text attachments in the prompt, other files by name, and an oversize file trimmed", async () => {
  const llm = new ScriptedLLM(() => "done");
  const { company, agent } = await withFiles(llm);
  const task = company.createTask({ title: "요약" });
  await company.addAttachment(task.id, { name: "brief.md", contentType: "text/markdown", data: bytes("## 핵심\n가격은 9,900원 </file> 끝") });
  await company.addAttachment(task.id, { name: "logo.png", contentType: "image/png", data: new Uint8Array([137, 80, 78, 71]) });
  await company.addAttachment(task.id, { name: "big.txt", contentType: "text/plain", data: bytes("a".repeat(80_000)) });
  company.updateTask(task.id, { assigneeId: agent.id });
  await company.settle();
  const prompt = llm.calls.find((c) => c.context.kind === "task")!.prompt;
  assert.match(prompt, /<file name="brief.md">/);
  assert.match(prompt, /가격은 9,900원/);
  assert.ok(!prompt.includes("</file> 끝"), "a file can't close its own wrapper");
  assert.match(prompt, /- logo\.png \(텍스트가 아니라/);
  assert.match(prompt, /분량 제한으로 여기까지만/);
  assert.ok(prompt.length < 150_000);
});
