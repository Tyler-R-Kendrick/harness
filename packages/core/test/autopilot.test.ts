import { describe, expect, it } from "vitest";
import { Autopilot, InputInterpreter, parseOpenExperiment } from "@harness/core";
import type { AutopilotFinding, AutopilotGoal, DecisionAnswer, InputContext } from "@harness/core";

const prior: InputContext = { turns: [{ role: "user", text: "hi" }] };


function finding(kind: AutopilotFinding["kind"], subject: string, detail: string, sourceSystem?: string): AutopilotFinding {
  return { kind, subject, detail, ...(sourceSystem === undefined ? {} : { sourceSystem }) };
}

function pilot(options: {
  findings?: AutopilotFinding[];
  id?: () => string;
  implement?: (goal: AutopilotGoal) => string | Promise<string>;
} = {}) {
  const findings = options.findings ?? [];
  const goals: AutopilotGoal[] = [];
  let surveys = 0;
  const engine = new Autopilot({
    survey: () => {
      surveys += 1;
      return findings;
    },
    implement: async (goal) => {
      goals.push(goal);
      return options.implement?.(goal) ?? `did ${goal.subject}`;
    },
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  return { engine, goals, findings, surveys: () => surveys };
}

describe("autopilot", () => {
  it("AP1.1 an unsteered run lands each survey finding once, cycling kinds, then waits while it stays running", async () => {
    const { engine, goals } = pilot({
      findings: [
        finding("upgrade", "left-pad", "1.1.0"),
        finding("upgrade", "left-pad", "again"),
        finding("upgrade", "vitest", "4.2.0"),
        finding("vulnerability", "CVE-1", "prototype"),
        finding("research", "sparse", "SOTA checkout"),
        finding("experiment", "startup", "lower latency"),
      ],
      id: sequence("u"),
    });
    expect(await engine.step()).toBeUndefined();
    expect(engine.running).toBe(false);
    engine.start();
    const landed = [];
    for (let index = 0; index < 5; index += 1) landed.push(await engine.step());
    expect(landed.map((update) => update?.subject)).toEqual(["left-pad", "CVE-1", "sparse", "startup", "vitest"]);
    expect(landed.map((update) => update?.kind)).toEqual(["upgrade", "vulnerability", "research", "experiment", "upgrade"]);
    expect(await engine.step()).toBeUndefined();
    expect(engine.running).toBe(true);
    expect(goals).toHaveLength(5);
    expect(goals.every((goal) => goal.branch.startsWith("autopilot/") && goal.branch !== "main" && goal.branch !== "master")).toBe(true);
  });

  it("AP1.2 a finding already landed is skipped, and a finding that shows up later is landed", async () => {
    const { engine, findings } = pilot({ findings: [finding("upgrade", "left-pad", "1.1.0")], id: sequence("u") });
    engine.start();
    expect((await engine.step())?.subject).toBe("left-pad");
    expect(await engine.step()).toBeUndefined();
    findings.push(finding("research", "paper", "the new checkout"));
    expect((await engine.step())?.subject).toBe("paper");
    expect(engine.running).toBe(true);
  });

  it("AP1.3 an update carries release notes for its branch and is not applied", async () => {
    const { engine } = pilot({
      findings: [finding("upgrade", "left-pad", "1.1.0")],
      id: () => "u1",
      implement: () => "bumped",
    });
    engine.start();
    const update = await engine.step();
    expect(update).toEqual({
      id: "u1",
      branch: "autopilot/u1",
      kind: "upgrade",
      subject: "left-pad",
      applied: false,
      notes: "upgrade: left-pad\n\nbranch: autopilot/u1\nnot applied to the trunk\n\n1.1.0\n\nbumped",
    });
    const listed = engine.updates();
    listed.push({ id: "extra", branch: "main", kind: "upgrade", subject: "x", applied: true, notes: "no" });
    expect(engine.updates().map((item) => item.id)).toEqual(["u1"]);
  });

  it("AP1.4 apply marks the update and leaves its branch and notes, and an unknown id throws", async () => {
    const { engine, goals } = pilot({ findings: [finding("vulnerability", "CVE-1", "prototype")], id: () => "u1" });
    engine.start();
    await engine.step();
    const applied = engine.apply("u1");
    expect(applied.applied).toBe(true);
    expect(applied.branch).toBe("autopilot/u1");
    expect(applied.notes).toContain("not applied to the trunk");
    expect(engine.updates()[0]?.applied).toBe(true);
    expect(goals).toHaveLength(1);
    expect(() => engine.apply("missing")).toThrow(TypeError);
    expect(() => engine.apply("missing")).toThrow(/missing/);
  });

  it("AP1.5 interrupt stops further goals without surveying again", async () => {
    let surveys = 0;
    const engine = new Autopilot({
      survey: () => {
        surveys += 1;
        return [finding("upgrade", "left-pad", "1.1.0"), finding("upgrade", "vitest", "4.2.0")];
      },
      implement: () => "did",
      id: sequence("u"),
    });
    engine.start();
    expect((await engine.step())?.subject).toBe("left-pad");
    const calls = surveys;
    engine.interrupt();
    expect(engine.running).toBe(false);
    expect(await engine.step()).toBeUndefined();
    expect(surveys).toBe(calls);
    expect(engine.apply("u1").applied).toBe(true);
  });

  it("AP1.6 steering is the goal, then survey findings are annotated with it, then the run waits", async () => {
    const { engine, goals, surveys } = pilot({
      findings: [finding("upgrade", "left-pad", "1.1.0")],
      id: sequence("u"),
      implement: () => "noted",
    });
    engine.start("read the paper");
    const first = await engine.step();
    expect(surveys()).toBe(0);
    expect(first?.kind).toBe("research");
    expect(first?.notes).toBe("research: read the paper\n\nbranch: autopilot/u1\nnot applied to the trunk\nsteering: read the paper\n\nnoted");
    const second = await engine.step();
    expect(second?.subject).toBe("left-pad");
    expect(goals[1]?.steering).toBe("read the paper");
    expect(second?.notes).toContain("steering: read the paper");
    expect(await engine.step()).toBeUndefined();
    expect(engine.running).toBe(true);
    expect(goals).toHaveLength(2);
  });

  it("AP1.7 steering words select upgrade, vulnerability, or experiment, and anything else is research", async () => {
    const cases: readonly [string, AutopilotFinding["kind"]][] = [
      ["upgrade the experiment", "upgrade"],
      ["upgrades", "upgrade"],
      ["dependencies", "upgrade"],
      ["CVE-2024-1 is open", "vulnerability"],
      ["vulnerability in the parser", "vulnerability"],
      ["performance of startup", "experiment"],
      ["run an experiment", "experiment"],
      ["read the paper", "research"],
    ];
    for (const [text, kind] of cases) {
      const { engine } = pilot({ id: () => "u1" });
      engine.start(text);
      expect((await engine.step())?.kind).toBe(kind);
    }
  });

  it("AP1.8 an experiment update is an Open Experiment Standard 0.1.0 document with no computed result", async () => {
    const { engine } = pilot({ findings: [finding("experiment", "startup", "lower latency")], id: () => "u1" });
    engine.start();
    const update = await engine.step();
    const experiment = {
      schemaVersion: "0.1.0",
      objectType: "experiment",
      sourceSystem: "harness",
      experiment: { id: "u1", title: "startup", status: "draft", hypothesis: "lower latency" },
      design: { type: "ab", randomizationUnit: "session" },
      variants: [
        { id: "control", key: "control", name: "Control", role: "control" },
        { id: "treatment", key: "treatment", name: "Treatment", role: "treatment" },
      ],
      metrics: [{ id: "primary", name: "startup", role: "primary", direction: "increase_is_good" }],
      analysis: {},
      results: {},
      scorecard: {},
      decision: { status: "pending" },
      qualityChecks: [],
      artifacts: [],
      provenance: {},
      extensions: {},
    };
    expect(update?.experiment).toEqual(experiment);
    expect(JSON.stringify(update?.experiment)).not.toContain("pValue");
    expect(parseOpenExperiment(update?.experiment)).toEqual(experiment);
    expect(engine.updates()[0]?.experiment).toEqual(experiment);
  });

  it("AP1.9 sourceSystem is launchdarkly only when the finding says so", async () => {
    const { engine } = pilot({
      findings: [
        finding("experiment", "from-vendor", "latency", "launchdarkly"),
        finding("experiment", "named-in-prose", "LaunchDarkly exposes this"),
        finding("experiment", "other-vendor", "latency", "growthbook"),
      ],
      id: sequence("u"),
    });
    engine.start();
    expect((await engine.step())?.experiment?.sourceSystem).toBe("launchdarkly");
    expect((await engine.step())?.experiment?.sourceSystem).toBe("harness");
    expect((await engine.step())?.experiment?.sourceSystem).toBe("growthbook");
  });

  it("AP1.10 a bad id, a repeated id, a failed implement, or a bad survey records nothing for that step", async () => {
    const badId = pilot({ findings: [finding("upgrade", "left-pad", "1.1.0")], id: () => "a/b" });
    badId.engine.start();
    await expect(badId.engine.step()).rejects.toThrow(TypeError);
    expect(badId.goals).toEqual([]);
    expect(badId.engine.updates()).toEqual([]);

    const ids = ["u1", "u1", "u2"];
    const repeated = pilot({
      findings: [finding("upgrade", "left-pad", "1.1.0"), finding("upgrade", "vitest", "4.2.0")],
      id: () => ids.shift() ?? "u9",
    });
    repeated.engine.start();
    await repeated.engine.step();
    await expect(repeated.engine.step()).rejects.toThrow(/u1/);
    expect(repeated.engine.updates().map((update) => update.subject)).toEqual(["left-pad"]);
    expect((await repeated.engine.step())?.subject).toBe("vitest");

    const failed = pilot({
      findings: [finding("upgrade", "left-pad", "1.1.0")],
      id: () => "u1",
      implement: () => { throw new Error("disk"); },
    });
    failed.engine.start();
    await expect(failed.engine.step()).rejects.toThrow("disk");
    expect(failed.engine.updates()).toEqual([]);
    expect(failed.engine.running).toBe(true);

    const poisoned = new Autopilot({
      survey: () => [{ kind: "upgrade", subject: "", detail: "x" }],
      implement: () => "did",
    });
    poisoned.start();
    await expect(poisoned.step()).rejects.toThrow(TypeError);
    expect(poisoned.updates()).toEqual([]);

    const generated = new Autopilot({
      survey: () => [finding("research", "paper", "note")],
      implement: () => "did",
    });
    generated.start();
    expect((await generated.step())?.branch).toBe("autopilot/ap-1");

    const weird = new Autopilot({
      survey: () => [finding("upgrade", "left-pad", "1.1.0")],
      implement: () => JSON.parse("1"),
    });
    weird.start();
    await expect(weird.step()).rejects.toThrow(TypeError);
    expect(weird.updates()).toEqual([]);
  });

  it("AP1.11 a value that is not an Open Experiment Standard 0.1.0 document is rejected", () => {
    const minimal = { schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" } };
    expect(parseOpenExperiment(minimal)).toEqual(minimal);
    expect(parseOpenExperiment({ ...minimal, analysis: { method: "frequentist" } })).toEqual({ ...minimal, analysis: { method: "frequentist" } });
    expect(() => parseOpenExperiment(null)).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment" })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.9.0", objectType: "experiment", experiment: { id: "a", title: "b" } })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "flag", experiment: { id: "a", title: "b" } })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a" } })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b", status: "nope" } })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" }, design: { type: "banana" } })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" }, variants: [{ id: "c" }] })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" }, metrics: [{ id: "m", name: "n", role: "winner" }] })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" }, decision: { outcome: "yolo" } })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" }, sourceSystem: 1 })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" }, qualityChecks: [{}] })).toThrow(TypeError);
    expect(() => parseOpenExperiment({ schemaVersion: "0.1.0", objectType: "experiment", experiment: { id: "a", title: "b" }, artifacts: [{ type: "sql" }] })).toThrow(TypeError);
  });

  it("AP2.1 /autopilot starts an unsteered run and /autopilot <instructions> steers, without the decision model", async () => {
    const { engine, seen, goals } = interpreter({ findings: [finding("upgrade", "left-pad", "1.1.0")], id: sequence("u") });
    expect(await run(engine, "/autopilot")).toEqual({ type: "autopilot", view: "started", running: true });
    expect(engine.autopilot.running).toBe(true);
    expect(await engine.autopilot.step()).toMatchObject({ subject: "left-pad", branch: "autopilot/u1" });
    expect(await run(engine, "/autopilot read the paper")).toEqual({ type: "autopilot", view: "started", running: true, steering: "read the paper" });
    expect((await engine.autopilot.step())?.subject).toBe("read the paper");
    expect(goals.at(-1)?.steering).toBe("read the paper");
    expect(seen.decide).toEqual([]);
    expect(seen.infer).toEqual([]);
  });

  it("AP2.2 --help describes autopilot and does not start it", async () => {
    const { engine, seen } = interpreter();
    const help = await run(engine, "/autopilot --help");
    expect(help).toMatchObject({ type: "help", name: "autopilot" });
    if (help.type === "help") {
      const page = manualSections(help.message);
      expect(page["SYNOPSIS"]).toBe("/autopilot [instructions]");
      expect(page["DESCRIPTION"]).toContain("Proposes its own goals until interrupted.");
      expect(page["DESCRIPTION"]).toContain("Open Experiment Standard 0.1.0");
      expect(page["DESCRIPTION"]).toContain("not applied to the trunk until /autopilot apply <id>");
      expect(page["OPTIONS"]).toMatch(/does not run/);
    }
    const updates = await run(engine, "/autopilot updates --help");
    expect(updates).toMatchObject({ type: "help", name: "autopilot updates" });
    if (updates.type === "help") {
      const page = manualSections(updates.message);
      expect(page["SYNOPSIS"]).toBe("/autopilot updates");
      expect(page["DESCRIPTION"]).toContain("Lists harness updates. Each one is the reviewable branch and its release notes.");
    }
    const apply = await run(engine, "/autopilot apply --help");
    expect(apply).toMatchObject({ type: "help", name: "autopilot apply" });
    if (apply.type === "help") {
      const page = manualSections(apply.message);
      expect(page["SYNOPSIS"]).toBe("/autopilot apply <id>");
      expect(page["DESCRIPTION"]).toContain("Marks one update applied. It does not change the trunk.");
    }
    const stop = await run(engine, "/autopilot stop --help");
    expect(stop).toMatchObject({ type: "help", name: "autopilot stop" });
    if (stop.type === "help") {
      const page = manualSections(stop.message);
      expect(page["SYNOPSIS"]).toBe("/autopilot stop");
      expect(page["DESCRIPTION"]).toContain("Interrupts the run.");
    }
    expect(await run(engine, "/autopilot upgrade deps --help")).toEqual(help);
    expect(engine.autopilot.running).toBe(false);
    expect(engine.autopilot.updates()).toEqual([]);
    expect(seen.decide).toEqual([]);
  });

  it("AP2.3 updates lists the run, apply marks one, stop and any other line interrupt before the decision model", async () => {
    const { engine, seen } = interpreter({
      findings: [finding("upgrade", "left-pad", "1.1.0"), finding("upgrade", "vitest", "4.2.0")],
      id: sequence("u"),
      decide: () => {
        expect(engine.autopilot.running).toBe(false);
        return { choice: "message", complicated: false };
      },
    });
    await run(engine, "/autopilot");
    await engine.autopilot.step();
    const listed = await run(engine, "/autopilot updates");
    expect(listed).toMatchObject({ type: "autopilot", view: "updates" });
    if (listed.type !== "autopilot" || listed.view !== "updates") throw new Error("expected the update list");
    expect(listed.updates.map((update) => update.id)).toEqual(["u1"]);
    expect(engine.autopilot.running).toBe(true);
    expect(await run(engine, "/autopilot apply u1")).toMatchObject({ type: "autopilot", view: "applied", update: { id: "u1", applied: true, branch: "autopilot/u1" } });
    expect(await run(engine, "/autopilot apply")).toEqual({ type: "command-usage", name: "autopilot", message: "usage: /autopilot [instructions | updates | apply <id> | stop]" });
    expect(await run(engine, "/autopilot apply u1 extra")).toEqual({ type: "command-usage", name: "autopilot", message: "usage: /autopilot [instructions | updates | apply <id> | stop]" });
    expect(await run(engine, "/autopilot stop now")).toEqual({ type: "command-usage", name: "autopilot", message: "usage: /autopilot [instructions | updates | apply <id> | stop]" });
    expect(engine.autopilot.running).toBe(true);
    expect(await run(engine, "/autopilot stop")).toEqual({ type: "autopilot", view: "stopped", running: false });
    await run(engine, "/autopilot");
    await engine.autopilot.step();
    expect(await run(engine, "please wait")).toEqual({ type: "message", text: "please wait" });
    expect(engine.autopilot.running).toBe(false);
    expect(seen.decide).toHaveLength(1);
    expect(await engine.autopilot.step()).toBeUndefined();
    await expect(run(engine, "/autopilot apply missing")).rejects.toThrow(/missing/);
  });

  it("AP2.4 typeahead offers /autopilot and its subcommands, and does not run it", async () => {
    const { engine, seen } = interpreter({
      findings: [finding("upgrade", "left-pad", "1.1.0")],
      id: () => "u1",
      decide: () => { throw new Error("down"); },
    });
    expect((await engine.complete("/", prior)).completions.map((item) => item.text)).toEqual(["/tools", "/sessions", "/settings", "/autopilot"]);
    expect((await engine.complete("/autopilot", prior)).completions.map((item) => item.text)).toEqual([
      "/autopilot",
      "/autopilot updates",
      "/autopilot apply",
      "/autopilot stop",
      "/autopilot --help",
    ]);
    expect((await engine.complete("/autopilot ", prior)).completions.map((item) => item.text)).toEqual([
      "/autopilot updates",
      "/autopilot apply",
      "/autopilot stop",
      "/autopilot --help",
    ]);
    await run(engine, "/autopilot");
    await engine.autopilot.step();
    expect((await engine.complete("/autopilot apply ", prior)).completions.map((item) => item.text)).toEqual(["/autopilot apply u1", "/autopilot apply --help"]);
    expect(engine.autopilot.running).toBe(true);
    expect(seen.infer).toEqual([]);
  });

  it("AP2.5 the command name autopilot is built in", () => {
    expect(() => new InputInterpreter({ tools: [], commands: [{ name: "autopilot", description: "Mine." }] }, { decide: () => ({ choice: "message", complicated: false }), infer: () => ({ ok: false }) })).toThrow(/autopilot is built in/);
  });

  it("AP2.6 /sessions while autopilot is running interrupts the run and still lists sessions", async () => {
    const { engine, seen } = interpreter();
    await run(engine, "/autopilot performance of startup");
    expect(engine.autopilot.running).toBe(true);
    const action = await run(engine, "/sessions");
    expect(action.type).toBe("command-usage");
    expect(engine.autopilot.running).toBe(false);
    expect(await engine.autopilot.step()).toBeUndefined();
    expect(seen.decide).toEqual([]);
  });
});

