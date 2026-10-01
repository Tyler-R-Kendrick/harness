import { fillTemplate, readTemplate } from "@harness/cognitive";
import type { TemplateConstraint } from "@harness/cognitive";

/**
 * Harness wording for an answer that came from somewhere else. The fixed text is the
 * harness; the holes are its personality, skills, and memory, who produced the raw
 * answer, and the citation of that answer. The raw answer is not a hole.
 */
export const voiceTemplate: TemplateConstraint = {
  type: "template",
  parts: [
    "personality ",
    { hole: "personality" },
    " skills ",
    { hole: "skills" },
    " memory ",
    { hole: "memory" },
    " source ",
    { hole: "source" },
    " ",
    { hole: "citation" },
    "\n",
  ],
};

/** What the harness sounds like. This stays on the harness; a foreign producer is not given it. */
export interface HarnessVoice {
  readonly personality: string;
  readonly skills: readonly string[];
  /** Configured lines. A turn's recall does not write this list; the wording receives its own copy. */
  readonly memory: string[];
}

/** Session memory a turn can recall into the harness wording. The lines are not sent to the producer. */
export interface MemoryRecall {
  recall(query: string, options: { readonly excludeSession?: string; readonly limit?: number; readonly kinds?: readonly string[] }): Promise<readonly { readonly text: string }[]>;
}

/** A producer that is not the harness speaking as itself. */
export type ForeignProducer = { readonly kind: "harness"; readonly id: string } | { readonly kind: "model"; readonly id: string };

/** Voice bound to one foreign worker. The book is the caller's, so a citation can be read back. */
export interface ForeignVoice {
  readonly voice: HarnessVoice;
  readonly book: CitationBook;
  readonly producer: ForeignProducer;
  /** When set, the turn's recalled lines replace `voice.memory` before the answer is worded. */
  readonly memoryStore?: MemoryRecall;
}

/** Voice bound to a session model. `ownModelId` is the model the harness itself speaks as. */
export interface SessionVoice {
  readonly voice: HarnessVoice;
  readonly book: CitationBook;
  readonly ownModelId: string;
  /** When set, the turn's recalled lines replace `voice.memory` before a foreign answer is worded. */
  readonly memoryStore?: MemoryRecall;
}

/** The raw body of a foreign answer, stored under a citation id that is not that body. */
export interface CitationBook {
  /** Store `raw` for `producer` and return its citation id. The same pair returns the same id. */
  put(producer: string, raw: string): string;
  /** The entire raw body stored for `id`. */
  read(id: string): string | undefined;
}

/** A 32-bit FNV-1a hash, so a citation id names a body without being that body. */
function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** A book of raw foreign answers. Ids are hashes; a collision keeps both bodies. */
export function citationBook(): CitationBook {
  const byKey = new Map<string, string>();
  const byId = new Map<string, string>();
  return {
    put(producer, raw) {
      const key = `${producer}\0${raw}`;
      const found = byKey.get(key);
      if (found !== undefined) return found;
      const base = fnv(key).toString(16);
      let id = base;
      let n = 0;
      while (byId.has(id)) id = `${base}${(++n).toString(16)}`;
      byKey.set(key, id);
      byId.set(id, raw);
      return id;
    },
    read(id) {
      return byId.get(id);
    },
  };
}

/**
 * Lines for this turn only. No store or a blank query uses `voice.memory`. A failed recall
 * does too, so one turn cannot leave its lines for the next. The shared list is not written.
 */
export async function recalledLines(voice: HarnessVoice, store: MemoryRecall | undefined, query: string, sessionId?: string): Promise<readonly string[]> {
  if (store === undefined || query.trim() === "") return [...voice.memory];
  const found = await store
    .recall(query, { limit: 3, kinds: ["user", "assistant"], ...(sessionId === undefined || sessionId === "" ? {} : { excludeSession: sessionId }) })
    .catch(() => undefined);
  if (found === undefined) return [...voice.memory];
  return found.map((item) => item.text).filter((text) => text !== "");
}

