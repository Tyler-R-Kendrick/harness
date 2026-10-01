import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  META,
  PROTOCOL_VERSION,
  connectHttp,
  connectStdio,
  probeProtocolVersion,
  serveArgs,
  serveHttp,
  serveOnStdio,
  textOf,
  withResultType,
} from "@harness/mcp";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function names(tools: { name: string }[]): string {
  return tools.map((tool) => tool.name).sort().join(",");
}

async function withHttp<T>(run: (url: string) => Promise<T>): Promise<T> {
  const server = await serveHttp();
  try {
    return await run(server.url);
  } finally {
    await server.close();
  }
}

describe("stateless MCP 2026-07-28", () => {
  it("MCP1.1 discover then a tool call returns that tool's result", async () => {
    await withHttp(async (url) => {
      const client = await connectHttp(url);
      try {
        const discovered = await client.discover();
        expect(discovered.resultType).toBe("complete");
        expect(JSON.stringify(discovered)).toContain(PROTOCOL_VERSION);
        expect(textOf(await client.callTool("echo", { text: "hello" }))).toBe("hello");
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.2 a stdio client discovers the server and calls a tool", async () => {
    const client = await connectStdio({ command: process.execPath, args: [bin, "stdio"] });
    try {
      const discovered = await client.discover();
      expect(discovered["supportedVersions"]).toEqual([PROTOCOL_VERSION]);
      expect(textOf(await client.callTool("echo", { text: "pipe" }))).toBe("pipe");
    } finally {
      await client.close();
    }
  });

  it("MCP1.3 each request carries the protocol version in _meta", async () => {
    await withHttp(async (url) => {
      const seen: string[] = [];
      const client = await connectHttp(url, {
        fetch: async (input, init) => {
          const body = typeof init?.body === "string" ? init.body : "";
          if (body.includes(META.protocolVersion)) seen.push(body);
          return fetch(input, init);
        },
      });
      try {
        expect(textOf(await client.callTool("echo", { text: "meta" }))).toBe("meta");
        expect(seen.some((body) => body.includes(`"${META.protocolVersion}":"${PROTOCOL_VERSION}"`))).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.4 an unsupported protocol version fails with -32022", async () => {
    await withHttp(async (url) => {
      expect(await probeProtocolVersion({ url }, "1999-01-01")).toBe(-32022);
    });
    expect(await probeProtocolVersion({ command: process.execPath, args: [bin, "stdio"] }, "1999-01-01")).toBe(-32022);
  });

  it("MCP1.5 two connections receive the same list", async () => {
    await withHttp(async (url) => {
      const first = await connectHttp(url);
      const second = await connectHttp(url);
      try {
        expect(names((await first.listTools()).tools)).toBe(names((await second.listTools()).tools));
        expect((await first.listResources()).resources.map((resource) => resource.uri).sort()).toEqual(
          (await second.listResources()).resources.map((resource) => resource.uri).sort(),
        );
        expect((await first.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual(
          (await second.listPrompts()).prompts.map((prompt) => prompt.name).sort(),
        );
      } finally {
        await first.close();
        await second.close();
      }
    });
  });

  it("MCP1.6 cacheable results include ttlMs and cacheScope", async () => {
    await withHttp(async (url) => {
      const client = await connectHttp(url);
      try {
        const tools = await client.listTools();
        expect(tools["ttlMs"]).toBe(60_000);
        expect(tools["cacheScope"]).toBe("public");
        const read = await client.readResource("note://readme");
        expect(read["ttlMs"]).toBe(30_000);
        expect(read["cacheScope"]).toBe("private");
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.7 Streamable HTTP sends Mcp-Method and Mcp-Name", async () => {
    await withHttp(async (url) => {
      const headers: { method: string | null; name: string | null; session: string | null }[] = [];
      const client = await connectHttp(url, {
        fetch: async (input, init) => {
          const request = new Headers(init?.headers);
          const body = typeof init?.body === "string" ? init.body : "";
          if (body.includes('"tools/call"')) {
            headers.push({
              method: request.get("mcp-method"),
              name: request.get("mcp-name"),
              session: request.get("mcp-session-id"),
            });
          }
          const response = await fetch(input, init);
          expect(response.headers.get("mcp-session-id")).toBeNull();
          return response;
        },
      });
      try {
        expect(textOf(await client.callTool("echo", { text: "hdr" }))).toBe("hdr");
        expect(headers.some((header) => header.method === "tools/call" && header.name !== null && header.session === null)).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.8 a list change arrives on subscriptions/listen", async () => {
    await withHttp(async (url) => {
      const client = await connectHttp(url);
      const changed: string[] = [];
      client.onNotification("notifications/tools/list_changed", () => changed.push("tools"));
      try {
        const subscription = await client.listen({ toolsListChanged: true });
        expect(textOf(await client.callTool("revise", {}))).toBe("revised");
        expect(names((await client.listTools()).tools)).toContain("extra");
        expect(changed).toEqual(["tools"]);
        await subscription.close();
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.9 progress for a request stays on that request", async () => {
    await withHttp(async (url) => {
      const client = await connectHttp(url);
      const progress: number[] = [];
      try {
        expect(textOf(await client.callTool("progress", {}, { onprogress: (update) => progress.push(update.progress) }))).toBe("stepped");
        expect(progress).toEqual([1]);
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.10 a log message is sent only when the request set a log level", async () => {
    await withHttp(async (url) => {
      const client = await connectHttp(url);
      const logs: unknown[] = [];
      client.onNotification("notifications/message", (params) => logs.push(params["data"]));
      try {
        expect(textOf(await client.callTool("logger", {}))).toBe("logged");
        expect(logs).toEqual([]);
        expect(textOf(await client.callTool("logger", {}, { logLevel: "info" }))).toBe("logged");
        expect(logs).toEqual(["heard"]);
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.11 input_required is retried with inputResponses", async () => {
    await withHttp(async (url) => {
      const client = await connectHttp(url);
      try {
        const asked = (await client.callTool("ask", {}, { allowInputRequired: true })) as { resultType?: string; inputRequests?: Record<string, unknown> };
        expect(asked.resultType).toBe("input_required");
        expect(asked.inputRequests?.["who"]).toBeTruthy();
        expect(textOf(await client.callTool("ask", {}, {
          allowInputRequired: true,
          inputResponses: { who: { action: "accept", content: { name: "Ada" } } },
        }))).toBe("Ada");
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.12 a dropped response stream is re-issued with a new id only for a call marked idempotent", async () => {
    await withHttp(async (url) => {
      const ids: unknown[] = [];
      let dropped = false;
      const client = await connectHttp(url, {
        fetch: async (input, init) => {
          const body = typeof init?.body === "string" ? init.body : "";
          if (body.includes('"tools/call"')) {
            ids.push((JSON.parse(body) as { id?: unknown }).id);
            if (!dropped) {
              dropped = true;
              throw new Error("other side closed");
            }
          }
          return fetch(input, init);
        },
      });
      try {
        await expect(client.callTool("echo", { text: "again" })).rejects.toThrow("other side closed");
        expect(ids).toHaveLength(1);
        dropped = false;
        let drops = 0;
        const flaky = await connectHttp(url, {
          fetch: async (input, init) => {
            const body = typeof init?.body === "string" ? init.body : "";
            if (body.includes('"tools/call"') && drops === 0) {
              drops += 1;
              throw new Error("other side closed");
            }
            return fetch(input, init);
          },
        });
        try {
          expect(textOf(await flaky.callTool("echo", { text: "again" }, { idempotent: true }))).toBe("again");
          expect(drops).toBe(1);
        } finally {
          await flaky.close();
        }
      } finally {
        await client.close();
      }
    });
  });

  it("MCP1.13 a peer result that omits resultType is complete", () => {
    expect(withResultType({ ok: true }).resultType).toBe("complete");
    expect(withResultType({ resultType: "input_required" }).resultType).toBe("input_required");
  });

  it("MCP1.14 stdio in this process answers discover", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const line = new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("stdio timed out")), 5_000);
      output.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        resolve(buffer.slice(0, newline));
      });
    });
    const handle = serveOnStdio(undefined, { stdin: input, stdout: output });
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          [META.protocolVersion]: PROTOCOL_VERSION,
          [META.clientCapabilities]: {},
          [META.clientInfo]: { name: "probe", version: "0.0.0" },
        },
      },
    })}\n`);
    const response = JSON.parse(await line) as { result?: { supportedVersions?: string[] } };
    expect(response.result?.supportedVersions).toEqual([PROTOCOL_VERSION]);
    await handle.close();
  });

  it("MCP1.15 the http command serves discover on the printed port", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const server = await serveArgs(["http", "--port", "0"]);
      const port = lines.join("").match(/MCP_HTTP_PORT=(\d+)/)?.[1];
      expect(port).toBe(String(server.port));
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              [META.protocolVersion]: PROTOCOL_VERSION,
              [META.clientCapabilities]: {},
              [META.clientInfo]: { name: "probe", version: "0.0.0" },
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(PROTOCOL_VERSION);
      await server.close();
    } finally {
      console.error = original;
    }
    await expect(serveArgs(["nope"])).rejects.toThrow(/unknown mcp command/);
  });
});
