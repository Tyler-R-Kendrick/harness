import type { SnapshotStorage } from "./ports.ts";

/**
 * Live session text. Appending past `bound` archives the oldest overflow as
 * lossless compressed bytes and leaves a tail no longer than the bound.
 */

const WINDOW = 65_535;
const MAX_MATCH = 65_535;
const MIN_MATCH = 4;

/** Tag byte, then a code unit or a distance and length, each as two bytes. */
const LITERAL = 0;
const MATCH = 1;

export interface ArchiveHit {
  /** First archive the match touches. */
  readonly archive: number;
  /** Index of the query inside the passage returned by extract. */
  readonly index: number;
  /** Last archive the match touches, inclusive. */
  readonly through: number;
}

export interface LiveTextData {
  readonly version: 1;
  readonly bound: number;
  readonly live: string;
  readonly archives: readonly (readonly number[])[];
}

function codesToString(codes: readonly number[]): string {
  let out = "";
  const chunk = 8_192;
  for (let i = 0; i < codes.length; i += chunk) out += String.fromCharCode(...codes.slice(i, i + chunk));
  return out;
}

function byteAt(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined) throw new Error("bad archive");
  return byte;
}

/** Lossless bytes for `text`. A repeated span takes fewer bytes than its characters. */
export function compressText(text: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    let bestLen = 0;
    let bestDist = 0;
    const maxLen = Math.min(MAX_MATCH, text.length - i);
    for (let j = Math.max(0, i - WINDOW); j < i; j++) {
      let len = 0;
      while (len < maxLen && text.charCodeAt(j + len) === text.charCodeAt(i + len)) len += 1;
      if (len > bestLen) {
        bestLen = len;
        bestDist = i - j;
        if (len === maxLen) break;
      }
    }
    if (bestLen >= MIN_MATCH) {
      out.push(MATCH, bestDist >> 8, bestDist & 0xff, bestLen >> 8, bestLen & 0xff);
      i += bestLen;
    } else {
      const code = text.charCodeAt(i);
      out.push(LITERAL, code >> 8, code & 0xff);
      i += 1;
    }
  }
  return Uint8Array.from(out);
}

/** Inverse of {@link compressText}. */
export function expandText(bytes: Uint8Array): string {
  const chars: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = byteAt(bytes, i);
    i += 1;
    if (tag === LITERAL) {
      const code = (byteAt(bytes, i) << 8) | byteAt(bytes, i + 1);
      i += 2;
      chars.push(code);
    } else if (tag === MATCH) {
      const dist = (byteAt(bytes, i) << 8) | byteAt(bytes, i + 1);
      const len = (byteAt(bytes, i + 2) << 8) | byteAt(bytes, i + 3);
      i += 4;
      if (dist < 1 || dist > chars.length || len < 1) throw new Error("bad archive");
      for (let k = 0; k < len; k++) chars.push(chars[chars.length - dist] as number);
    } else {
      throw new Error("bad archive");
    }
  }
  return codesToString(chars);
}

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function isByteRow(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isByte);
}

function isLiveTextData(data: unknown): data is LiveTextData {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  const bound = record["bound"];
  return record["version"] === 1
    && typeof bound === "number"
    && Number.isInteger(bound)
    && bound >= 0
    && typeof record["live"] === "string"
    && Array.isArray(record["archives"])
    && record["archives"].every(isByteRow);
}

/** Where `index` falls in the concatenation of `originals`, and the start offset of that archive. */
function place(originals: readonly string[], index: number): { archive: number; offset: number } {
  let offset = 0;
  let archive = 0;
  while (archive + 1 < originals.length) {
    const span = originals[archive] as string;
    if (index < offset + span.length) return { archive, offset };
    offset += span.length;
    archive += 1;
  }
  return { archive, offset };
}

export class LiveText {
  #bound: number;
  #live = "";
  #archives: Uint8Array[] = [];

  constructor(bound: number) {
    if (!Number.isInteger(bound) || bound < 0) throw new Error("a live text bound is a non-negative integer");
    this.#bound = bound;
  }

  /** Append `text` and, once the live tail is past the bound, archive the oldest overflow. */
  append(text: string): void {
    this.#live += text;
    this.#compact();
  }

  live(): string {
    return this.#live;
  }

  archiveCount(): number {
    return this.#archives.length;
  }

  compressed(index: number): Uint8Array {
    return Uint8Array.from(this.#bytes(index));
  }

  expand(index: number): string {
    return expandText(this.#bytes(index));
  }

  /** Hits inside archived originals, including a query that crosses from one archive into the next. An empty query matches nothing. */
  search(query: string): readonly ArchiveHit[] {
    if (query.length === 0) return [];
    const originals: string[] = [];
    for (let archive = 0; archive < this.#archives.length; archive++) originals.push(expandText(this.#bytes(archive)));
    const joined = originals.join("");
    const hits: ArchiveHit[] = [];
    let from = 0;
    while (from <= joined.length) {
      const at = joined.indexOf(query, from);
      if (at < 0) break;
      const start = place(originals, at);
      const end = place(originals, at + query.length - 1);
      hits.push({ archive: start.archive, through: end.archive, index: at - start.offset });
      from = at + query.length;
    }
    return hits;
  }

  /** The archived originals that contain `hit`, joined when the query crosses a boundary. */
  extract(hit: ArchiveHit): string {
    let passage = "";
    for (let i = hit.archive; i <= hit.through; i++) passage += this.expand(i);
    return passage;
  }

  toJSON(): LiveTextData {
    return {
      version: 1,
      bound: this.#bound,
      live: this.#live,
      archives: this.#archives.map((bytes) => [...bytes]),
    };
  }

  static fromJSON(data: unknown, bound: number): LiveText {
    if (!isLiveTextData(data)) throw new Error("live text snapshot is not a compressed archive");
    const text = new LiveText(bound);
    text.#live = data.live;
    text.#archives = data.archives.map((row) => Uint8Array.from(row));
    text.#compact();
    return text;
  }

  #bytes(index: number): Uint8Array {
    const bytes = this.#archives[index];
    if (bytes === undefined) throw new Error("no archive");
    return bytes;
  }

  #compact(): void {
    while (this.#live.length > this.#bound) {
      const overflow = this.#live.length - this.#bound;
      this.#archives.push(compressText(this.#live.slice(0, overflow)));
      this.#live = this.#live.slice(overflow);
    }
  }
}

export async function saveLiveText(storage: SnapshotStorage, text: LiveText): Promise<void> {
  await storage.save(text.toJSON());
}

export async function openLiveText(storage: SnapshotStorage, bound: number): Promise<LiveText> {
  const data = await storage.load();
  if (data === undefined) return new LiveText(bound);
  return LiveText.fromJSON(data, bound);
}
