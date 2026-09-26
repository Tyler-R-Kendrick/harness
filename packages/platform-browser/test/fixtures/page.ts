// The smoke test's page: drives browser hosts over MessagePorts with the ACP SDK's client.
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ModelDescriptor } from "@harness/cognitive";
import { ConstraintEngine } from "@harness/constrained";
import { BrowserHost, buildBrowserEnsemble, CacheStorageByteCache, IndexedDbStorage, portStream, xgrammarFromSource } from "@harness/platform-browser";
// The XGrammar web binding's source, bundled as text (Vite's ?raw), as an app would ship it.
import xgrammarSource from "@mlc-ai/web-xgrammar?raw";
import type { AcpPort } from "@harness/platform-browser";
import { EchoWorker } from "@harness/workers";

const ME = { principal: "profile", kind: "human" } as const;

async function client(port: AcpPort) {
  const updates: SessionNotification[] = [];
  const stream = portStream(port);
  const acp = new ClientSideConnection(() => ({ sessionUpdate: async (n) => void updates.push(n), requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), stream);
  await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const said = () => updates.flatMap((n) => (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? [n.update.content.text] : [])).join("");
  return { acp, said, hangUp: stream.hangUp };
}

/** A host in this tab: a turn, a hang-up that frees the session for another client, and a restart from IndexedDB. */
async function inTab() {
  const storage = new IndexedDbStorage({ name: "tab" });
  const host = await BrowserHost.start({ worker: new EchoWorker(), identity: ME, storage });
  const first = new MessageChannel();
  host.accept(first.port2);
  const a = await client(first.port1);
  const { sessionId } = await a.acp.newSession({ cwd: "/", mcpServers: [] });
  const turn = await a.acp.prompt({ sessionId, prompt: [{ type: "text", text: "hello browser" }] });
  a.hangUp();
  const second = new MessageChannel();
  host.accept(second.port2);
  const b = await client(second.port1);
  await b.acp.loadSession({ sessionId, cwd: "/", mcpServers: [] });
  const again = await b.acp.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] });
  await host.close();
  await storage.close();
  const restarted = await BrowserHost.start({ worker: new EchoWorker(), identity: ME, storage: new IndexedDbStorage({ name: "tab" }) });
  const third = new MessageChannel();
  restarted.accept(third.port2);
  const c = await client(third.port1);
  const listed = await c.acp.listSessions({});
  await restarted.close();
  return { stopReason: turn.stopReason, said: a.said(), again: again.stopReason, reloaded: b.said(), sessions: listed.sessions.map((s) => s.sessionId), sessionId };
}

/** A client of the daemon in the origin's shared worker; the worker failing to start fails it. */
async function sharedClient() {
  const worker = new SharedWorker(new URL("./shared-worker.js", import.meta.url), { type: "module", name: "harness" });
  const failed = new Promise<never>((_, reject) => worker.addEventListener("error", () => reject(new Error("the shared worker failed to start"))));
  return Promise.race([client(worker.port as unknown as AcpPort), failed]);
}

/** Two tabs' worth of clients on one daemon in a shared worker: what one starts, the other sees. */
async function inSharedWorker() {
  const a = await sharedClient();
  const { sessionId } = await a.acp.newSession({ cwd: "/", mcpServers: [] });
  await a.acp.prompt({ sessionId, prompt: [{ type: "text", text: "from tab one" }] });
  const b = await sharedClient();
  const listed = await b.acp.listSessions({});
  return { said: a.said(), sessions: listed.sessions.map((s) => s.sessionId), sessionId };
}

/** Run a turn on the shared daemon (so this tab holds the session's input lease) and leave: the tab then dies without hanging up. */
async function openAndLeave() {
  const a = await sharedClient();
  const { sessionId } = await a.acp.newSession({ cwd: "/", mcpServers: [] });
  await a.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine" }] });
  return sessionId;
}

let joined: ReturnType<typeof sharedClient> | undefined;

/** Connect to the shared daemon now, keeping it running while other tabs come and go. */
async function join() {
  joined = sharedClient();
  await joined;
}

/** Take over a session another tab left: possible once the daemon learns that tab is gone. */
async function takeOver(sessionId: string) {
  const b = await (joined ?? sharedClient());
  await b.acp.loadSession({ sessionId, cwd: "/", mcpServers: [] });
  const turn = await b.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine now" }] });
  return { stopReason: turn.stopReason, said: b.said() };
}

/** Model files in the real Cache API: kept, found again by another instance, a missing key is not there. */
async function cacheRoundTrip() {
  const first = new CacheStorageByteCache({ name: "smoke-models" });
  await first.put("repo@rev/model.bin", new Uint8Array([1, 2, 3]));
  const again = new CacheStorageByteCache({ name: "smoke-models" });
  return { found: [...((await again.get("repo@rev/model.bin")) ?? [])], missing: (await again.get("repo@rev/other.bin")) === undefined };
}

/** XGrammar in the browser from its bundled source: a JSON Schema allows only what keeps the output valid. */
async function xgrammar() {
  const vocab = [..."abcdefghijklmnopqrstuvwxyz0123456789{}\":, ", "<eos>"];
  const engine = await ConstraintEngine.create(xgrammarFromSource(xgrammarSource), { tokens: vocab, stopTokens: [vocab.length - 1] });
  const matcher = await engine.matcher({ type: "json-schema", schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } });
  const logits = new Float32Array(vocab.length);
  matcher.mask(logits);
  const allowed = vocab.filter((_, i) => logits[i] !== -Infinity);
  // a grammar XGrammar cannot parse fails, and the engine recovers on a fresh instance
  const broken = await engine.matcher({ type: "grammar", ebnf: "root ::= (" }).then(() => "compiled", (e: Error) => e.message);
  const after = await engine.matcher({ type: "regex", pattern: "[a-c]+" });
  const second = new Float32Array(vocab.length);
  after.mask(second);
  return { allowed, forced: matcher.forced(), broken, afterBroken: vocab.filter((_, i) => second[i] !== -Infinity) };
}

/** The cognitive core in the browser host: a Cactus WASM router, its files fetched from a hub, verified and kept in the Cache API. */
async function cognitive(model: ModelDescriptor, hub: string) {
  const ensemble = buildBrowserEnsemble({ catalog: { models: [model], preferences: {} }, hub, cache: new CacheStorageByteCache({ name: "smoke-cognitive" }) });
  const host = await BrowserHost.start({ worker: new EchoWorker(), identity: ME, cognitive: ensemble });
  const channel = new MessageChannel();
  host.accept(channel.port2);
  const c = await client(channel.port1);
  const routed = await c.acp.extMethod("_harness/cognitive/invoke", { op: "route", input: { input: "go", tools: [{ name: "t", description: "", parameters: {} }] } });
  await host.close();
  return routed;
}

Object.assign(globalThis, { smoke: { inTab, inSharedWorker, openAndLeave, join, takeOver, cacheRoundTrip, xgrammar, cognitive } });
document.title = "ready";
