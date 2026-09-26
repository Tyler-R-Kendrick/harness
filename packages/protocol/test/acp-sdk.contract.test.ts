import { describe, expect, it } from "vitest";
import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_METHODS, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { ACP_METHODS, ACP_PROTOCOL_VERSION } from "@harness/protocol";

// Our protocol constants must match the official ACP SDK, so upgrading the SDK
// surfaces protocol drift as a failing contract rather than a runtime surprise.
describe("ACP SDK contract", () => {
  it("ACP1.1 the base protocol version matches the SDK", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });

  it("ACP1.2 every base method we use exists in the SDK with the same name", () => {
    const known = new Set<string>([...Object.values(AGENT_METHODS), ...Object.values(CLIENT_METHODS), ...Object.values(PROTOCOL_METHODS)]);
    for (const m of Object.values(ACP_METHODS)) expect(known.has(m), m).toBe(true);
  });
});
