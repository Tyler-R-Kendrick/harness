// The simulated suite as an evaluator that takes its time: `slow-evaluator.ts <delay ms> [<pid file>]`. It records its pid (when asked) first, so a test knows it is running.
import { writeFileSync } from "node:fs";

const [delay, pidfile] = process.argv.slice(2);
if (pidfile !== undefined) writeFileSync(pidfile, String(process.pid));
await new Promise((r) => setTimeout(r, Number(delay)));
await import("./sim-evaluator.ts");
