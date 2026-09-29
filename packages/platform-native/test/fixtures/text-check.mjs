// A liveness check as a real command: the text on stdin; exit 0 when it is an agent's instructions with no BROKEN marker, else the problem on stderr.
import { readFileSync } from "node:fs";

const text = readFileSync(0, "utf8");
if (text.includes("BROKEN")) {
  console.error("the instructions contain a BROKEN marker");
  process.exit(1);
}
if (!text.startsWith("You are")) {
  console.error("the instructions must start with 'You are'");
  process.exit(1);
}