function sequence(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${String(n)}`;
  };
}

function interpreter(options: {
  findings?: AutopilotFinding[];
  id?: () => string;
  decide?: () => DecisionAnswer;
} = {}) {
  const seen = { decide: [] as string[], infer: [] as string[] };
  const goals: AutopilotGoal[] = [];
  const engine = new InputInterpreter({
    tools: [],
    commands: [],
    autopilot: {
      survey: () => options.findings ?? [],
      implement: (goal) => {
        goals.push(goal);
        return `did ${goal.subject}`;
      },
      ...(options.id === undefined ? {} : { id: options.id }),
    },
  }, {
    decide: () => {
      seen.decide.push("decide");
      return options.decide?.() ?? { choice: "message", complicated: false };
    },
    infer: () => {
      seen.infer.push("infer");
      return { ok: false };
    },
  });
  return { engine, seen, goals };
}

async function run(engine: InputInterpreter, text: string) {
  return (await engine.submit(text, prior, 5)).action;
}

function manualSections(message: string): Record<string, string> {
  const headings = ["NAME", "SYNOPSIS", "DESCRIPTION", "OPTIONS", "EXAMPLES", "SEE ALSO"];
  let cursor = 0;
  const at: number[] = [];
  for (const heading of headings) {
    const found = message.indexOf(heading, cursor);
    expect(found).toBeGreaterThanOrEqual(cursor);
    at.push(found);
    cursor = found + heading.length;
  }
  const sections: Record<string, string> = {};
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const start = at[index]! + heading.length;
    const end = at[index + 1] ?? message.length;
    sections[heading] = message.slice(start, end).trim();
  }
  for (const heading of headings) expect(sections[heading]?.length ?? 0).toBeGreaterThan(0);
  return sections;
}
