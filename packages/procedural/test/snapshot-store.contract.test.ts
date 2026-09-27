import { SnapshotProceduralStore } from "@harness/procedural";
import { MemoryStorage, proceduralStoreContract } from "@harness/testkit";

proceduralStoreContract("SnapshotProceduralStore over MemoryStorage", () => {
  const storage = new MemoryStorage();
  return { store: new SnapshotProceduralStore(storage), reopen: () => new SnapshotProceduralStore(storage.reopen()) };
});
