#!/usr/bin/env node
// A dependency-free ACP agent for tests: it answers initialize, session/new and
// session/load, and echoes each prompt's text back as one agent message chunk
// ("echo again:" in a session it loaded, so a test can tell a resume from a fresh start).
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let sessions = 0;
const loaded = new Set();
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [] } });
  else if (method === "session/new") send({ id, result: { sessionId: `echo-${process.pid}-${++sessions}` } });
  else if (method === "session/load") {
    loaded.add(params.sessionId);
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
    const echo = loaded.has(params.sessionId) ? "echo again" : "echo";
    send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${echo}: ${text}` } } } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined && method !== undefined) send({ id, result: {} });
}
