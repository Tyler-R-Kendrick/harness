import { simulate, simulateText } from "./evolution-world.ts";
import type { EvaluatorInput } from "./evolution-world.ts";
import type { EvolutionDeps } from "../src/evolution-command.ts";

/** The evaluate port on the simulated suite, in this process. */
export const evaluateSim: NonNullable<EvolutionDeps["evaluate"]> = async (documents, tasks, k) => simulate({ documents, tasks, k } as EvaluatorInput) as never;

/** The evaluate port on the simulated text suite, in this process. */
export const evaluateSimText: NonNullable<EvolutionDeps["evaluate"]> = async (documents, tasks, k) => simulateText({ documents, tasks, k } as EvaluatorInput) as never;
