/**
 * Permission risk: how careful a person should be about a permission request. The layer
 * only ANNOTATES. It never approves anything: a permission request is answered by a person
 * (the daemon's permission flow), and this fork says how much attention it deserves.
 *
 * The floor is a deterministic authority (`data/permission.json`, forbid wins, default is
 * to escalate) evaluated over the facts, mapped allow to routine, escalate to careful and
 * deny to critical. A model's verdict can raise the level and never lower it (monotone
 * authority, ADR 0030), so a model cannot make a request look safer than the authority
 * says it is. Records and models see the facts with secrets removed.
 */
import { probability, ProbabilitySchema } from "@harness/cognitive";
import { z } from "zod";
import { AuthoritySchema, authorityJsonSchema, evaluateAuthority } from "./authority.ts";
import type { Authority, Effect } from "./authority.ts";
import { SCAN_LIMIT, scrubJson, scrubText } from "./scrub.ts";
import { forkId } from "./types.ts";
import type { Fork, Json, Verdict } from "./types.ts";

/** How careful to be, least first. */
export const RISK_LEVELS = ["routine", "careful", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** What the authority's effect means for a request: allow is routine, escalate careful, deny critical. */
export const RISK_OF_EFFECT: Readonly<Record<Effect, RiskLevel>> = { allow: "routine", escalate: "careful", deny: "critical" };

/** What the daemon knows about a permission request. */
export interface PermissionFacts {
  /** The tool asking. */
  readonly tool: string;
  /** The tool's kind (the ACP kinds: read, edit, delete, move, search, execute, think, fetch, other). */
  readonly kind?: string;
  /** The command, for a tool that runs one. */
  readonly command?: string;
  /** The file the tool reads or changes. */
  readonly path?: string;
  /** The address the tool fetches or sends to. */
  readonly url?: string;
  /** The session's working directory, to tell what is outside it. */
  readonly cwd?: string;
  readonly session?: string;
  /** What the tool was given, whatever it is. */
  readonly input?: { readonly [key: string]: Json };
}

// ---- the authority --------------------------------------------------------------------------------------

/** Parse a permission authority (see data/permission.json): the shared authority format. */
export function parsePermissionAuthority(input: unknown): Authority {
  const result = AuthoritySchema.safeParse(input);
  if (!result.success) throw new Error(`invalid permission authority\n${z.prettifyError(result.error)}`);
  return result.data;
}

const ROOTED = /^(?:\/|~|[A-Za-z]:)/;
const DRIVE = /^[A-Za-z]:$/;

/** A path as segments, with . and .. resolved (never above the root), against a base for a relative one. Pure text: symlinks are not followed. */
function resolveSegments(path: string, base: readonly string[] | undefined): string[] {
  const text = path.replaceAll("\\", "/");
  const out = ROOTED.test(text) || base === undefined ? [] : [...base];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.length > (DRIVE.test(out[0]!) ? 1 : 0)) out.pop(); // with nothing in out, out[0] is undefined, which is no drive
  }
  return out;
}

/**
 * The facts the authority's rules test: the request's own, and `outsideCwd`, whether the
 * path is outside the working directory (present when there is a path and a working directory;
 * true when the directory is not rooted, because then it is not known what is inside it).
 */
export function permissionAuthorityFacts(facts: PermissionFacts): Json {
  const base: { [key: string]: Json } = { tool: facts.tool };
  for (const key of ["kind", "command", "path", "url", "cwd", "session"] as const) {
    const value = facts[key];
    if (value !== undefined) base[key] = value;
  }
  if (facts.input !== undefined) base["input"] = facts.input;
  if (facts.path !== undefined && facts.cwd !== undefined) {
    // Only a rooted directory says what is inside it. An empty, `.` or relative one is not known (it has no
    // segments, and then every path would be "inside" it), so every path is taken as outside: fail closed.
    const root = resolveSegments(facts.cwd, undefined);
    const at = resolveSegments(facts.path, root);
    base["outsideCwd"] = !ROOTED.test(facts.cwd.replaceAll("\\", "/")) || !root.every((segment, i) => at[i] === segment); // a path shorter than the directory lacks a segment of it
  }
  return base;
}

