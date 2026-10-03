import { decisionLogContract } from "@harness/testkit";
import { MemoryDecisionLog } from "../src/records.ts";

/** A memory log that "restarts" by restoring the latest snapshot into a new one, as a host that persists the snapshot would. */
decisionLogContract("MemoryDecisionLog", async () => {
  let current = new MemoryDecisionLog();
  return {
    log: current,
    async reopen() {
      const reopened = new MemoryDecisionLog();
      reopened.restore(current.snapshot());
      current = reopened;
      return reopened;
    },
  };
});

decisionLogContract("MemoryDecisionLog without reopening", async () => ({ log: new MemoryDecisionLog() }));
