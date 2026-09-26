import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageContract } from "@harness/testkit";
import { FileStorage } from "@harness/platform-native";

storageContract("FileStorage", () => {
  const path = join(mkdtempSync(join(tmpdir(), "harness-fs-")), "nested", "state.json");
  return { storage: new FileStorage(path), reopen: () => new FileStorage(path) };
});
