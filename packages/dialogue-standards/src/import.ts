import type { JSONValue } from "@ai-sdk/provider";
import { DocumentSchema, FlowNameSchema } from "@harness/dialogue";
import type { DocumentInput, Interpreter } from "@harness/dialogue";
import { parseWorkflow } from "@harness/workflows";
import type { Workflow } from "@harness/workflows";
import { aimlInterpreter, isAimlFile } from "./aiml.ts";
import { isVoiceXmlFile, voiceXml } from "./voicexml.ts";
import { DocumentError } from "./xml.ts";

/** The standards the harness reads dialogues in. */
export const STANDARD_INTERPRETERS: readonly Interpreter[] = [voiceXml, aimlInterpreter];

/** Whether a file is one a dialogue standard reads (a folder's other files, a README or audio, are not). */
export const isDialogueFile = (file: string): boolean => isVoiceXmlFile(file) || isAimlFile(file);

/** The standard a set of files is in: VoiceXML when there is a .vxml file, AIML when there is an .aiml file. */
export function standardOf(files: Readonly<Record<string, string>>): "voicexml" | "aiml" {
  const names = Object.keys(files);
  const vxml = names.some((f) => /\.vxml$/i.test(f));
  const aiml = names.some((f) => /\.aiml$/i.test(f));
  if (vxml === aiml) throw new DocumentError(vxml ? "the files mix VoiceXML and AIML: import them as two dialogues" : "no VoiceXML (.vxml) or AIML (.aiml) file among the files");
  return vxml ? "voicexml" : "aiml";
}

/**
 * The flow that runs a document: each turn it asks the interpreter for the document's
 * next step with the utterance, says what the step says, calls the tools the step names
 * (a host tool or a workflow, for VoiceXML's `<data>` and `<submit>`), and hands the turn
 * on or the person over when the step does. The step's state goes on to the next turn's
 * run (the flow returns `{ continue: state }`), so every run's journal is one turn long.
 */
export function documentFlow(name: string, description: string): Workflow {
  const document = JSON.stringify(name);
  return parseWorkflow({
    name,
    kind: "flow",
    description,
    inputs: { type: "object" },
    code: `const document = ${document};
let step = await tools.interpret({ document, state: input.state ?? null, utterance: input.utterance ?? "", slots: input.slots ?? {} });
while (step.call !== undefined) {
  for (const text of step.say) await tools.say({ text });
  const result = await tools[step.call.tool](step.call.input);
  step = await tools.interpret({ document, state: step.state, result: result ?? null });
}
for (const text of step.say) await tools.say({ text });
if (step.pass === true) await tools.pass({});
if (step.end === "transfer") await tools.transfer({});
return step.end === undefined ? { continue: step.state } : { output: step.output ?? null };`,
  });
}

export interface Imported {
  /** The document, for the book's `documents`. */
  readonly document: DocumentInput;
  /** The flow that runs it, for the workflow library. */
  readonly flow: Workflow;
  /** What the standard has that the harness left out. */
  readonly warnings: readonly string[];
}

/**
 * A VoiceXML application (documents and SRGS grammar files) or an AIML bot (AIML files,
 * sets, maps, properties, substitutions) as a dialogue document and the flow that runs
 * it. The files are compiled here, so a document with errors is refused, naming them.
 */
export function importDialogue(input: { readonly name: string; readonly files: Readonly<Record<string, string>>; readonly options?: Readonly<Record<string, JSONValue>> }): Imported {
  const name = FlowNameSchema.parse(input.name);
  const type = standardOf(input.files);
  const interpreter = STANDARD_INTERPRETERS.find((i) => i.type === type)!;
  const options = input.options ?? {};
  const { warnings } = interpreter.compile(input.files, options);
  const document = DocumentSchema.parse({ name, type, files: input.files, options });
  const what = type === "voicexml" ? "VoiceXML application" : "AIML bot";
  return { document, flow: documentFlow(name, `Runs the imported ${what} ${name} a turn at a time.`), warnings };
}
