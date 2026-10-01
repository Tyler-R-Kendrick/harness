import { describe, expect, it } from "vitest";
import { CHECKLIST_URI, connectHttp, negotiatedCapabilities, serveHttp, taskIdOf, textOf } from "@harness/mcp";

function codeOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : undefined;
}

describe("MCP tasks and skills", () => {
  it("MCP5.1 tasks/get works after the creating response ends and tasks/update is accepted", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url);
    try {
      const created = await client.callTool("work", {});
      const taskId = taskIdOf(created);
      expect(typeof taskId).toBe("string");
      const status = await client.request("tasks/get", { taskId: taskId ?? "" });
      expect(status["status"]).toBe("input_required");
      expect((await client.request("tasks/update", {
        taskId: taskId ?? "",
        inputResponses: { note: { action: "accept", content: { text: "noted" } } },
      }))["resultType"]).toBe("complete");
      expect((await client.request("tasks/get", { taskId: taskId ?? "" }))["status"]).toBe("completed");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP5.2 there is no tasks/list", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url);
    try {
      await expect(client.request("tasks/list", {})).rejects.toSatisfy((error: unknown) => codeOf(error) === -32601);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP5.3 a skill can be discovered and a supporting file read", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url);
    try {
      const listed = await client.request("skills/list", {});
      const skills = listed["skills"] as { uri: string; resources: { uri: string }[] }[];
      expect(skills[0]?.uri).toBe("skill://code-review/SKILL.md");
      expect(skills[0]?.resources.some((resource) => resource.uri === CHECKLIST_URI)).toBe(true);
      const read = await client.readResource(CHECKLIST_URI);
      const content = read.contents[0];
      expect(content && "text" in content ? content.text : "").toContain("Check names.");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP5.4 without the extension the same call returns an ordinary result", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url, { capabilities: negotiatedCapabilities({ tasks: false, skills: false }) });
    try {
      expect(textOf(await client.callTool("work", {}))).toBe("finished");
      expect(textOf(await client.callTool("review", {}))).toBe("reviewed");
      await expect(client.request("skills/list", {})).rejects.toSatisfy((error: unknown) => codeOf(error) === -32601);
      await expect(client.request("tasks/get", { taskId: "missing" })).rejects.toSatisfy((error: unknown) => codeOf(error) === -32601);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
