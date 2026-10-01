import { describe, expect, it } from "vitest";
import { LiveText, openLiveText, saveLiveText } from "@harness/core";
import type { SnapshotStorage } from "@harness/core";

function memory(): SnapshotStorage & { snapshot: unknown } {
  let snapshot: unknown;
  return {
    get snapshot() {
      return snapshot;
    },
    async load() {
      return snapshot;
    },
    async save(value) {
      snapshot = value;
    },
  };
}

/** Original text in order: every archived span, then the live tail. */
function joined(text: LiveText): string {
  let archived = "";
  for (let i = 0; i < text.archiveCount(); i++) archived += text.expand(i);
  return archived + text.live();
}

describe("LiveText", () => {
  it("AC1.1 appending past the bound compacts on its own and a second compaction keeps the first archive", () => {
    const oldest = "OLDEST-UNIQUE-SPAN";
    const text = new LiveText(oldest.length);
    text.append(oldest);
    expect(text.archiveCount()).toBe(0);
    expect(text.live()).toBe(oldest);

    const second = "SECOND-WAVE-TEXT!";
    text.append(second);
    expect(text.archiveCount()).toBe(1);
    expect(text.live().length).toBeLessThanOrEqual(oldest.length);
    expect(text.live().includes(text.expand(0))).toBe(false);
    expect(joined(text)).toBe(oldest + second);
    const first = text.expand(0);

    const third = "THIRD-WAVE-TEXT!!";
    text.append(third);
    expect(text.archiveCount()).toBe(2);
    expect(text.expand(0)).toBe(first);
    expect(text.live().includes(first)).toBe(false);
    expect(text.live().includes(text.expand(1))).toBe(false);
    expect(text.live().length).toBeLessThanOrEqual(oldest.length);
    expect(joined(text)).toBe(oldest + second + third);
  });

  it("AC1.2 a repetitive archive is stored smaller than its original", () => {
    const repetitive = `${"a".repeat(50)}${"hello ".repeat(40)}`;
    const text = new LiveText(1);
    text.append(repetitive);
    expect(text.archiveCount()).toBe(1);
    expect(text.compressed(0).length).toBeLessThan(text.expand(0).length);
  });

  it("AC1.3 expanding an archive returns its original unchanged", () => {
    const repetitive = `${"a".repeat(50)}${"hello ".repeat(40)}`;
    const text = new LiveText(1);
    text.append(repetitive);
    const original = text.expand(0);
    expect(original + text.live()).toBe(repetitive);
    expect(text.expand(0)).toBe(original);
  });

  it("AC1.4 search finds a query only in the archive and extract returns that passage", () => {
    const text = new LiveText(5);
    text.append("NEEDLE-ONLY-IN-ARCHIVE");
    text.append("SECOND-SPAN-WITHOUT-IT-XXXX");
    expect(text.archiveCount()).toBeGreaterThan(1);
    expect(text.live().includes("NEEDLE")).toBe(false);
    const hits = text.search("NEEDLE");
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    if (hit === undefined) throw new Error("expected a hit");
    const passage = text.extract(hit);
    expect(passage).toBe(text.expand(hit.archive));
    expect(passage.includes("NEEDLE")).toBe(true);
    expect(passage.indexOf("NEEDLE")).toBe(hit.index);
  });

  it("AC1.5 a query that occurs nowhere is not a hit", () => {
    const text = new LiveText(5);
    text.append("NEEDLE-ONLY-IN-ARCHIVE");
    expect(text.search("NO-SUCH-TOKEN")).toEqual([]);
    expect(text.search("")).toEqual([]);
  });

  it("AC1.10 a query that crosses two archives is found and extract returns that original passage", () => {
    const query = "defgh";
    const text = new LiveText(4);
    text.append("abcdefghij");
    text.append("klmnopqrst");
    expect(text.live().includes(query)).toBe(false);
    expect(text.archiveCount()).toBeGreaterThan(1);
    for (let i = 0; i < text.archiveCount(); i++) expect(text.expand(i).includes(query)).toBe(false);
    const hits = text.search(query);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    if (hit === undefined) throw new Error("expected a hit");
    const passage = text.extract(hit);
    expect(passage.includes(query)).toBe(true);
    expect(passage.indexOf(query)).toBe(hit.index);
    let archived = "";
    for (let i = 0; i < text.archiveCount(); i++) archived += text.expand(i);
    expect(archived.includes(passage)).toBe(true);
  });

  it("AC1.6 a saved archive opened as a later session still expands, searches, and extracts", async () => {
    const storage = memory();
    const text = new LiveText(5);
    text.append("NEEDLE-ONLY-IN-ARCHIVE");
    const original = text.expand(0);
    await saveLiveText(storage, text);
    expect(JSON.stringify(storage.snapshot)).not.toContain(original);
    const later = await openLiveText(storage, 5);
    expect(later.expand(0)).toBe(original);
    const hits = later.search("NEEDLE");
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    if (hit === undefined) throw new Error("expected a hit");
    expect(later.extract(hit)).toBe(original);
  });

  it("AC1.7 a bound that is not a non-negative integer is rejected", () => {
    expect(() => new LiveText(-1)).toThrow(/bound/);
    expect(() => new LiveText(1.5)).toThrow(/bound/);
  });

  it("AC1.8 a snapshot that is not a compressed archive is rejected", async () => {
    const storage = memory();
    const bad = [
      null,
      1,
      { version: 2, bound: 1, live: "", archives: [] },
      { version: 1, bound: -1, live: "", archives: [] },
      { version: 1, bound: 1.5, live: "", archives: [] },
      { version: 1, live: "", archives: [] },
      { version: 1, bound: 1, live: 1, archives: [] },
      { version: 1, bound: 1, live: "", archives: "no" },
      { version: 1, bound: 1, live: "", archives: ["no"] },
      { version: 1, bound: 1, live: "", archives: [[1.5]] },
      { version: 1, bound: 1, live: "", archives: [[-1]] },
      { version: 1, bound: 1, live: "", archives: [[300]] },
      { version: 1, bound: 1, live: "", archives: [["x"]] },
    ];
    for (const snapshot of bad) {
      await storage.save(snapshot);
      await expect(openLiveText(storage, 1)).rejects.toThrow(/live text/);
    }
    await storage.save({ version: 1, bound: 1, live: "", archives: [[9]] });
    const later = await openLiveText(storage, 1);
    expect(() => later.expand(0)).toThrow(/archive/);
    expect(() => later.expand(1)).toThrow(/archive/);
    await storage.save({ version: 1, bound: 1, live: "", archives: [[0]] });
    await expect(openLiveText(storage, 1).then((text) => text.expand(0))).rejects.toThrow(/archive/);
    await storage.save({ version: 1, bound: 1, live: "", archives: [[1, 0, 1, 0, 1]] });
    await expect(openLiveText(storage, 1).then((text) => text.expand(0))).rejects.toThrow(/archive/);
  });

  it("AC1.9 an empty store opens as empty live text", async () => {
    const text = await openLiveText(memory(), 4);
    expect(text.live()).toBe("");
    expect(text.archiveCount()).toBe(0);
  });
});
