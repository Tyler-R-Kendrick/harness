import { connect } from "node:net";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client } from "@agentclientprotocol/sdk";
import type { DaemonLink } from "@harness/client";
import { HARNESS_METHODS } from "@harness/protocol";

/** An ACP connection to a daemon listening on a Unix socket (or Windows named pipe), for `daemonHarness`. */
export function daemonSocket(path: string): Promise<DaemonLink> {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => {
      socket.off("error", reject);
      resolve({ stream: ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket) as ReadableStream<Uint8Array>), close: () => void socket.end() });
    });
    socket.once("error", reject);
  });
}

/**
 * Run one cognitive operation (`_harness/cognitive/invoke`, e.g. `procedural.history`) on
 * the daemon listening at `path`, over a connection of its own: initialize, invoke, close.
 * A refusal from the daemon is an `Error` with the daemon's message.
 */
export async function invokeDaemon(path: string, op: string, input: unknown): Promise<unknown> {
  const link = await daemonSocket(path);
  try {
    // This client opens no session, so the daemon never calls it back (no updates, no permission requests).
    const client = new ClientSideConnection(() => ({}) as Client, link.stream);
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    // A refusal rejects with the SDK's RequestError, an Error carrying the daemon's message.
    return await client.extMethod(HARNESS_METHODS.cognitiveInvoke, { op, input: input as Record<string, unknown> });
  } finally {
    link.close();
  }
}