/** The authority's floor for a request: the risk level its effect on these facts means. */
export function permissionFloor(authority: Authority, facts: PermissionFacts): RiskLevel {
  return RISK_OF_EFFECT[evaluateAuthority(authority, permissionAuthorityFacts(facts)).effect];
}

// ---- what records and models are shown ------------------------------------------------------------------

/**
 * The facts as records and models keep them: every text field (the tool, the kind, the
 * command, the path, the url, the working directory, the session) with the secrets it carries
 * removed, and what the tool was given with the values of keys named like a secret removed at
 * any depth (see `scrubText` and `scrubJson`, which hold the rules and their limits). Text is
 * cut to `chars` characters first (4096 when not given), and the work on what the tool was
 * given is bounded as a whole, so a hostile request cannot make this slow.
 */
export function describePermission(facts: PermissionFacts, chars: number = SCAN_LIMIT): Json {
  const described: { [key: string]: Json } = { tool: scrubText(facts.tool, chars) };
  for (const key of ["kind", "command", "path", "url", "cwd", "session"] as const) {
    const value = facts[key];
    if (value !== undefined) described[key] = scrubText(value, chars);
  }
  if (facts.input !== undefined) described["input"] = scrubJson(facts.input, chars);
  return described;
}

// ---- settings: the questions and how their answers combine ---------------------------------------------------

const BooleanQuestion = z.strictObject({
  instructions: z.string().min(1),
  criteria: z.strictObject({ true: z.string().min(1).exactOptional(), false: z.string().min(1).exactOptional() }).exactOptional(),
});

const LEVELS = 4;

export const PermissionRiskSettingsSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    /** Recorded with every decision, together with the authority's version. */
    version: z.string().min(1),
    /** Text in what a model is shown and records keep is cut to this many characters. */
    chars: z.int().min(1),
    questions: z.strictObject({
      irreversible: BooleanQuestion,
      costs: BooleanQuestion,
      visible: BooleanQuestion,
      risk: z.strictObject({ instructions: z.string().min(1), levels: z.array(z.string().min(1)).length(LEVELS) }),
    }),
    combine: z.strictObject({
      /** A yes/no answer counts as yes at this probability of yes. */
      yesAt: ProbabilitySchema,
      /** The risk score's expected level from which a request is careful. */
      carefulAt: z.number().min(0).max(LEVELS - 1),
      /** ... and critical. */
      criticalAt: z.number().min(0).max(LEVELS - 1),
    }),
  })
  .refine((s) => s.combine.criticalAt >= s.combine.carefulAt, { message: "critical must not be reached before careful", path: ["combine", "criticalAt"] });
export type PermissionRiskSettings = z.output<typeof PermissionRiskSettingsSchema>;

