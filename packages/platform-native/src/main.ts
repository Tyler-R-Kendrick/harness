#!/usr/bin/env node
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import { EchoWorker, ModelWorker } from "@harness/workers";
import type { Worker } from "@harness/workers";
import { NodeHost } from "./node-host.ts";

const { values } = parseArgs({
  options: {
    stdio: { type: "boolean", default: false },
    socket: { type: "string" },
    state: { type: "string" },
    worker: { type: "string", default: "echo" },
    model: { type: "string", default: "openai/gpt-oss-20b" },
    system: { type: "string" },
  },
});

if (!values.stdio && values.socket === undefined) {
  process.stderr.write("usage: harness (--stdio | --socket <path>) [--state <file>] [--worker echo|model] [--model <gateway id>]\n");
  process.exit(2);
}

const worker: Worker =
  values.worker === "model"
    ? new ModelWorker({ model: gateway(values.model), ...(values.system === undefined ? {} : { system: values.system }) })
    : new EchoWorker();

const host = await NodeHost.start({
  worker,
  identity: { principal: userInfo().username, kind: "human" },
  ...(values.state === undefined ? {} : { statePath: values.state }),
});

const shutdown = async () => {
  await host.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (values.stdio) {
  // Editors launch ACP agents as child processes; stdout carries protocol frames only.
  host.attach(process.stdin, process.stdout, () => {});
  process.stdin.on("end", () => void shutdown());
}
if (values.socket !== undefined) {
  await host.listen(values.socket);
  process.stderr.write(`harness listening on ${values.socket}\n`);
}