/** The raw body named by a prompt that is only `cite:<id>`. */
export function citedBody(asked: string, book: CitationBook): string | undefined {
  const text = asked.trim();
  if (!text.startsWith("cite:")) return undefined;
  const id = text.slice("cite:".length);
  if (id === "" || /\s/.test(id)) return undefined;
  return book.read(id);
}

/** The fixed text that ends `hole`, so a value can be kept from containing it. */
function terminatorOf(hole: string): string {
  const index = voiceTemplate.parts.findIndex((part) => typeof part !== "string" && part.hole === hole);
  const next = index < 0 ? undefined : voiceTemplate.parts[index + 1];
  if (typeof next !== "string") throw new Error(`hole ${hole} has no terminator`);
  return next;
}

/** A mark that keeps a hole from containing its terminator without changing the words a person reads. */
const WORD_MARK = "\u200b";

/** `terminator` with the mark inserted, so the letters stay and an exact split does not see it. */
function brokenTerminator(terminator: string): string {
  if (terminator.length <= 1) return WORD_MARK;
  return `${terminator[0] ?? ""}${WORD_MARK}${terminator.slice(1)}`;
}

/** Hide `terminator` inside a hole. A doubled mark stands for one mark in the value. */
function escapeHole(value: string, terminator: string): string {
  return value.replaceAll(WORD_MARK, WORD_MARK + WORD_MARK).replaceAll(terminator, brokenTerminator(terminator));
}

/** Inverse of escapeHole. A longer doubled mark is restored before a one-character terminator. */
function unescapeHole(value: string, terminator: string): string {
  const broken = brokenTerminator(terminator);
  let out = "";
  for (let i = 0; i < value.length; ) {
    const doubled = value.startsWith(WORD_MARK + WORD_MARK, i);
    const hit = value.startsWith(broken, i);
    if (doubled && (!hit || WORD_MARK.length * 2 > broken.length)) {
      out += WORD_MARK;
      i += WORD_MARK.length * 2;
    } else if (hit) {
      out += terminator;
      i += broken.length;
    } else {
      out += value[i] ?? "";
      i += 1;
    }
  }
  return out;
}

function encodeHoles(values: Readonly<Record<string, string>>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [hole, value] of Object.entries(values)) encoded[hole] = escapeHole(value, terminatorOf(hole));
  return encoded;
}

function decodeHoles(values: Readonly<Record<string, string>>): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [hole, value] of Object.entries(values)) decoded[hole] = unescapeHole(value, terminatorOf(hole));
  return decoded;
}

/** The next terminated wording, or nothing when `text` does not start a voice template. */
function nextWording(text: string): { readonly holes: Record<string, string>; readonly rest: string } {
  const terminator = voiceTemplate.parts.at(-1);
  if (typeof terminator !== "string") throw new Error("a voice wording has no terminator");
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf(terminator, at);
    if (end < 0) break;
    const piece = text.slice(0, end + terminator.length);
    try {
      return { holes: decodeHoles(readTemplate(voiceTemplate, piece)), rest: text.slice(piece.length) };
    } catch {
      // A newline inside an earlier hole is not this wording's end.
      at = end + terminator.length;
    }
  }
  throw new Error("the output is not harness wording");
}

/** The harness wordings in a joined reply, one per terminated template. */
export function visibleWordings(text: string): Record<string, string>[] {
  const wordings: Record<string, string>[] = [];
  let rest = text;
  while (rest !== "") {
    const next = nextWording(rest);
    wordings.push(next.holes);
    rest = next.rest;
  }
  return wordings;
}

/** The harness wording of `raw`, and the citation whose read returns `raw` unchanged. `lines` are this turn's memory. */
export function voiceAnswer(raw: string, producer: ForeignProducer, voice: HarnessVoice, book: CitationBook, lines?: readonly string[]): { readonly text: string; readonly citation: string } {
  const source = `${producer.kind}:${producer.id}`;
  const citation = `cite:${book.put(source, raw)}`;
  const text = fillTemplate(voiceTemplate, encodeHoles({
    personality: voice.personality,
    skills: voice.skills.join(", "),
    memory: (lines ?? voice.memory).join(", "),
    source,
    citation,
  }));
  return { text, citation };
}
