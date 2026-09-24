import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const children: ChildProcessWithoutNullStreams[] = [];

/** Launch the daemon as an editor would: a child process speaking ACP on stdio. */
function launch(state: string) {
  const child = spawn(process.execPath, [MAIN, "--stdio", "--worker", "echo", "--state", state], {
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  children.push(child);
  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async (n) => void updates.push(n),
      requestPermission: async (p) => {
        permissions.push(p);
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    }),
    stream,
  );
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, client, updates, permissions, exited };
}

const agentText = (updates: SessionNotification[]) =>
  updates
    .map((n) => n.update)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (u as { content: { text: string } }).content.text)
    .join("");

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

describe("native daemon over stdio with the official ACP SDK client", () => {
  it("NS1.1 initialize, new session and a prompt round-trip through a real process", async () => {
    const { client, updates } = launch(join(mkdtempSync(join(tmpdir(), "harness-")), "state.json"));
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init).toMatchObject({ protocolVersion: 1, agentInfo: { name: "harness" }, agentCapabilities: { loadSession: true } });
    const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await client.prompt({ sessionId, prompt: [{ type: "text", text: "hello world" }] });
    expect(res.stopReason).toBe("end_turn");
    expect(agentText(updates)).toBe("echo: hello world");
  });

  it("NS1.2 permission requests reach the client and its answer lets the turn continue", async () => {
    const { client, updates, permissions } = launch(join(mkdtempSync(join(tmpdir(), "harness-")), "state.json"));
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await client.prompt({ sessionId, prompt: [{ type: "text", text: "go !permission" }] });
    expect(res.stopReason).toBe("end_turn");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.options.map((o) => o.optionId)).toEqual(["allow", "deny"]);
    expect(agentText(updates)).toBe("echo: go !permission");
  });

  it("NS1.3 sessions survive a daemon restart and replay through session/load", async () => {
    const state = join(mkdtempSync(join(tmpdir(), "harness-")), "state.json");
    const first = launch(state);
    await first.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await first.client.newSession({ cwd: "/tmp", mcpServers: [] });
    await first.client.prompt({ sessionId, prompt: [{ type: "text", text: "remember me" }] });
    first.child.stdin.end();
    expect(await first.exited).toBe(0);

    const second = launch(state);
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await second.client.loadSession({ sessionId, cwd: "/tmp", mcpServers: [] });
    const kinds = second.updates.map((n) => n.update.sessionUpdate);
    expect(kinds[0]).toBe("user_message_chunk");
    expect(agentText(second.updates)).toBe("echo: remember me");
  });
});
