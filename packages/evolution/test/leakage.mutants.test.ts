import { describe, expect, it } from "vitest";
import { leaks } from "@harness/evolution";
import type { Change, PatchOp, Task } from "@harness/evolution";

const wrote = (...ops: PatchOp[]): Change[] => [{ document: "d", wrote: ops, inverse: [] }];
const added = (path: string, value: unknown): Change[] => wrote({ op: "add", path, value: value as never });

describe("mutation hardening of the leakage screen", () => {
  it("RS21.7 text with no words has no words to repeat: nothing leaks between two texts of punctuation", () => {
    const tasks: Task[] = [{ id: "t1", text: "!!!" }];
    expect(leaks(added("/x", "???"), tasks, { ngram: 1 })).toEqual([]);
    expect(leaks(added("/x", "!!!"), tasks, { ngram: 1 })).toEqual([]);
  });

  it("RS21.8 an array's elements are screened, but its indices are not text it adds", () => {
    const tasks: Task[] = [{ id: "t1", text: "0 1" }];
    expect(leaks(added("/x", ["fine", "also fine"]), tasks, { ngram: 2 })).toEqual([]);
    expect(leaks(added("/x", ["go 0 1 now"]), tasks, { ngram: 2 })).toEqual(['it repeats "0 1" from task t1']);
    expect(leaks(added("/x", [["reconcile ledger"]]), [{ id: "t1", text: "reconcile ledger" }], { ngram: 2 })).toEqual(['it repeats "reconcile ledger" from task t1']);
  });

  it("RS21.9 an array is not read as an object: its indices are not keys of the text", () => {
    const tasks: Task[] = [{ id: "7", text: "seven" }];
    expect(leaks(added("/x", ["a", "b", "c", "d", "e", "f", "g", "h"]), tasks, { ngram: 2 })).toEqual([]);
    expect(leaks(added("/x", { 7: "a" }), tasks, { ngram: 2 })).toEqual(["it names task 7"]);
  });

  it("RS21.10 a null, a number or a boolean value adds no text, and does not throw", () => {
    const tasks: Task[] = [{ id: "t1", text: "reconcile the ledger" }];
    for (const value of [null, 0, 7, true, false, [null], { a: null, b: 3 }]) expect(leaks(added("/x", value), tasks, { ngram: 2 })).toEqual([]);
  });

  it("RS21.11 a value that is not JSON at all (undefined, as a hand-built change might hold) adds no text, and does not throw", () => {
    const tasks: Task[] = [{ id: "t1", text: "reconcile the ledger" }];
    expect(leaks(added("/x", undefined), tasks, { ngram: 2 })).toEqual([]);
    expect(leaks(added("/x", { a: undefined }), tasks, { ngram: 2 })).toEqual([]);
  });

  it("RS21.12 object keys, at any depth, are text the edit adds", () => {
    const tasks: Task[] = [{ id: "t1", text: "reconcile the ledger" }];
    expect(leaks(added("/x", { reconcile: { the: { ledger: 1 } } }), tasks, { ngram: 2 })).toEqual([]);
    expect(leaks(added("/x", { "reconcile the ledger": 1 }), tasks, { ngram: 2 })).toEqual(['it repeats "reconcile the" from task t1']);
  });

  it("RS21.13 a path names a task by its segments, not by the pointer's leading slash", () => {
    const tasks: Task[] = [{ id: "/deep", text: "unrelated words here" }];
    expect(leaks(added("/deep", 1), tasks, { ngram: 2 })).toEqual([]);
    expect(leaks(added("/a/deep", 1), tasks, { ngram: 2 })).toEqual([]);
    expect(leaks(added("/a//deep", 1), tasks, { ngram: 2 })).toEqual(["it names task /deep"]);
  });

  it("RS21.14 the root path names nothing", () => {
    expect(leaks(wrote({ op: "replace", path: "", value: 5 }), [{ id: "", text: "words" }], { ngram: 2 })).toEqual([]);
  });

  it("RS21.15 a path's segments read as spaced words name a task whose id has spaces", () => {
    const tasks: Task[] = [{ id: "invoice batch 77", text: "unrelated" }];
    expect(leaks(added("/overrides/invoice/batch/77", true), tasks, { ngram: 2 })).toEqual(["it names task invoice batch 77"]);
  });

  it("RS21.16 a removal adds no text", () => {
    const tasks: Task[] = [{ id: "t1", text: "Stryker was here" }];
    expect(leaks(wrote({ op: "remove", path: "/x" }), tasks, { ngram: 3 })).toEqual([]);
  });

  it("RS21.17 a task without a reference answer has no reference words", () => {
    const tasks: Task[] = [{ id: "t1", text: "summarize the incident" }];
    expect(leaks(added("/x", "stryker was here"), tasks, { ngram: 3 })).toEqual([]);
    expect(leaks(added("/x", "the incident stryker"), tasks, { ngram: 3 })).toEqual([]);
    expect(leaks(added("/x", "the incident was"), tasks, { ngram: 3 })).toEqual([]);
    expect(leaks(added("/x", "summarize the incident"), tasks, { ngram: 3 })).toEqual(['it repeats "summarize the incident" from task t1']);
  });

  it("RS21.18 a task whose text is exactly n words long can be repeated", () => {
    const tasks: Task[] = [{ id: "t1", text: "alpha beta gamma" }];
    expect(leaks(added("/x", "alpha beta gamma"), tasks, { ngram: 3 })).toEqual(['it repeats "alpha beta gamma" from task t1']);
    expect(leaks(added("/x", "alpha beta"), [{ id: "t1", text: "alpha beta" }], { ngram: 2 })).toEqual(['it repeats "alpha beta" from task t1']);
  });

  it("RS21.19 a run shorter than n words is not a run of n words, at the end of a task's text", () => {
    const tasks: Task[] = [{ id: "t1", text: "alpha beta gamma delta" }];
    expect(leaks(added("/x", "gamma delta"), tasks, { ngram: 3 })).toEqual([]);
    expect(leaks(added("/x", "delta"), tasks, { ngram: 3 })).toEqual([]);
  });
});
