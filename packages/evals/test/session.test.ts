import { describe, expect, it } from "vitest";
import { EchoWorker } from "@harness/workers";
import { runSession } from "@harness/evals";

describe("runSession", () => {
  it("EV5.1 drives prompts through the real daemon core and returns each turn's reply", async () => {
    const turns = await runSession(new EchoWorker(), ["hello", "again"]);
    expect(turns).toEqual([
      { prompt: "hello", reply: "echo: hello", stopReason: "end_turn", notices: [] },
      { prompt: "again", reply: "echo: again", stopReason: "end_turn", notices: [] },
    ]);
  });
});

describe("runSession permission policy", () => {
  it("EV5.2 permission requests are denied by default instead of hanging the eval", async () => {
    const [turn] = await runSession(new EchoWorker(), ["do it !permission"]);
    expect(turn).toMatchObject({ reply: "permission denied", stopReason: "end_turn" });
  });

  it("EV5.3 an explicit allow policy lets the turn proceed", async () => {
    const [turn] = await runSession(new EchoWorker(), ["do it !permission"], { permission: "allow" });
    expect(turn).toMatchObject({ reply: "echo: do it !permission", stopReason: "end_turn" });
  });
});
