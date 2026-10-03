import { IDBFactory } from "fake-indexeddb";
import { decisionLogContract } from "@harness/testkit";
import { IndexedDbDecisionLog } from "@harness/platform-browser";

let databases = 0;

// IndexedDB meets the same contract as every other backend: ids in order and never reused,
// records validated and copied, outcomes replacing one another, and all of it kept across a reopen.
decisionLogContract("IndexedDbDecisionLog", async () => {
  const factory = new IDBFactory();
  const name = `decisions-${++databases}`;
  const opened: IndexedDbDecisionLog[] = [];
  const open = () => {
    const log = new IndexedDbDecisionLog({ factory, name });
    opened.push(log);
    return log;
  };
  return {
    log: open(),
    reopen: async () => open(),
    cleanup: async () => void (await Promise.all(opened.map((log) => log.close()))),
  };
});
