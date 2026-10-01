import { z } from "zod";
import type { JSONValue } from "ai";
import type { ArtifactText, Caller, CognitiveExtension } from "@harness/cognitive";
import type { Dialogue } from "./dialogue.ts";
import { FlowNameSchema, parse, parseScript, SCRIPT_STATUSES } from "./schemas.ts";
import type { DocumentInput } from "./schemas.ts";

/** What importing a document takes: its name, its files, and the options it is imported with. */
export interface ImportRequest {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, JSONValue>>;
  /** Replace a workflow of the same name that is not a flow (otherwise refused). */
  readonly replace: boolean;
}

/** Turns files in a dialogue standard into a document, putting the flow that runs it where the dialogue's flow runner finds it (see @harness/dialogue-standards). */
export type Importer = (request: ImportRequest) => Promise<{ readonly document: DocumentInput; readonly warnings: readonly string[] }>;

const Id = z.strictObject({ id: z.string().min(1) });
const ListInput = z.strictObject({ status: z.enum(SCRIPT_STATUSES).exactOptional() });
const PutInput = z.strictObject({ script: z.unknown() });
const FeedbackInput = z
  .strictObject({
    id: z.string().min(1),
    kind: z.enum(["helpful", "harmful"]),
    session: z.string().min(1).exactOptional(),
    utterance: z.string().min(1).exactOptional(),
    answer: z.string().min(1).exactOptional(),
    text: z.string().exactOptional(),
    action: z.enum(["rating", "replacement", "steering"]).exactOptional(),
    artifact: z.enum(["template", "workflow", "script"]).exactOptional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === undefined) return;
    if (value.kind !== "harmful") ctx.addIssue({ code: "custom", message: "a correction is negative feedback" });
    if (value.utterance === undefined) ctx.addIssue({ code: "custom", message: "a correction names the utterance" });
    if (value.answer === undefined) ctx.addIssue({ code: "custom", message: "a correction names the answer" });
  });
const ImportInput = z.strictObject({
  name: FlowNameSchema,
  files: z.record(z.string().min(1), z.string()),
  options: z.record(z.string(), z.json()).default({}),
  /** Make it the flow every session starts in. */
  entry: z.boolean().default(false),
  /** Patterns of a script that starts it. */
  patterns: z.array(z.string().min(1)).default([]),
  /** Replace a script or workflow of the same name (otherwise refused). */
  replace: z.boolean().default(false),
});

/**
 * What changes the book for every session (authoring a script, importing a document) is
 * for people and their clients; a plugin or an agent may only report how scripts did.
 * An in-process caller (no caller) is the host itself.
 */
function authoring(op: string, caller: Caller | undefined): void {
  if (caller && caller.kind !== "human" && caller.kind !== "client") throw new Error(`dialogue.${op} is for people and their clients, not a ${caller.kind} (${caller.principal})`);
}

/**
 * A dialogue as a cognitive extension, so clients and plugins manage it over ACP
 * (`_harness/cognitive/invoke` with `dialogue.<op>`): `status`, `list`, `get`, `put`
 * (author a script), `feedback` (on a script's answers) and `import` (a document in a
 * dialogue standard, through the host's importer).
 */
export function dialogueExtension(options: {
  readonly dialogue: Dialogue;
  readonly importer?: Importer;
  /** Templates and workflows a correction can rewrite. A script is the dialogue's own. */
  readonly artifacts?: { readonly template?: ArtifactText; readonly workflow?: ArtifactText };
}): CognitiveExtension {
  const { dialogue, importer } = options;
  return {
    id: "dialogue",
    models: [],
    operations: {
      status: async () => dialogue.status(),
      list: async (input) => {
        const { status } = parse(ListInput, "dialogue.list input", input ?? {});
        const scripts = dialogue.scripts.filter((s) => status === undefined || s.status === status);
        return { scripts: scripts.map(({ id, intent, status: st, origin, scope, evidence }) => ({ id, intent, status: st, origin, ...(scope === undefined ? {} : { scope }), evidence })) };
      },
      get: async (input) => {
        const { id } = parse(Id, "dialogue.get input", input ?? {});
        const script = dialogue.script(id);
        if (!script) throw new Error(`no script ${id}`);
        return script;
      },
      put: async (input, caller) => {
        authoring("put", caller);
        const { script } = parse(PutInput, "dialogue.put input", input ?? {});
        dialogue.put(script as never);
        return { id: (script as { id: string }).id };
      },
      feedback: async (input) => {
        const parsed = parse(FeedbackInput, "dialogue.feedback input", input ?? {});
        if (parsed.action !== undefined) {
          const { utterance, answer, action } = parsed;
          if (utterance === undefined || answer === undefined) throw new Error("a correction names the utterance and the answer");
          const kind = parsed.artifact ?? "script";
          const port = kind === "template" ? options.artifacts?.template : kind === "workflow" ? options.artifacts?.workflow : undefined;
          const correction = {
            utterance,
            answer,
            text: parsed.text ?? "",
            action,
            artifact: { kind, id: parsed.id },
          };
          const preference = port === undefined ? await dialogue.correct(correction) : await dialogue.correct(correction, port);
          const script = dialogue.script(parsed.id);
          return script ? { evidence: script.evidence, preference } : { preference };
        }
        const { id, kind, session } = parsed;
        // Feedback counts a session's evidence only from a session the dialogue saw: made-up sessions cannot promote a script.
        if (session !== undefined && !dialogue.hasSession(session)) throw new Error(`no session ${session} in the dialogue`);
        dialogue.feedback(id, kind, session);
        return { evidence: dialogue.script(id)!.evidence };
      },
      import: async (input, caller) => {
        authoring("import", caller);
        const request = parse(ImportInput, "dialogue.import input", input ?? {});
        if (!importer) throw new Error("importing needs the host's importer");
        // Everything that can be refused is, before anything is written.
        const trigger = request.patterns.length === 0 ? undefined : parseScript({ id: request.name, intent: `Start ${request.name}`, patterns: request.patterns, reply: [{ flow: request.name }] });
        if (trigger && dialogue.script(trigger.id) && !request.replace) throw new Error(`script ${trigger.id} is in the book: import with replace to replace it`);
        const { document, warnings } = await importer({ name: request.name, files: request.files, options: request.options, replace: request.replace });
        dialogue.putDocument(document);
        if (trigger) dialogue.put(trigger);
        if (request.entry) dialogue.setEntry(request.name);
        return { name: request.name, type: document.type, warnings };
      },
    },
  };
}
