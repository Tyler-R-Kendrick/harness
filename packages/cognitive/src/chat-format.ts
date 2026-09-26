/**
 * Parser for ChatML-family model output: `<think>` reasoning, `<tool_call>` blocks in
 * the XML function form (`<function=name><parameter=k>v</parameter></function>`) or the
 * JSON form, and
 * end-of-turn markers. The streaming parser emits text as soon as it cannot be the
 * start of a tag; whole-string parsing is the same machine run once.
 */

export interface ToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ChatEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ToolCall };

export interface ParsedChat {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly ToolCall[];
}

const END_MARKERS = ["<|im_end|>", "<|endoftext|>"];
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";
const TEXT_MARKERS = [THINK_OPEN, TOOL_OPEN, ...END_MARKERS];

function decodeValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse the body of a `<tool_call>` block, or return undefined if it is not a call. */
function parseToolBody(body: string): ToolCall | undefined {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const parsed = decodeValue(trimmed);
    if (!isRecord(parsed) || typeof parsed["name"] !== "string") return undefined;
    const args = typeof parsed["arguments"] === "string" ? decodeValue(parsed["arguments"]) : (parsed["arguments"] ?? {});
    return isRecord(args) ? { name: parsed["name"], arguments: args } : undefined;
  }
  const fn = /^<function=([^>\s]+)>([\s\S]*)<\/function>$/.exec(trimmed);
  if (!fn) return undefined;
  const args: Record<string, unknown> = {};
  const rest = fn[2]!.replace(/<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g, (_m, key: string, value: string) => {
    args[key] = decodeValue(value);
    return "";
  });
  return rest.trim() === "" ? { name: fn[1]!, arguments: args } : undefined;
}

/** Index from which `buffer` could still turn into one of `markers`, or buffer.length. */
function holdFrom(buffer: string, markers: readonly string[]): number {
  for (let i = Math.max(0, buffer.length - 16); i < buffer.length; i++) {
    const tail = buffer.slice(i);
    if (markers.some((m) => m.length > tail.length && m.startsWith(tail))) return i;
  }
  return buffer.length;
}

export class ChatStreamParser {
  #mode: "text" | "think" | "tool" = "text";
  #buffer = "";

  push(delta: string): ChatEvent[] {
    this.#buffer += delta;
    const events: ChatEvent[] = [];
    for (;;) {
      if (this.#mode === "text") {
        const found = TEXT_MARKERS.map((m) => ({ m, at: this.#buffer.indexOf(m) }))
          .filter((x) => x.at >= 0)
          .sort((a, b) => a.at - b.at)[0];
        if (!found) {
          const hold = holdFrom(this.#buffer, TEXT_MARKERS);
          this.#text(events, this.#buffer.slice(0, hold));
          this.#buffer = this.#buffer.slice(hold);
          return events;
        }
        this.#text(events, this.#buffer.slice(0, found.at));
        this.#buffer = this.#buffer.slice(found.at + found.m.length);
        if (found.m === THINK_OPEN) this.#mode = "think";
        else if (found.m === TOOL_OPEN) this.#mode = "tool";
        continue;
      }
      const close = this.#mode === "think" ? THINK_CLOSE : TOOL_CLOSE;
      const at = this.#buffer.indexOf(close);
      if (at < 0) return events;
      const body = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + close.length);
      if (this.#mode === "think") this.#reasoning(events, body);
      else {
        const call = parseToolBody(body);
        events.push(call ? { type: "tool-call", call } : { type: "text", text: `${TOOL_OPEN}${body}${TOOL_CLOSE}` });
      }
      this.#mode = "text";
    }
  }

  /** Flush what is left: held-back text as text, an unfinished think block as reasoning, an unfinished tool call as text. */
  end(): ChatEvent[] {
    const events: ChatEvent[] = [];
    if (this.#mode === "think") this.#reasoning(events, this.#buffer);
    else this.#text(events, this.#mode === "tool" ? `${TOOL_OPEN}${this.#buffer}` : this.#buffer);
    this.#buffer = "";
    this.#mode = "text";
    return events;
  }

  #text(events: ChatEvent[], text: string): void {
    if (text !== "") events.push({ type: "text", text });
  }

  #reasoning(events: ChatEvent[], body: string): void {
    const text = body.trim();
    if (text !== "") events.push({ type: "reasoning", text });
  }
}

export function parseChatOutput(raw: string): ParsedChat {
  const parser = new ChatStreamParser();
  const events = [...parser.push(raw), ...parser.end()];
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("").trim(),
    reasoning: events.flatMap((e) => (e.type === "reasoning" ? [e.text] : [])).join("\n"),
    toolCalls: events.flatMap((e) => (e.type === "tool-call" ? [e.call] : [])),
  };
}
