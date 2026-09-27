import { MemoryStorage, storageContract } from "@harness/testkit";

storageContract("MemoryStorage", () => {
  const storage = new MemoryStorage();
  return { storage, reopen: () => storage.reopen() };
});
