// The simulated suite as an evaluator command: `{documents, tasks, k}` on stdin, task runs on stdout.
import { readFileSync } from "node:fs";
import { simulate } from "../evolution-world.ts";
import type { EvaluatorInput } from "../evolution-world.ts";

process.stdout.write(JSON.stringify(simulate(JSON.parse(readFileSync(0, "utf8")) as EvaluatorInput)));
