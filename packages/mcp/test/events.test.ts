import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { connectHttp, serveHttp, signWebhook, textOf, webhookDecision } from "@harness/mcp";

const SECRET = "whsec_dGVzdC1zZWNyZXQ";

function header(headers: { [key: string]: string | string[] | undefined }, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function receiver(): Promise<{
  origin: string;
  decisions: string[];
  close: () => Promise<void>;
}> {
  const decisions: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const decision = webhookDecision(SECRET, {
        id: header(req.headers, "webhook-id"),
        timestamp: header(req.headers, "webhook-timestamp"),
        signature: header(req.headers, "webhook-signature"),
      }, body);
      decisions.push(decision);
      res.writeHead(decision === "accept" ? 204 : 401);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}/hook`,
    decisions,
    close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

describe("MCP events", () => {
  it("MCP4.1 events/list, subscribe, and unsubscribe use the server endpoint", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url);
    const hook = await receiver();
    try {
      const listed = await client.request("events/list", {});
      expect(listed["events"]).toMatchObject([{ name: "demo.ping", delivery: ["poll", "push", "webhook"] }]);
      const args = { room: "1" };
      const first = await client.request("events/subscribe", {
        name: "demo.ping",
        arguments: args,
        delivery: { mode: "webhook", url: hook.origin, secret: SECRET },
      });
      const second = await client.request("events/subscribe", {
        name: "demo.ping",
        arguments: args,
        delivery: { mode: "webhook", url: hook.origin, secret: SECRET },
      });
      expect(first["id"]).toBe(second["id"]);
      const other = await receiver();
      try {
        await client.request("events/subscribe", {
          name: "other.event",
          arguments: {},
          delivery: { mode: "webhook", url: other.origin, secret: SECRET },
        });
        expect(textOf(await client.callTool("emit", {}))).toMatch(/^evt_/);
        await until(() => hook.decisions.length === 1);
        expect(hook.decisions).toEqual(["accept"]);
        expect(other.decisions).toEqual([]);
        expect((await client.request("events/unsubscribe", {
          name: "demo.ping",
          arguments: args,
          delivery: { url: hook.origin },
        }))["resultType"]).toBe("complete");
        expect(textOf(await client.callTool("emit", {}))).toMatch(/^evt_/);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(hook.decisions).toEqual(["accept"]);
        expect(other.decisions).toEqual([]);
      } finally {
        await other.close();
      }
    } finally {
      await client.close();
      await hook.close();
      await server.close();
    }
  });

  it("MCP4.2 one event is delivered by pull, by the MCP stream, and by webhook", async () => {
    const server = await serveHttp();
    const client = await connectHttp(server.url);
    const hook = await receiver();
    const streamed: unknown[] = [];
    client.onNotification("notifications/events/event", (params) => streamed.push(params));
    try {
      await client.request("events/subscribe", {
        name: "demo.ping",
        delivery: { mode: "webhook", url: hook.origin, secret: SECRET },
      });
      const pending = client.request("events/stream", { name: "demo.ping" });
      const eventId = textOf(await client.callTool("emit", {}));
      expect((await pending)["resultType"]).toBe("complete");
      expect(streamed).toEqual([expect.objectContaining({ eventId, name: "demo.ping" })]);
      const polled = await client.request("events/poll", { name: "demo.ping" });
      expect(polled["events"]).toEqual([expect.objectContaining({ eventId, name: "demo.ping" })]);
      await until(() => hook.decisions.length === 1);
      expect(hook.decisions).toEqual(["accept"]);
    } finally {
      await client.close();
      await hook.close();
      await server.close();
    }
  });

  it("MCP4.3 a webhook with a bad signature is rejected", () => {
    expect(webhookDecision(SECRET, { id: "evt_1", timestamp: "1", signature: "v1,not-a-real-signature" }, "{\"n\":1}")).toBe("reject");
    expect(webhookDecision(SECRET, { id: "evt_1", timestamp: "1" }, "{\"n\":1}")).toBe("reject");
  });

  it("MCP4.4 a correctly signed webhook that is not fresh is rejected", () => {
    const body = "{\"n\":1}";
    const stale = "1000";
    const signature = signWebhook(SECRET, "evt_old", stale, body);
    expect(webhookDecision(SECRET, { id: "evt_old", timestamp: stale, signature }, body, { now: 1_700_000_000_000 })).toBe("reject");
    const fresh = String(Math.round(1_700_000_000_000 / 1000));
    const live = signWebhook(SECRET, "evt_new", fresh, body);
    expect(webhookDecision(SECRET, { id: "evt_new", timestamp: fresh, signature: live }, body, { now: 1_700_000_000_000 })).toBe("accept");
  });

  it("MCP4.5 a correctly signed delivery seen before is a replay and is rejected", () => {
    const body = "{\"n\":1}";
    const timestamp = String(Math.round(1_700_000_000_000 / 1000));
    const signature = signWebhook(SECRET, "evt_1", timestamp, body);
    const seen = new Set<string>();
    const headers = { id: "evt_1", timestamp, signature };
    expect(webhookDecision(SECRET, headers, body, { now: 1_700_000_000_000, seen })).toBe("accept");
    expect(webhookDecision(SECRET, headers, body, { now: 1_700_000_000_000, seen })).toBe("reject");
  });
});
