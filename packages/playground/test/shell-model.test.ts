import { describe, expect, it } from "vitest";
import { generateText, jsonSchema, streamText, tool } from "ai";
import { shellModel } from "../src/shell-model.ts";

const bash = (run: (command: string) => unknown) => tool({ inputSchema: jsonSchema<{ command: string }>({ type: "object", properties: { command: { type: "string" } } }), execute: async ({ command }) => run(command) });

describe("the shell model: a deterministic model that runs what it is told", () => {
  it("SH1.1 a prompt starting with $ is a bash call; the result is reported with its exit code and output", async () => {
    const ran: string[] = [];
    const result = await generateText({ model: shellModel(), prompt: "$ ls -la", tools: { bash: bash((c) => (ran.push(c), { stdout: "a.txt\n", stderr: "", exitCode: 0 })) }, stopWhen: () => false });
    expect(ran).toEqual(["ls -la"]);
    expect(result.text).toBe("exit 0\na.txt\n");
  });

  it("SH1.2 stderr is reported too, and a denied call says it did not run", async () => {
    const failed = await generateText({ model: shellModel(), prompt: "$ cat nope", tools: { bash: bash(() => ({ stdout: "", stderr: "no such file\n", exitCode: 1 })) }, stopWhen: () => false });
    expect(failed.text).toBe("exit 1\nno such file\n");
    const denied = await generateText({
      model: shellModel(),
      prompt: "$ rm -rf x",
      tools: { bash: bash(() => "never") },
      toolApproval: () => "denied",
      stopWhen: () => false,
    });
    expect(denied.text).toBe("The command did not run: denied by the person.");
  });

  it("SH1.3 anything else gets a hint, streamed", async () => {
    const result = streamText({ model: shellModel(), prompt: "hello" });
    expect(await result.text).toMatch(/^I run shell commands\. Start a prompt with \$/);
  });

  it("SH1.4 a tool result that is not a command's output is shown as JSON", async () => {
    const result = await generateText({ model: shellModel(), prompt: "$ x", tools: { bash: bash(() => "plain") }, stopWhen: () => false });
    expect(result.text).toBe('"plain"');
  });

  it("SH1.5 tool-call ids never repeat, across models too (a reloaded page starts a new model on a kept conversation)", async () => {
    const ids: string[] = [];
    for (const model of [shellModel(), shellModel()]) {
      for (const prompt of ["$ a", "$ b"]) ids.push(...(await generateText({ model, prompt, tools: { bash: bash(() => "ok") } })).toolCalls.map((c) => c.toolCallId));
    }
    expect(new Set(ids).size).toBe(4);
  });
});
