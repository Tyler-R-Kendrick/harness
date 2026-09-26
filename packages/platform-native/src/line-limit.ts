const NEWLINE = 0x0a;

/**
 * Bounds line length on an NDJSON byte stream. The ACP SDK's reader buffers each line
 * whole, so a peer that never sends a newline could make the daemon buffer without
 * bound; this passes only complete lines of at most `maxBytes`, drops a longer one up
 * to its newline (calling `onOverflow` once for it), and never holds more than
 * `maxBytes` itself.
 */
export function lineLimit(maxBytes: number, onOverflow: () => void): TransformStream<Uint8Array, Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  let parts: Uint8Array[] = [];
  let length = 0;
  let discarding = false;
  const take = (piece: Uint8Array) => {
    if (discarding) return;
    if (length + piece.length > maxBytes) {
      parts = [];
      length = 0;
      discarding = true;
      onOverflow();
      return;
    }
    parts.push(piece);
    length += piece.length;
  };
  const line = () => {
    const out = new Uint8Array(length + 1);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    out[at] = NEWLINE;
    parts = [];
    length = 0;
    return out;
  };
  return new TransformStream({
    transform(chunk, controller) {
      let start = 0;
      for (let nl = chunk.indexOf(NEWLINE); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
        take(chunk.subarray(start, nl));
        if (discarding) discarding = false;
        else controller.enqueue(line());
        start = nl + 1;
      }
      if (start < chunk.length) take(chunk.slice(start));
    },
    flush(controller) {
      if (!discarding && length > 0) controller.enqueue(line());
    },
  });
}
