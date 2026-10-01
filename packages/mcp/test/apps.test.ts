import { describe, expect, it } from "vitest";
import { APP_MIME_TYPE, APP_URI, AppHost, AppView, connectHttp, negotiatedCapabilities, serveHttp, textOf } from "@harness/mcp";

describe("MCP apps", () => {
  it("MCP3.1 a sandboxed view completes ui/initialize and tools/call", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url);
    try {
      const tools = await client.listTools();
      const show = tools.tools.find((tool) => tool.name === "show");
      expect(show?._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
      const resource = await client.readResource(APP_URI);
      expect(resource.contents[0]?.mimeType).toBe(APP_MIME_TYPE);
      const content = resource.contents[0];
      const html = content && "text" in content ? content.text : "";
      const channel = new MessageChannel();
      const host = new AppHost(html, { callTool: (name, args) => client.callTool(name, args) });
      const view = new AppView({ name: "demo", version: "0.0.0" });
      expect(host.frame.sandbox).toBe("allow-scripts");
      expect(host.frame.srcdoc).toBe(html);
      host.attach(channel.port1);
      view.attach(channel.port2);
      await expect(view.initialize()).resolves.toMatchObject({ protocolVersion: "2026-01-26" });
      await expect(textOf(await view.callTool("echo", { text: "from-app" }))).toBe("from-app");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP3.2 a client that does not advertise ui still receives the tool result", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url, { capabilities: negotiatedCapabilities({ ui: false }) });
    try {
      expect(textOf(await client.callTool("show", {}))).toBe("demo");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP3.3 a tool that throws settles the guest's call as an error", async () => {
    const channel = new MessageChannel();
    const host = new AppHost("<html></html>", { callTool: () => Promise.reject(new Error("tool broke")) });
    const view = new AppView({ name: "demo", version: "0.0.0" });
    host.attach(channel.port1);
    view.attach(channel.port2);
    await expect(view.callTool("explode", {})).rejects.toThrow("tool broke");
  });
});
