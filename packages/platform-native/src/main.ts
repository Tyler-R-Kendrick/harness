#!/usr/bin/env node
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import { EchoWorker, EnsembleWorker, ModelWorker } from "@harness/workers";
import type { Worker } from "@harness/workers";
import { buildNativeEnsemble } from "./cognitive-host.ts";
import { NodeHost } from "./node-host.ts";

const { values } = parseArgs({
  options: {
    stdio: { type: "boolean", default: false },
    socket: { type: "string" },
    state: { type: "string" },
    worker: { type: "string", default: "echo" },
    model: { type: "string", default: "openai/gpt-oss-20b" },
    system: { type: "string" },
    cognitive: { type: "boolean", default: false },
    "llama-server": { type: "string" },
    "model-cache": { type: "string" },
    "no-hosted": { type: "boolean", default: false },
  },
});

if (!values.stdio && values.socket === undefined) {
  process.stderr.write(
    "usage: harness (--stdio | --socket <path>) [--state <file>] [--worker echo|model|ensemble] [--model <gateway id>]\n" +
      "               [--cognitive [--llama-server <path>] [--model-cache <dir>] [--no-hosted]]\n",
  );
  process.exit(2);
}

const cognitive =
  values.cognitive || values.worker === "ensemble"
    ? buildNativeEnsemble({
        cacheDir: values["model-cache"] ?? join(homedir(), ".cache", "harness", "models"),
        allowHosted: !values["no-hosted"],
        ...(values["llama-server"] === undefined ? {} : { llamaServer: values["llama-server"] }),
      })
    : undefined;
const system = values.system === undefined ? {} : { system: values.system };
const worker: Worker =
  values.worker === "model"
    ? new ModelWorker({ model: gateway(values.model), ...system })
    : values.worker === "ensemble"
      ? new EnsembleWorker({ ensemble: cognitive!.ensemble, ...system })
      : new EchoWorker();

const host = await NodeHost.start({
  worker,
  identity: { principal: userInfo().username, kind: "human" },
  ...(cognitive ? { cognitive: cognitive.ensemble } : {}),
  ...(values.state === undefined ? {} : { statePath: values.state }),
});

const shutdown = async () => {
  await host.close();
  await cognitive?.close();
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
