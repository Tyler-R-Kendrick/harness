import { base64 } from "@scure/base";
import { z } from "zod";
import type { Ensemble } from "@harness/cognitive";
import type { Recording, Teacher, TrajectoryInput } from "@harness/learning";
import type { PluginSettings } from "./settings.ts";
import { kebab } from "./workflow-builder.ts";

type Step = TrajectoryInput["steps"][number];

/** One input event from a recording: a command run, a tool called, or a UI action on a target. */
const Event = z.looseObject({
  action: z.string().min(1),
  target: z.string().optional(),
  value: z.string().optional(),
  tool: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
});

/** A transcript line: "speaker: words". The assistant's lines are the agent's; everyone else's are the person's. */
function transcriptSteps(text: string): Step[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([^:]{1,40}):\s*(.*)$/.exec(line);
      const speaker = m?.[1]!.trim().toLowerCase();
      return { role: speaker === "assistant" || speaker === "agent" ? "assistant" : "user", content: m ? m[2]! : line };
    });
}

/** Events as JSON lines (or one JSON array): a tool call becomes a call step; anything else an observation. */
function eventSteps(text: string): Step[] {
  const trimmed = text.trim();
  const raw: unknown[] = trimmed.startsWith("[") ? (JSON.parse(trimmed) as unknown[]) : trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as unknown);
  return raw.flatMap((item): Step[] => {
    const e = Event.parse(item);
    if (e.tool) {
      const call: Step = { role: "assistant", content: `${e.action}: ${e.tool}`, call: { name: e.tool, arguments: e.args ?? {} } };
      return e.output === undefined ? [call] : [call, { role: "tool", content: e.output }];
    }
    const what = [e.action, e.target, e.value === undefined ? undefined : JSON.stringify(e.value)].filter(Boolean).join(" ");
    return [{ role: "observation", content: e.output === undefined ? what : `${what} → ${e.output}` }];
  });
}


/**
 * A teacher for what a client can record: a transcript (what was said), input events
 * (commands, tool calls, clicks and keystrokes), and screen frames. Transcripts and
 * events translate deterministically; each screen frame is described by a vision model.
 * The parts, in order, become the steps of a demonstration of the recorded task. Text
 * parts (transcripts, events) carry their text; frames carry base64 image bytes.
 */
export function recordingTeacher(options: { readonly reasoner: Pick<Ensemble, "generate">; readonly settings: PluginSettings }): Teacher {
  const { screen, maxTokens } = options.settings.teacher;
  const describe = async (part: Recording["parts"][number]) => {
    let text = "";
    const image = { mediaType: part.mediaType, data: base64.decode(part.data) };
    for await (const e of options.reasoner.generate({ messages: [{ role: "user", content: [{ type: "image", image }, { type: "text", text: screen }] }], maxTokens }, "vision-qa")) {
      if (e.type === "text") text += e.text;
    }
    return text.trim();
  };
  return {
    kind: "teacher",
    id: "recording-teacher",
    modalities: ["transcript", "events", "screen"],
    demonstrate: async (recording) => {
      const steps: Step[] = [];
      let frame = 0;
      for (const part of recording.parts) {
        if (part.modality === "transcript") steps.push(...transcriptSteps(part.data));
        else if (part.modality === "events") steps.push(...eventSteps(part.data));
        else steps.push({ role: "observation", content: `screen ${++frame}: ${await describe(part)}` });
      }
      return {
        id: `demonstration-${kebab(recording.task)}-${recording.parts.length}`,
        task: recording.task,
        steps: [...(recording.note ? [{ role: "user" as const, content: recording.note }] : []), ...steps],
        outcome: { status: "success", feedback: "demonstrated by a person" },
      };
    },
  };
}
