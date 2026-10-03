import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionLogContract } from "@harness/testkit";
import { FileDecisionLog } from "@harness/platform-native";

// The file backend meets the same contract as every other: ids in order and never reused,
// records validated and copied, outcomes replacing one another, and (after a reopen) all of it kept.
decisionLogContract("FileDecisionLog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-decisions-"));
  const file = join(dir, "decisions.jsonl");
  return {
    log: await FileDecisionLog.open(file),
    reopen: () => FileDecisionLog.open(file),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

// With a tiny compaction ratio the file is rewritten at every reopen: the contract still holds.
decisionLogContract("FileDecisionLog compacting at every reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-decisions-"));
  const file = join(dir, "decisions.jsonl");
  return {
    log: await FileDecisionLog.open(file, { compactRatio: 1 }),
    reopen: () => FileDecisionLog.open(file, { compactRatio: 1 }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});
