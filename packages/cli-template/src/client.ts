import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client } from "@agentclientprotocol/sdk";

type AcpStream = ConstructorParameters<typeof ClientSideConnection>[1];

/** One live daemon session. Every prompt is another turn on that same session. */
export interface DaemonSession {
  prompt(text: string): Promise<string>;
}

/** Open one ACP session on an already open stream. */
export async function openDaemon(stream: AcpStream): Promise<DaemonSession> {
  let reply = "";
  const client: Client = {
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") reply += update.content.text;
    },
    async requestPermission(params) {
      const optionId = params.options[0]?.optionId;
      if (optionId === undefined) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    },
  };
  const acp = new ClientSideConnection(() => client, stream);
  await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await acp.newSession({ cwd: process.cwd(), mcpServers: [] });
  return {
    async prompt(text: string) {
      if (text.trim().length === 0) throw new TypeError("prompt must be a string");
      reply = "";
      await acp.prompt({ sessionId, prompt: [{ type: "text", text }] });
      return reply;
    },
  };
}

/** Send one prompt to a daemon over an already open ACP stream and return the text it said. */
export async function askDaemon(stream: AcpStream, text: string): Promise<string> {
  if (text.trim().length === 0) throw new TypeError("prompt must be a string");
  const session = await openDaemon(stream);
  return session.prompt(text);
}
