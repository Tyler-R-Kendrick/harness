import type { ArtifactText, Ensemble } from "@harness/cognitive";
import type { SnapshotStorage } from "@harness/core";
import { Dialogue, dialogueExtension, dialogueSaves } from "@harness/dialogue";
import type { DialogueEvent, Settings } from "@harness/dialogue";
import { documentImporter, STANDARD_INTERPRETERS } from "@harness/dialogue-standards";
import { workflowText } from "@harness/workflows";
import type { WorkflowHost } from "@harness/workflows";

/** Answer-template bodies this page keeps, so a correction can replace one. */
function memoryTemplates(): ArtifactText {
  const bodies = new Map<string, string>();
  return {
    read: (id) => bodies.get(id),
    write: (id, content) => {
      bodies.set(id, content);
    },
  };
}

/**
 * The scripted dialogue in the browser host (ADR 0012), as the native host has it: its
 * book kept in `storage` (IndexedDB) and saved after every change, one save at a time;
 * its flows run by `flows` (see browserWorkflows: QuickJS, journals in IndexedDB); the
 * ensemble's router, judge and reasoning model (and embedder, with `embeddings`); documents
 * in VoiceXML and AIML; and managed over ACP as the `dialogue` extension, whose `import`
 * puts a document's flow in the flows' library. Put it in front of a session model with
 * `dialogueMiddleware`, or in front of a worker with `DialogueWorker` (@harness/workers).
 */
export async function browserDialogue(
  ensemble: Ensemble,
  options: {
    readonly settings: Settings;
    readonly storage: SnapshotStorage;
    readonly flows?: WorkflowHost;
    /** Answer templates a correction can replace. The page keeps its own when this is omitted. */
    readonly templates?: ArtifactText;
    readonly embeddings?: boolean;
    readonly onError?: (error: unknown) => void;
    readonly onEvent?: (event: DialogueEvent) => void;
  },
): Promise<{ readonly dialogue: Dialogue; readonly saved: () => Promise<void>; readonly templates: ArtifactText }> {
  const { flows, onError, onEvent } = options;
  const book = await options.storage.load();
  const saves = dialogueSaves(options.storage, onError ?? (() => {}));
  const dialogue = new Dialogue({
    settings: options.settings,
    ...(book === undefined ? {} : { book }),
    router: ensemble.languageModel("tool-calling", "router"),
    judge: ensemble.evaluationModel(),
    drafter: ensemble.languageModel("reasoning"),
    ...(options.embeddings ? { embedder: ensemble.embeddingModel() } : {}),
    ...(flows ? { flows } : {}),
    interpreters: STANDARD_INTERPRETERS,
    now: () => Date.now(),
    onChange: (d) => saves.persist(() => d.save()),
    ...(onError ? { onError } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
  const templates = options.templates ?? memoryTemplates();
  ensemble.install(
    dialogueExtension({
      dialogue,
      ...(flows ? { importer: documentImporter(flows.library) } : {}),
      artifacts: { template: templates, ...(flows ? { workflow: workflowText(flows.library) } : {}) },
    }),
  );
  return { dialogue, saved: saves.settled, templates };
}
