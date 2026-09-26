import { connect } from "node:net";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { DaemonLink } from "@harness/client";

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
