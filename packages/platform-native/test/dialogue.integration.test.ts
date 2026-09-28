import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const CLI = new URL("../src/dialogue-cli.ts", import.meta.url).pathname;
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

  it("DI1.3 a VoiceXML application imported with harness-dialogue answers over ACP with no model reachable, calling a workflow, and its state survives a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-vxml-"));
    const file = join(dir, "book.json");
    const app = join(dir, "app");
    mkdirSync(app);
    writeFileSync(
      join(app, "pizza.vxml"),
      `<vxml version="2.1"><form>
        <field name="size"><prompt>What size?</prompt><grammar src="sizes.gram"/></field>
        <field name="ok" type="boolean"><prompt>A <value expr="size"/> pizza?</prompt>
          <filled><data name="r" src="tool:place-order" namelist="size"/>Order <value expr="r.id"/> placed.</filled></field>
      </form></vxml>`,
    );
    writeFileSync(join(app, "sizes.gram"), "#ABNF 1.0;\n$size = small | large;");
    const imported = spawnSync(process.execPath, [CLI, "import", app, "--book", file, "--name", "pizza", "--pattern", "order a pizza"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    expect(imported.stdout).toBe(`imported voicexml pizza (2 files) into ${file}\n`);
    expect(imported.status).toBe(0);
    // The flow's tool: a workflow in the flows directory beside the book.
    writeFileSync(join(`${file}.flows`, "place-order.json"), JSON.stringify({ name: "place-order", description: "Places an order.", inputs: { type: "object" }, code: `return { id: "P-" + input.size };` }));

    const first = launch(dir, file);
    await first.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await first.client.newSession({ cwd: dir, mcpServers: [] });
    expect(await first.say(sessionId, "order a pizza")).toEqual({ stopReason: "end_turn", reply: "What size?" });
    expect(await first.say(sessionId, "large")).toEqual({ stopReason: "end_turn", reply: "A large pizza?" });
    first.child.stdin.end();
    expect(await first.exited).toBe(0);

    const second = launch(dir, file);
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await second.client.loadSession({ sessionId, cwd: dir, mcpServers: [] });
    expect(await second.say(sessionId, "yes")).toEqual({ stopReason: "end_turn", reply: "Order P-large placed." });
  });

  it("DI1.4 harness-dialogue refuses a document it cannot run, and bad arguments, saying why", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-vxml-"));
    const bad = join(dir, "bad.vxml");
    writeFileSync(bad, `<vxml><form><block><script>x()</script></block></form></vxml>`);
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    expect(run("import", bad, "--book", join(dir, "b.json"), "--name", "bad")).toMatchObject({ status: 1, stderr: expect.stringContaining("<script> is not supported") });
    expect(run("import", bad)).toMatchObject({ status: 2, stderr: expect.stringContaining("usage: harness-dialogue import") });
    expect(run("import", bad, "--book", join(dir, "b.json"), "--name", "bad", "--option", "novalue")).toMatchObject({ status: 2, stderr: expect.stringContaining("--option takes key=value") });
  });

  it("DI1.5 harness-dialogue takes from a directory only the files a standard reads, and importing again without --pattern keeps the script that starts it", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-aiml-"));
    const bot = join(dir, "bot");
    mkdirSync(join(bot, "sets"), { recursive: true });
    writeFileSync(join(bot, "bot.aiml"), `<aiml><category><pattern>HELLO</pattern><template>Hi.</template></category></aiml>`);
    writeFileSync(join(bot, "sets", "colors.txt"), "red\nblue\n");
    writeFileSync(join(bot, "README.md"), "# my bot");
    writeFileSync(join(bot, "hello.wav"), Buffer.from([0, 255, 1, 2]));
    const file = join(dir, "book.json");
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    const first = run("import", bot, "--book", file, "--name", "chat", "--pattern", "chat with the bot");
    expect(first).toMatchObject({ status: 0, stderr: expect.stringContaining("skipped") });
    expect(first.stderr).toContain("README.md");
    expect(first.stderr).toContain("hello.wav");
    const saved = () => JSON.parse(readFileSync(file, "utf8")) as { scripts: { id: string }[]; documents: { files: Record<string, string> }[] };
    expect(Object.keys(saved().documents[0]!.files).sort()).toEqual(["bot.aiml", "sets/colors.txt"]);
    expect(run("import", bot, "--book", file, "--name", "chat")).toMatchObject({ status: 0 });
    expect(saved().scripts.map((s) => s.id)).toEqual(["chat"]);
  });
});
