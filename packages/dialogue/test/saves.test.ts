import { describe, expect, it } from "vitest";
import { dialogueSaves } from "@harness/dialogue";

describe("saving a dialogue's book", () => {
  it("SV1.1 a dialogue's saves go one at a time, each of the latest state: changes while one is being saved make one more; a failed save is reported, and the next change saves again", async () => {
    const written: unknown[] = [];
    const errors: unknown[] = [];
    let release!: () => void;
    let fail = false;
    const storage = {
      save: async (v: unknown) => {
        if (written.length === 0) await new Promise<void>((r) => (release = r));
        if (fail) throw new Error("disk full");
        written.push(v);
      },
    };
    const saves = dialogueSaves(storage, (e) => void errors.push(e));
    let state = 0;
    const snapshot = () => ++state;
    saves.persist(snapshot);
    await Promise.resolve();
    saves.persist(snapshot);
    saves.persist(snapshot);
    saves.persist(snapshot);
    release();
    await saves.settled();
    expect(written).toEqual([1, 2]);
    fail = true;
    saves.persist(snapshot);
    await saves.settled();
    expect(errors.map((e) => (e as Error).message)).toEqual(["disk full"]);
    fail = false;
    saves.persist(snapshot);
    await saves.settled();
    expect(written).toEqual([1, 2, 4]);
  });
});
