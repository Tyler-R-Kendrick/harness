import type { Importer } from "@harness/dialogue";
import type { Workflow } from "@harness/workflows";
import { importDialogue } from "./import.ts";

/** Imports documents for the dialogue (`dialogue.import`), putting each one's flow in the library its flow runner reads. */
export const documentImporter =
  (library: { get(name: string): Promise<Workflow | undefined>; put(workflow: Workflow): Promise<void> }): Importer =>
  async (request) => {
    const { document, flow, warnings } = importDialogue(request);
    // A workflow of the same name that is not a flow (a tool agents use) is replaced only when asked.
    const existing = await library.get(flow.name);
    if (existing && existing.kind !== "flow" && !request.replace) throw new Error(`workflow ${flow.name} is in the library and is not a flow: import with replace to replace it`);
    await library.put(flow);
    return { document, warnings };
  };