/** Parse the question settings file (see data/permission-questions.json). */
export function parsePermissionRiskSettings(input: unknown): PermissionRiskSettings {
  const result = PermissionRiskSettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid permission risk settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the question settings file, for editors (data/permission-questions.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const permissionRiskSettingsJsonSchema = (): object => z.toJSONSchema(PermissionRiskSettingsSchema, { io: "input" });

/** JSON Schema for the permission authority file, for editors (data/permission.schema.json): the shared authority format. */
export const permissionAuthorityJsonSchema = (): object => authorityJsonSchema();

/**
 * What a fork built with no settings asks: the bare questions. Hosts load data/permission-questions.json for the
 * shipped ones. (Made when a fork is made, not when this module loads, so that a mistake in them shows in the
 * tests that make a fork.)
 */
const minimalSettings = (): PermissionRiskSettings =>
  parsePermissionRiskSettings({
    version: "minimal",
    chars: SCAN_LIMIT,
    questions: {
      irreversible: { instructions: "Would carrying out this request be hard to undo?" },
      costs: { instructions: "Would carrying out this request spend money or other limited resources?" },
      visible: { instructions: "Would carrying out this request be visible or have effects outside this machine?" },
      risk: { instructions: "How risky is it to let this request run without a person checking it first?", levels: ["none", "low", "high", "severe"] },
    },
    combine: { yesAt: 0.5, carefulAt: 1.5, criticalAt: 2.5 },
  });

/** With no authority: nothing is permitted and nothing forbidden, so every request is at least careful. */
const unguardedAuthority = (): Authority => parsePermissionAuthority({ version: "none", default: "escalate", rules: [] });

// ---- the fork ----------------------------------------------------------------------------------------------------

const RANK: Readonly<Record<RiskLevel, number>> = { routine: 0, careful: 1, critical: 2 };
const BOOLEANS = ["irreversible", "costs", "visible"] as const;

/**
 * The permission-risk fork. Three yes/no questions (is it irreversible, does it cost money
 * or resources, is it visible outside the machine) and one score (overall risk, four
 * levels). Two or more yes answers make a request critical and one makes it careful; a
 * risk score with an expected level from `carefulAt` makes it careful and from `criticalAt`
 * critical; the higher of the two is the verdict. The confidence is the mean of the
 * probability the yes answers and the score put on the verdict's class.
 *
 * The floor is the authority's (`permissionFloor`); a forbidden request is decided by the
 * rule rung with no model asked. The fork only annotates: no verdict approves anything.
 */
export function permissionRiskFork(authority: Authority = unguardedAuthority(), settings: PermissionRiskSettings = minimalSettings()): Fork<PermissionFacts, RiskLevel> {
  const { combine, questions } = settings;
  const describe = (facts: PermissionFacts): Json => describePermission(facts, settings.chars);
  const classOfLevel = (level: number): number => (level >= combine.criticalAt ? 2 : level >= combine.carefulAt ? 1 : 0);
  const floor = (facts: PermissionFacts): RiskLevel => permissionFloor(authority, facts);
  return {
    id: forkId("permission.risk"),
    version: `${settings.version}+${authority.version}`,
    ask: (facts) => ({
      state: describe(facts) as { readonly [key: string]: Json },
      questions: {
        ...Object.fromEntries(BOOLEANS.map((q) => [q, { type: "boolean" as const, instructions: questions[q].instructions, ...(questions[q].criteria === undefined ? {} : { criteria: questions[q].criteria }) }])),
        risk: { type: "score", instructions: questions.risk.instructions, criteria: questions.risk.levels },
      },
    }),
    interpret: (answers): Verdict<RiskLevel> | undefined => {
      const yesses: number[] = [];
      for (const q of BOOLEANS) {
        const a = answers[q];
        if (a?.type !== "boolean") return undefined;
        yesses.push(a.distribution["true"]!);
      }
      const risk = answers["risk"];
      if (risk?.type !== "score") return undefined;
      const keys = Object.keys(risk.distribution);
      if (keys.length !== LEVELS || !Array.from({ length: LEVELS }, (_, i) => String(i)).every((k) => keys.includes(k))) return undefined;

      // What the yes answers say: none, one, or two or more yes (independent), by class.
      const none = yesses.reduce((m, p) => m * (1 - p), 1);
      const one = yesses.reduce((sum, p, i) => sum + p * yesses.reduce((m, q, j) => (j === i ? m : m * (1 - q)), 1), 0);
      const fromYes = [none, one, Math.max(0, 1 - none - one)];
      const counted = yesses.filter((p) => p >= combine.yesAt).length;
      const yesClass = Math.min(2, counted);
      // What the score says: the mass on the levels of each class, and the class of the expected level.
      const fromScore = [0, 0, 0];
      let expected = 0;
      for (const k of keys) {
        fromScore[classOfLevel(Number(k))]! += risk.distribution[k]!;
        expected += Number(k) * risk.distribution[k]!;
      }
      const level = Math.max(yesClass, classOfLevel(expected));
      return { action: RISK_LEVELS[level]!, confidence: probability(Math.min(1, Math.max(0, (fromYes[level]! + fromScore[level]!) / 2))) };
    },
    describe,
    fallback: (facts) => (floor(facts) === "critical" ? "critical" : "careful"),
    rule: (facts) => (floor(facts) === "critical" ? "critical" : undefined),
    actions: () => RISK_LEVELS,
    floor,
    restrictiveness: (level) => RANK[level],
  };
}
