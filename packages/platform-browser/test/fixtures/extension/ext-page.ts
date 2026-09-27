// An extension page: the official ACP client over a runtime port to the extension's service worker.
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { extensionPort, portStream } from "@harness/platform-browser";
import type { ExtensionPort } from "@harness/platform-browser";

declare const chrome: { runtime: { connect(info: { name: string }): ExtensionPort } };

async function client() {
  const updates: SessionNotification[] = [];
  // No Web Lock: the runtime port's own disconnect is what tells the daemon this page is gone.
  const stream = portStream(extensionPort(chrome.runtime.connect({ name: "acp" })), { locks: undefined });
  const acp = new ClientSideConnection(() => ({ sessionUpdate: async (n) => void updates.push(n), requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), stream);
  await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const said = () => updates.flatMap((n) => (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? [n.update.content.text] : [])).join("");
  return { acp, said };
}

/** Open a session, run a turn on it (holding its input lease), and stay connected. */
async function openAndTurn(text: string) {
  const c = await client();
  const { sessionId } = await c.acp.newSession({ cwd: "/", mcpServers: [] });
  const turn = await c.acp.prompt({ sessionId, prompt: [{ type: "text", text }] });
  return { sessionId, stopReason: turn.stopReason, said: c.said() };
}

/** Take over a session another page held. */
async function takeOver(sessionId: string) {
  const c = await client();
  await c.acp.loadSession({ sessionId, cwd: "/", mcpServers: [] });
  const turn = await c.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine now" }] });
  return { stopReason: turn.stopReason, said: c.said() };
}

Object.assign(globalThis, { smoke: { openAndTurn, takeOver } });
document.title = "ready";
