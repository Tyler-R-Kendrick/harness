export interface LogEntry<P> {
  readonly offset: number;
  readonly at: number;
  readonly kind: string;
  readonly payload: P;
}

export type ReadResult<P> =
  | { readonly kind: "entries"; readonly entries: readonly LogEntry<P>[]; readonly next: number }
  | { readonly kind: "snapshot-required"; readonly snapshot: unknown; readonly snapshotOffset: number }
  | { readonly kind: "out-of-range"; readonly head: number };

export interface SessionLogData<P> {
  readonly base: number;
  readonly snapshot?: unknown;
  readonly entries: readonly LogEntry<P>[];
}

/**
 * Ordered, append-only session history. Clients resume from the offset after the
 * last one they acknowledged; once history below `base` is compacted they must
 * resync from the snapshot that represents it.
 */
export class SessionLog<P> {
  #base = 0;
  #snapshot: unknown = undefined;
  #entries: LogEntry<P>[] = [];
  #lastAt = Number.NEGATIVE_INFINITY;

  head(): number {
    return this.#base + this.#entries.length;
  }

  base(): number {
    return this.#base;
  }

  append(kind: string, payload: P, at: number): LogEntry<P> {
    const entry: LogEntry<P> = { offset: this.head(), at: Math.max(at, this.#lastAt), kind, payload };
    this.#lastAt = entry.at;
    this.#entries.push(entry);
    return entry;
  }

  read(from: number, limit = Number.POSITIVE_INFINITY): ReadResult<P> {
    const head = this.head();
    if (!Number.isInteger(from) || from < 0 || from > head) return { kind: "out-of-range", head };
    if (from < this.#base) return { kind: "snapshot-required", snapshot: this.#snapshot, snapshotOffset: this.#base };
    const start = from - this.#base;
    const count = Math.max(0, Math.min(limit, this.#entries.length - start));
    return { kind: "entries", entries: this.#entries.slice(start, start + count), next: from + count };
  }

  /** Drop entries below `upTo`; `snapshot` must represent the state at `upTo`. */
  compact(upTo: number, snapshot: unknown): void {
    if (upTo > this.head()) throw new Error(`cannot compact beyond head (${upTo} > ${this.head()})`);
    if (upTo < this.#base) throw new Error(`cannot compact behind base (${upTo} < ${this.#base})`);
    this.#entries = this.#entries.slice(upTo - this.#base);
    this.#base = upTo;
    this.#snapshot = snapshot;
  }

  toJSON(): SessionLogData<P> {
    return { base: this.#base, snapshot: this.#snapshot, entries: [...this.#entries] };
  }

  static fromJSON<P>(data: unknown): SessionLog<P> {
    if (!isLogData<P>(data)) throw new Error("invalid session log data");
    data.entries.forEach((entry, i) => {
      if (entry.offset !== data.base + i) throw new Error("session log entries are not contiguous");
    });
    const log = new SessionLog<P>();
    log.#base = data.base;
    log.#snapshot = data.snapshot;
    log.#entries = [...data.entries];
    log.#lastAt = data.entries.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
    return log;
  }
}

function isLogData<P>(data: unknown): data is SessionLogData<P> {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return Number.isInteger(d["base"]) && (d["base"] as number) >= 0 && Array.isArray(d["entries"]);
}
