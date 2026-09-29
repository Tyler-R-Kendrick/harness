import { expect, it } from "vitest";
import { frontierSearch } from "@harness/cognitive";
import type { FrontierDomain, FrontierJudge } from "@harness/cognitive";

interface Box {
  readonly id: string;
}

function domain(start: Box, moves: (state: Box) => { readonly children: readonly Box[]; readonly cost: number }, options?: {
  readonly goal?: (state: Box) => boolean;
  readonly dead?: (state: Box) => boolean;
  readonly key?: (state: Box) => string;
  readonly compare?: (a: Box, b: Box) => number;
  readonly judgeCost?: (states: readonly Box[]) => number;
}): FrontierDomain<Box> & { readonly proposed: Box[] } {
  const proposed: Box[] = [];
  return {
    start,
    proposed,
    key: options?.key ?? ((state) => state.id),
    compare: options?.compare ?? ((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    isGoal: options?.goal ?? (() => false),
    isDead: options?.dead ?? (() => false),
    judgeCost: options?.judgeCost ?? ((states) => states.length),
    async propose(state) {
      proposed.push(state);
      return moves(state);
    },
  };
}

const box = (id: string): Box => ({ id });

it("FR1.1 two proposals of one key keep the compare minimum, not the earlier one", async () => {
  const early = box("early");
  const late = box("late");
  const graph = domain(box("start"), () => ({ children: [early, late], cost: 1 }), {
    key: (state) => (state.id === "start" ? "start" : "same"),
    compare: (a, b) => (a.id === "late" ? -1 : b.id === "late" ? 1 : 0),
    goal: (state) => state.id === "late",
    judgeCost: () => 1,
  });
  const judge: FrontierJudge<Box> = () => [1];
  await expect(frontierSearch(graph, judge, { width: 1, budget: 10 })).resolves.toEqual({
    solved: true,
    state: late,
    cost: 2,
    rounds: 1,
    orderedBy: "score",
  });
  await expect(frontierSearch(domain(box("start"), () => ({ children: [early, late], cost: 1 }), {
    key: (state) => (state.id === "start" ? "start" : "same"),
    compare: () => 0,
    judgeCost: () => 1,
  }), () => [1], { width: 1, budget: 10 })).rejects.toThrow(TypeError);
});

it("FR1.2 an already expanded key is dropped and the search does not propose again", async () => {
  const start = box("start");
  const next = box("next");
  let calls = 0;
  const graph = domain(start, (state) => {
    calls += 1;
    return { children: [state.id === "start" ? next : start], cost: 1 };
  }, { judgeCost: () => 1 });
  const result = await frontierSearch(graph, () => [0], { width: 1, budget: 10 });
  expect(result).toEqual({ solved: false, cost: 3, rounds: 2, reason: "no-progress" });
  expect(calls).toBe(2);
});

it("FR1.3 a dead child is not admitted, and a dead goal is not solved", async () => {
  const deadGoal = box("dead-goal");
  const open = box("open");
  const goal = box("goal");
  const graph = domain(box("start"), (state) => {
    if (state.id === "start") return { children: [deadGoal, open], cost: 1 };
    return { children: [goal], cost: 1 };
  }, {
    goal: (state) => state.id === "dead-goal" || state.id === "goal",
    dead: (state) => state.id === "dead-goal",
    judgeCost: () => 1,
  });
  const result = await frontierSearch(graph, () => [1], { width: 1, budget: 10 });
  expect(result).toEqual({ solved: true, state: goal, cost: 4, rounds: 2, orderedBy: "score" });
  expect(graph.proposed.map((state) => state.id)).toEqual(["start", "open"]);
});

it("FR1.4 the next round proposes only the best width states", async () => {
  const best = box("best");
  const mid = box("mid");
  const worst = box("worst");
  const graph = domain(box("start"), (state) => {
    if (state.id === "start") return { children: [worst, mid, best], cost: 1 };
    return { children: [box("done")], cost: 1 };
  }, {
    goal: (state) => state.id === "done",
    judgeCost: () => 0,
  });
  const scores: Record<string, number> = { best: 3, mid: 2, worst: 1, done: 1 };
  await frontierSearch(graph, (states) => states.map((state) => scores[state.id] ?? 0), { width: 1, budget: 10 });
  expect(graph.proposed.map((state) => state.id)).toEqual(["start", "best"]);
});

it("FR1.5 equal scores yield to the higher vote, then to the ascending key", async () => {
  const left = box("left");
  const right = box("right");
  const first = box("z-first");
  const second = box("a-second");
  const byVote = domain(box("start"), (state) => {
    if (state.id === "start") return { children: [left, right], cost: 1 };
    if (state.id === "left") return { children: [first, second], cost: 1 };
    return { children: [second], cost: 1 };
  }, { compare: (a, b) => (a.id === b.id ? -1 : a.id < b.id ? -1 : 1), goal: (state) => state.id === "a-second" || state.id === "z-first", judgeCost: () => 1 });
  const voted = await frontierSearch(byVote, (states) => states.map(() => 1), { width: 2, budget: 20 });
  expect(voted).toMatchObject({ solved: true, state: second, orderedBy: "score" });

  const byKey = domain(box("start"), (state) => {
    if (state.id === "start") return { children: [left, right], cost: 1 };
    if (state.id === "left") return { children: [first], cost: 1 };
    return { children: [second], cost: 1 };
  }, { compare: (a, b) => (a.id === b.id ? -1 : a.id < b.id ? -1 : 1), goal: (state) => state.id === "a-second" || state.id === "z-first", judgeCost: () => 1 });
  const keyed = await frontierSearch(byKey, (states) => states.map(() => 1), { width: 2, budget: 20 });
  expect(keyed).toMatchObject({ solved: true, state: second, orderedBy: "score" });

  const seen: string[][] = [];
  const ordered = domain(box("start"), () => ({ children: [box("c"), box("a"), box("b")], cost: 1 }), {
    goal: (state) => state.id !== "start",
    judgeCost: () => 1,
  });
  await frontierSearch(ordered, (states) => {
    seen.push(states.map((state) => state.id));
    return states.map(() => 1);
  }, { width: 1, budget: 5 });
  expect(seen[0]).toEqual(["a", "b", "c"]);
});

it("FR1.6 two goals return the one the tie order ranks first", async () => {
  const earlier = box("m-earlier");
  const later = box("z-later");
  const graph = domain(box("start"), () => ({ children: [earlier, later], cost: 1 }), {
    goal: (state) => state.id !== "start",
    judgeCost: () => 1,
  });
  await expect(frontierSearch(graph, (states) => states.map((state) => (state.id === "z-later" ? 3 : 0)), { width: 1, budget: 10 })).resolves.toEqual({
    solved: true,
    state: later,
    cost: 2,
    rounds: 1,
    orderedBy: "score",
  });
  const mixed = domain(box("start"), () => ({ children: [box("goal"), box("open")], cost: 0 }), {
    goal: (state) => state.id === "goal",
    judgeCost: () => 0,
  });
  await expect(frontierSearch(mixed, (states) => states.map((state) => (state.id === "goal" ? 1 : 0)), { width: 1, budget: 5 })).resolves.toMatchObject({
    solved: true,
    state: box("goal"),
    orderedBy: "score",
  });
});

it("FR1.7 a free open round returns no-progress and does not judge", async () => {
  let judged = 0;
  const graph = domain(box("start"), () => ({ children: [box("open")], cost: 0 }), { judgeCost: () => 0 });
  const result = await frontierSearch(graph, () => {
    judged += 1;
    return [1];
  }, { width: 1, budget: 10 });
  expect(result).toEqual({ solved: false, cost: 0, rounds: 1, reason: "no-progress" });
  expect(judged).toBe(0);
  expect(graph.proposed).toHaveLength(1);
});

it("FR1.8 a spent round with nothing admitted does not restart", async () => {
  const start = box("start");
  const graph = domain(start, () => ({ children: [box("dead")], cost: 5 }), { dead: (state) => state.id === "dead", judgeCost: () => 1 });
  const result = await frontierSearch(graph, () => [1], { width: 1, budget: 10 });
  expect(result).toEqual({ solved: false, cost: 5, rounds: 1, reason: "no-progress" });
  expect(graph.proposed).toEqual([start]);
});

it("FR1.9 a zero budget does not propose, and a round may finish over the budget", async () => {
  const idle = domain(box("start"), () => ({ children: [box("open")], cost: 1 }));
  await expect(frontierSearch(idle, () => [1], { width: 1, budget: 0 })).resolves.toEqual({ solved: false, cost: 0, rounds: 0, reason: "budget" });
  expect(idle.proposed).toHaveLength(0);
  const graph = domain(box("start"), () => ({ children: [box("open")], cost: 3 }), { judgeCost: () => 0 });
  const result = await frontierSearch(graph, () => [1], { width: 1, budget: 1 });
  expect(result).toEqual({ solved: false, cost: 3, rounds: 1, reason: "budget" });
  expect(graph.proposed).toHaveLength(1);
});

it("FR1.10 a null judge orders by votes, including a sum above 1", async () => {
  const left = box("left");
  const right = box("right");
  const sharedA = box("shared-a");
  const sharedB = box("shared-b");
  const graph = domain(box("start"), (state) => {
    if (state.id === "start") return { children: [left, right], cost: 1 };
    if (state.id === "left") return { children: [sharedA], cost: 1 };
    return { children: [sharedB], cost: 1 };
  }, {
    key: (state) => (state.id.startsWith("shared") ? "shared" : state.id),
    compare: (a, b) => (a.id < b.id ? -1 : 1),
    goal: (state) => state.id.startsWith("shared"),
    judgeCost: () => 1,
  });
  await expect(frontierSearch(graph, () => null, { width: 2, budget: 20 })).resolves.toMatchObject({
    solved: true,
    state: sharedA,
    orderedBy: "votes",
  });
});

it("FR1.11 a higher score outranks a higher vote", async () => {
  const popular = box("a-popular");
  const better = box("b-better");
  const graph = domain(box("start"), () => ({ children: [popular, better], cost: 1 }), {
    goal: (state) => state.id === "a-popular" || state.id === "b-better",
    judgeCost: () => 1,
  });
  await expect(frontierSearch(graph, (states) => states.map((state) => (state.id === "b-better" ? 2 : 0.9)), { width: 1, budget: 10 })).resolves.toEqual({
    solved: true,
    state: better,
    cost: 2,
    rounds: 1,
    orderedBy: "score",
  });
});

it("FR1.12 a non-finite score or a short score list throws before another proposal", async () => {
  const finite = domain(box("start"), () => ({ children: [box("open")], cost: 1 }), { judgeCost: () => 1 });
  await expect(frontierSearch(finite, () => [Number.POSITIVE_INFINITY], { width: 1, budget: 10 })).rejects.toThrow(/score/);
  expect(finite.proposed).toHaveLength(1);
  const short = domain(box("start"), () => ({ children: [box("open")], cost: 1 }), { judgeCost: () => 1 });
  await expect(frontierSearch(short, () => [], { width: 1, budget: 10 })).rejects.toThrow(/score/);
  expect(short.proposed).toHaveLength(1);
});

it("FR1.13 a goal start is solved and a dead start is not proposed", async () => {
  const goal = domain(box("start"), () => ({ children: [], cost: 1 }), { goal: () => true });
  await expect(frontierSearch(goal, () => [1], { width: 1, budget: 10 })).resolves.toEqual({
    solved: true,
    state: box("start"),
    cost: 0,
    rounds: 0,
    orderedBy: "start",
  });
  expect(goal.proposed).toHaveLength(0);
  const dead = domain(box("start"), () => ({ children: [], cost: 1 }), { dead: () => true, goal: () => true });
  await expect(frontierSearch(dead, () => [1], { width: 1, budget: 10 })).resolves.toEqual({
    solved: false,
    cost: 0,
    rounds: 0,
    reason: "no-progress",
  });
  expect(dead.proposed).toHaveLength(0);
});

it("FR1.14 a limit or a proposal outside the contract throws", async () => {
  const open = () => ({ children: [box("open")], cost: 1 });
  const idle = domain(box("start"), open);
  await expect(frontierSearch(idle, () => [1], { width: 0, budget: 1 })).rejects.toThrow(/width/);
  await expect(frontierSearch(domain(box("start"), open), () => [1], { width: 1.5, budget: 1 })).rejects.toThrow(/width/);
  await expect(frontierSearch(domain(box("start"), open), () => [1], { width: 1, budget: Number.NaN })).rejects.toThrow(/budget/);
  await expect(frontierSearch(domain(box("start"), open), () => [1], { width: 1, budget: -1 })).rejects.toThrow(/budget/);
  expect(idle.proposed).toHaveLength(0);

  const badKey = domain(box("start"), open, { key: () => 1 as never });
  await expect(frontierSearch(badKey, () => [1], { width: 1, budget: 5 })).rejects.toThrow(/key/);
  const badCost = domain(box("start"), () => ({ children: [box("open")], cost: Number.POSITIVE_INFINITY }));
  await expect(frontierSearch(badCost, () => [1], { width: 1, budget: 5 })).rejects.toThrow(/cost/);
  const badChildren = domain(box("start"), () => ({ children: null as never, cost: 1 }));
  await expect(frontierSearch(badChildren, () => [1], { width: 1, budget: 5 })).rejects.toThrow(/children/);
  const badCompare = domain(box("start"), () => ({ children: [box("a"), box("b")], cost: 1 }), {
    key: (state) => (state.id === "start" ? "start" : "same"),
    compare: () => Number.NaN,
  });
  await expect(frontierSearch(badCompare, () => [1], { width: 1, budget: 5 })).rejects.toThrow(/compare/);
  const badJudgeCost = domain(box("start"), open, { judgeCost: () => -1 });
  await expect(frontierSearch(badJudgeCost, () => [1], { width: 1, budget: 5 })).rejects.toThrow(/cost/);
  const badScores = domain(box("start"), open);
  await expect(frontierSearch(badScores, () => 1 as never, { width: 1, budget: 5 })).rejects.toThrow(/scores/);
});
