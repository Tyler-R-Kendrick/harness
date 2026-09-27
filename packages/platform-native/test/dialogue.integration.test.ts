import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

const book = {
  scripts: [
    { id: "order-status", intent: "Where an order is", patterns: ["where is order (?<order_id>\\d+)"], slots: { order_id: {} }, reply: ["Let me look up order ", { slot: "order_id" }, "."] },
    { id: "book-table", intent: "Book a table", patterns: ["book a table"], slots: { time: { prompts: ["For what time?"] } }, reply: ["Booked for ", { slot: "time" }, "."] },
  ],
};

/** The daemon over stdio with a dialogue book, as an editor would launch it, with no gateway credential (a turn that reached the model would fail). */
function launch(dir: string, file: string) {
  const { AI_GATEWAY_API_KEY: _, VERCEL_OIDC_TOKEN: __, ...env } = process.env;
  const child = spawn(process.execPath, [MAIN, "--stdio", "--worker", "model", "--dialogue", file, "--state", join(dir, "state.json")], { env: { ...env, NODE_OPTIONS: "" } });
  children.push(child);
  const updates: SessionNotification[] = [];
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  const client = new ClientSideConnection(() => ({ sessionUpdate: async (n) => void updates.push(n), requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), stream);
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const say = async (sessionId: string, text: string) => {
    const from = updates.length;
    const { stopReason } = await client.prompt({ sessionId, prompt: [{ type: "text", text }] });
    const reply = updates
      .slice(from)
      .map((n) => n.update)
      .flatMap((u) => (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : []))
      .join("");
    return { stopReason, reply };
  };
  return { child, client, exited, say };
}

describe("a scripted dialogue in front of the daemon's model", () => {
  it("DI1.2 a flow started over ACP survives a daemon restart: the reloaded session goes on where the flow was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-flow-"));
    const file = join(dir, "book.json");
    writeFileSync(file, JSON.stringify({ scripts: [{ id: "shirt", intent: "Order a shirt", patterns: ["order a shirt"], reply: [{ flow: "shirt-flow" }] }] }));
    mkdirSync(`${file}.flows`);
    const code = `await tools.say({ text: "Which size? S or M." });
let size;
for (;;) { const { utterance } = await tools.hear({}); if (/^(s|m)$/i.test(utterance.trim())) { size = utterance.trim().toUpperCase(); break; } await tools.say({ text: "S or M?" }); }
await tools.say({ text: "Ordered a shirt in " + size + "." });`;
    writeFileSync(join(`${file}.flows`, "shirt-flow.json"), JSON.stringify({ name: "shirt-flow", kind: "flow", description: "Orders a shirt.", inputs: { type: "object" }, code }));

    const first = launch(dir, file);
    await first.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await first.client.newSession({ cwd: dir, mcpServers: [] });
    expect(await first.say(sessionId, "order a shirt")).toEqual({ stopReason: "end_turn", reply: "Which size? S or M." });
    expect(await first.say(sessionId, "XL")).toEqual({ stopReason: "end_turn", reply: "S or M?" });
    first.child.stdin.end();
    expect(await first.exited).toBe(0);

    const second = launch(dir, file);
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await second.client.loadSession({ sessionId, cwd: dir, mcpServers: [] });
    expect(await second.say(sessionId, "m")).toEqual({ stopReason: "end_turn", reply: "Ordered a shirt in M." });
  });

  it("DI1.1 scripted turns, a form among them, are answered over ACP with no model reachable, and what they served is saved to the book", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-dialogue-"));
    const file = join(dir, "book.json");
    writeFileSync(file, JSON.stringify(book));
    const { child, client, exited, say: sayIn } = launch(dir, file);
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await client.newSession({ cwd: dir, mcpServers: [] });
    const say = (text: string) => sayIn(sessionId, text);
    expect(await say("where is order 1234?")).toEqual({ stopReason: "end_turn", reply: "Let me look up order 1234." });
    expect(await say("book a table")).toEqual({ stopReason: "end_turn", reply: "For what time?" });
    expect(await say("7pm")).toEqual({ stopReason: "end_turn", reply: "Booked for 7pm." });

    child.stdin.end();
    expect(await exited).toBe(0);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { scripts: { id: string; evidence: { served: number } }[] };
    expect(saved.scripts.map((s) => [s.id, s.evidence.served])).toEqual([
      ["order-status", 1],
      ["book-table", 1],
    ]);
  });
});
