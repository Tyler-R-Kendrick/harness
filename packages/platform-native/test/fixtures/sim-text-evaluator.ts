// The simulated text suite as an evaluator command: `{documents, tasks, k}` on stdin, task runs on stdout.
import { readFileSync } from "node:fs";
import { simulateText } from "../evolution-world.ts";
import type { EvaluatorInput } from "../evolution-world.ts";

process.stdout.write(JSON.stringify(simulateText(JSON.parse(readFileSync(0, "utf8")) as EvaluatorInput)));
