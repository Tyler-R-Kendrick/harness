import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseTestingRoster } from "@harness/core";
import type { TestingRoster } from "@harness/core";
import { z } from "zod";

const require = createRequire(import.meta.url);

const AgentSchema = z.object({
  name: z.enum(["fuzz", "mutation", "crap", "contract", "atomic", "evals", "bdd", "ux"]),
  title: z.string().min(1),
  instructions: z.string().min(1),
  applies: z.enum(["always", "boundary", "ui"]),
}).strict();

/** The roster file. The core parser is the authority; this schema is what editors check. */
export const TestingRosterSchema = z.object({
  $schema: z.string().optional(),
  fuzzMinTrials: z.int().positive(),
  mutationBreak: z.int().min(0).max(100),
  maxCrap: z.int().positive(),
  agents: z.array(AgentSchema).length(8),
}).strict();

export function testingRosterJsonSchema(): object {
  return z.toJSONSchema(TestingRosterSchema, { io: "input" });
}

/** Read the built-in testing sub-agents, or a roster file a runtime supplies. */
export function loadTestingRoster(file: string = require.resolve("@harness/core/data/testing-subagents.json")): TestingRoster {
  return parseTestingRoster(JSON.parse(readFileSync(file, "utf8")));
}
