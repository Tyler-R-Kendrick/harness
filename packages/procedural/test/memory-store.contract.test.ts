import { MemoryProceduralStore } from "@harness/procedural";
import { proceduralStoreContract } from "@harness/testkit";

proceduralStoreContract("MemoryProceduralStore", () => {
  const store = new MemoryProceduralStore();
  return { store, reopen: () => store };
});

proceduralStoreContract("MemoryProceduralStore rebuilt from its document", () => {
  const store = new MemoryProceduralStore();
  return { store, reopen: () => new MemoryProceduralStore(store.document()) };
});
