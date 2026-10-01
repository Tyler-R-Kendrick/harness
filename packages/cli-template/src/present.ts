/** Person-visible roles. Codes stay off the logical words so tests can match the text. */
const ROLE = {
  hint: "2",
  prompt: "36",
  assistant: "97",
  error: "31",
  warning: "33",
  working: "2",
} as const;

export type PresentRole = keyof typeof ROLE;

const ASSISTANT = ROLE.assistant;

/** `NO_COLOR` wins. `FORCE_COLOR` opts in when stdout is not a terminal. */
export function colorEnabled(tty: boolean, env: NodeJS.ProcessEnv): boolean {
  const no = env["NO_COLOR"];
  if (no !== undefined && no.length > 0) return false;
  const force = env["FORCE_COLOR"];
  if (force === "0") return false;
  if (force !== undefined && force.length > 0) return true;
  return tty;
}

export function paint(text: string, role: PresentRole, color: boolean): string {
  if (!color) return text;
  return `\x1b[${ROLE[role]}m${text}\x1b[0m`;
}

export function workingLine(color: boolean): string {
  return `${paint("✶", "working", color)}\n`;
}

/** Braille spinner, one frame per tenth of a second (the dots cycle from cli-spinners). */
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The busy label: spinner, phase, and how long that phase has been showing. */
function activityLabel(phase: string, step: number): string {
  const glyph = SPIN[step % SPIN.length] ?? SPIN[0];
  return `${glyph} ${phase} ${(step / 10).toFixed(1)}s`;
}

const FENCE = /```[^\n]*\n([\s\S]*?)```|```([^`\n]+)```/g;
const COMMAND = "32";
const KEYWORD = "95";
const CODE_KEYWORD = "33";
const CLICK = "4";
const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "else", "export", "extends",
  "false", "for", "function", "if", "implements", "import", "interface", "let", "new", "null", "private", "protected", "public",
  "readonly", "return", "static", "switch", "this", "throw", "true", "try", "type", "typeof", "var", "while", "yield",
]);

function paintCodeTokens(inner: string, code: string): string {
  return inner.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
    if (!KEYWORDS.has(word)) return word;
    return `\x1b[${CODE_KEYWORD}m${word}\x1b[${code}m`;
  });
}

/** Underline http(s) spans. The bytes are SGR, so plain columns stay on the words. */
function markUrls(painted: string): string {
  const plain = painted.replace(/\x1b\[[0-9;]*m/g, "");
  const ranges: { start: number; end: number }[] = [];
  for (const match of plain.matchAll(/https?:\/\/[^\s]+/g)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  if (ranges.length === 0) return painted;
  let plainIndex = 0;
  let rangeAt = 0;
  let underlined = false;
  let out = "";
  const close = (): void => {
    if (!underlined) return;
    out += "\x1b[24m";
    underlined = false;
    rangeAt += 1;
  };
  for (let index = 0; index < painted.length; index += 1) {
    const ch = painted[index] ?? "";
    if (ch === "\x1b" && painted[index + 1] === "[") {
      let end = index + 2;
      while (end < painted.length && !/[A-Za-z]/.test(painted[end] ?? "")) end += 1;
      out += painted.slice(index, end + 1);
      index = end;
      continue;
    }
    const range = ranges[rangeAt];
    if (!underlined && range !== undefined && plainIndex === range.start) {
      out += `\x1b[${CLICK}m`;
      underlined = true;
    }
    if (underlined && range !== undefined && plainIndex === range.end) close();
    out += ch;
    plainIndex += 1;
  }
  close();
  return out;
}

function paintUserText(text: string, color: boolean): string {
  if (!color) return text;
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const body = text.slice(lead.length);
  if (!body.startsWith("/")) return markUrls(text);
  const painted = body.split(/(\s+)/).map((part) => {
    if (part === "" || /^\s+$/.test(part)) return part;
    if (part.startsWith("/")) return `\x1b[${COMMAND}m${part}\x1b[0m`;
    if (/^--?[A-Za-z][\w-]*$/.test(part) || KEYWORDS.has(part)) return `\x1b[${KEYWORD}m${part}\x1b[0m`;
    return part;
  }).join("");
  return markUrls(`${lead}${painted}`);
}

/** Bold, inline code, and fenced spans. Marker characters are not left as the formatting. */
let replyPaints = 0;

/** How many times a reply was highlighted. A settled row must not add another. */
export function replyPaintCount(): number {
  return replyPaints;
}

export function presentReply(text: string, color: boolean): string {
  replyPaints += 1;
  if (!color) return text;
  const fenced = text.replace(FENCE, (_match, block: string | undefined, inlineFence: string | undefined) => {
    const inner = (block ?? inlineFence ?? "").replace(/\n$/, "");
    return `\x1b[34m${paintCodeTokens(inner, "34")}\x1b[${ASSISTANT}m`;
  });
  const body = fenced.replace(/`([^`\n]+)`/g, (_match, inner: string) => `\x1b[35m${paintCodeTokens(inner, "35")}\x1b[${ASSISTANT}m`).replace(/\*\*([^*\n]+)\*\*/g, "\x1b[1m$1\x1b[22m");
  return markUrls(`\x1b[${ASSISTANT}m${body}\x1b[0m`);
}

/** What the live session is doing. `idle` is the ready prompt. */
export type ActivityPhase = "processing" | "thinking" | "rewriting" | "verifying" | "responding" | "permission" | "tool" | "error" | "idle";

const BULK_AT = 240;

/** A long intermediate body keeps its opening identifier and drops the rest. */
export function collapseBulk(text: string): string {
  if (text.length <= BULK_AT) return text;
  const line = text.split("\n", 1)[0] ?? "";
  const head = line.length > 0 && line.length <= 80 ? line : text.slice(0, 48).replaceAll("\n", " ");
  return `${head} ...`;
}

interface FrameCell {
  readonly kind: "user" | "answer" | "intermediate";
  readonly text: string;
  readonly error: boolean;
}

export interface SessionFrame {
  frame(): string;
  draw(): string;
  liveText(): string;
  user(text: string): void;
  chunk(text: string): void;
  revise(text: string): void;
  fail(text: string): void;
  intermediate(text: string): void;
  settle(): void;
  activity(phase: ActivityPhase): void;
  /** Advance a busy phase by a tenth of a second. Idle, and a frame that is not redrawn in place, stay still. */
  tick(): boolean;
  /** SGR 1006 bytes. A partial report is kept until it closes. */
  report(bytes: string): void;
  draft(text: string): void;
  selection(): string;
  caret(): number | undefined;
  /** Plain rows of the visible picture, without the prompt. */
  picture(): readonly string[];
  /** Screen row of picture row 0. Negative once that row has scrolled off. */
  pin(origin: number): void;
  /** A submitted line the prompt already painted. Keep it without drawing it again. */
  hold(text: string): void;
}

/** Rewrite from the first row that changed. `below` means the cursor is on the blank line under the picture. `pin` is the screen row of picture row 0, negative when that row has scrolled off. */
function paintDiff(previous: readonly string[], next: readonly string[], below: boolean, pin: number | undefined): { readonly bytes: string; readonly below: boolean } {
  let start = 0;
  const shared = Math.min(previous.length, next.length);
  while (start < shared && previous[start] === next[start]) start += 1;
  if (start === previous.length && start === next.length) return { bytes: "", below };
  const cursor = below || previous.length === 0 ? previous.length : previous.length - 1;
  const target = start >= previous.length ? previous.length : start;
  const delta = target - cursor;
  const end = Math.max(previous.length, next.length);
  const skip = pin !== undefined ? Math.max(0, -(pin + target)) : 0;
  const from = target + skip;
  let bytes = "";
  if (pin !== undefined) {
    if (from >= end) return { bytes: "", below };
    bytes += `\x1b[${pin + from + 1};1H`;
  } else if (delta > 0) bytes += "\n".repeat(delta);
  else if (delta < 0) bytes += `\x1b[${-delta}A`;
  const writeCount = end - from;
  for (let index = 0; index < writeCount; index += 1) {
    bytes += `\r\x1b[2K${next[from + index] ?? ""}`;
    if (index < writeCount - 1) bytes += "\n";
  }
  const written = Math.max(next.length - from, 0);
  const extra = writeCount - written;
  if (written === 0) {
    if (writeCount > 1) bytes += `\x1b[${writeCount - 1}A`;
  } else if (extra > 0) bytes += `\x1b[${extra}A`;
  return { bytes, below: false };
}

function plainRow(row: string): string {
  return row.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Settled cells, one open thought, one live answer, and one activity label. The terminal is a diff of those rows. */
export function openSessionFrame(options: { readonly tty: boolean; readonly color: boolean; readonly rows?: number }): SessionFrame {
  const cells: FrameCell[] = [];
  const rowCache = new Map<FrameCell, readonly string[]>();
  let thought = "";
  let live = "";
  let liveError = false;
  let phase: ActivityPhase = "idle";
  let busy = 0;
  let pending = "";
  let lastRows: readonly string[] = [];
  let below = false;
  let origin = 0;
  let stick = true;
  let draftText = "";
  let selected = "";
  let caretPos: number | undefined;
  let pendingReport = "";
  let anchor: { readonly x: number; readonly y: number } | undefined;
  let dragging = false;
  let clicks = 0;
  let lastAt = 0;
  let lastKey = "";
  let span: { startRow: number; startCol: number; endRow: number; endCol: number } | undefined;
  let picturePin: number | undefined;
  const inPlace = options.tty && options.color;

  function paintAnswer(text: string, error: boolean): string[] {
    const painted = error ? paint(text, "error", options.color) : presentReply(text, options.color);
    return painted.split("\n");
  }

  function cellRows(cell: FrameCell): readonly string[] {
    const cached = rowCache.get(cell);
    if (cached !== undefined) return cached;
    const rows =
      cell.kind === "user"
        ? [`> ${paintUserText(cell.text, options.color)}`]
        : cell.kind === "intermediate"
          ? collapseBulk(cell.text).split("\n")
          : paintAnswer(cell.text, cell.error);
    rowCache.set(cell, rows);
    return rows;
  }

  function paintedRows(): string[] {
    const rows: string[] = [];
    for (const cell of cells) rows.push(...cellRows(cell));
    if (thought.length > 0) rows.push(...collapseBulk(thought).split("\n"));
    if (phase !== "idle") rows.push(paint(activityLabel(phase, busy), "working", options.color));
    if (live.length > 0) rows.push(...paintAnswer(live, liveError));
    return rows;
  }

  function invertSpan(painted: string, start: number, endExclusive: number): string {
    if (start >= endExclusive || start < 0) return painted;
    let plain = 0;
    let out = "";
    let on = false;
    const finish = (): void => {
      if (!on) return;
      out += "\x1b[27m";
      on = false;
    };
    for (let index = 0; index < painted.length; index += 1) {
      const ch = painted[index] ?? "";
      if (ch === "\x1b" && painted[index + 1] === "[") {
        let end = index + 2;
        while (end < painted.length && !/[A-Za-z]/.test(painted[end] ?? "")) end += 1;
        out += painted.slice(index, end + 1);
        index = end;
        continue;
      }
      if (!on && plain === start) {
        out += "\x1b[7m";
        on = true;
      }
      out += ch;
      plain += 1;
      if (on && plain === endExclusive) finish();
    }
    finish();
    return out;
  }

  function decorate(painted: string, rowIndex: number): string {
    if (span === undefined || rowIndex < span.startRow || rowIndex > span.endRow) return painted;
    const plain = plainRow(painted);
    const start = rowIndex === span.startRow ? span.startCol : 0;
    const end = rowIndex === span.endRow ? span.endCol + 1 : plain.length;
    return invertSpan(painted, start, end);
  }

  function visiblePainted(): string[] {
    const all = paintedRows();
    const space = options.rows;
    const limit = space === undefined ? 0 : Math.max(0, all.length - space);
    if (space !== undefined) {
      if (stick) origin = limit;
      else if (origin > limit) origin = limit;
    }
    const slice = space === undefined ? all : all.slice(origin, origin + space);
    return slice.map((row, index) => decorate(row, index));
  }

  function plainVisible(): string[] {
    return visiblePainted().map(plainRow);
  }

  function sync(): void {
    if (!inPlace) return;
    const next = visiblePainted();
    const painted = paintDiff(lastRows, next, below, picturePin);
    pending += painted.bytes;
    below = painted.below;
    lastRows = next;
  }

  function rememberAnswer(text: string, error: boolean): void {
    if (live.length === 0) liveError = error;
    else if (liveError !== error) liveError = false;
    live += text;
    sync();
  }

  function repaint(): void {
    sync();
    if (!inPlace) return;
    if (!below && lastRows.length > 0) {
      pending += "\n";
      below = true;
    }
  }

  function wheel(direction: -1 | 1): void {
    const space = options.rows;
    if (space === undefined) return;
    const limit = Math.max(0, paintedRows().length - space);
    if (stick) origin = limit;
    else if (origin > limit) origin = limit;
    if (direction < 0) {
      if (origin === 0) return;
      origin -= 1;
      stick = false;
    } else {
      const next = Math.min(limit, origin + 1);
      if (next === origin && stick) return;
      origin = next;
      stick = origin >= limit;
    }
    span = undefined;
    repaint();
  }

  function wordAt(text: string, column: number): { readonly text: string; readonly start: number } | undefined {
    const index = column - 1;
    for (const match of text.matchAll(/\S+/g)) {
      const start = match.index ?? 0;
      if (index >= start && index < start + match[0].length) return { text: match[0], start };
    }
    return undefined;
  }

  function urlAt(text: string, column: number): { readonly text: string; readonly start: number } | undefined {
    const index = column - 1;
    for (const match of text.matchAll(/https?:\/\/[^\s]+/g)) {
      const start = match.index ?? 0;
      if (index >= start && index < start + match[0].length) return { text: match[0], start };
    }
    return undefined;
  }

  function locate(column: number, row: number, rows: readonly string[]): { readonly row: number; readonly col: number } | undefined {
    if (row < 0 || row >= rows.length) return undefined;
    const text = rows[row] ?? "";
    if (text.length === 0) return { row, col: 0 };
    return { row, col: Math.min(Math.max(0, column), text.length - 1) };
  }

  function between(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): string {
    const rows = plainVisible();
    const start = locate(from.x - 1, from.y - 1, rows);
    const end = locate(to.x - 1, to.y - 1, rows);
    if (start === undefined || end === undefined) return selected;
    const flipped = start.row > end.row || (start.row === end.row && start.col > end.col);
    const head = flipped ? end : start;
    const tail = flipped ? start : end;
    span = { startRow: head.row, startCol: head.col, endRow: tail.row, endCol: tail.col };
    if (head.row === tail.row) return (rows[head.row] ?? "").slice(head.col, tail.col + 1);
    const parts = [(rows[head.row] ?? "").slice(head.col)];
    for (let index = head.row + 1; index < tail.row; index += 1) parts.push(rows[index] ?? "");
    parts.push((rows[tail.row] ?? "").slice(0, tail.col + 1));
    return parts.join("\n");
  }

  function markRow(row: number, text: string, start: number, endInclusive: number, value: string): void {
    selected = value;
    span = text.length === 0 || endInclusive < start ? undefined : { startRow: row, startCol: start, endRow: row, endCol: endInclusive };
    repaint();
  }

  function selectAt(x: number, y: number, count: number): void {
    const rows = plainVisible();
    if (phase === "idle" && y === rows.length + 1) {
      caretPos = Math.min(Math.max(0, x - 1 - 2), draftText.length);
      selected = "";
      span = undefined;
      repaint();
      return;
    }
    caretPos = undefined;
    const text = rows[y - 1];
    if (text === undefined) return;
    const row = y - 1;
    if (count >= 3) {
      markRow(row, text, 0, text.length - 1, text);
      return;
    }
    if (count === 2) {
      const word = wordAt(text, x);
      if (word === undefined) markRow(row, text, 0, -1, "");
      else markRow(row, text, word.start, word.start + word.text.length - 1, word.text);
      return;
    }
    const url = urlAt(text, x);
    if (url !== undefined) {
      markRow(row, text, url.start, url.start + url.text.length - 1, url.text);
      return;
    }
    markRow(row, text, 0, text.length - 1, text);
  }

  function pressAt(x: number, y: number): void {
    anchor = { x, y };
    dragging = false;
  }

  function moveAt(x: number, y: number): void {
    if (anchor === undefined) return;
    if (x !== anchor.x || y !== anchor.y) dragging = true;
    if (dragging) {
      selected = between(anchor, { x, y });
      repaint();
    }
  }

  function releaseAt(x: number, y: number): void {
    if (anchor === undefined) return;
    const from = anchor;
    const moved = dragging || x !== from.x || y !== from.y;
    anchor = undefined;
    dragging = false;
    if (moved) {
      selected = between(from, { x, y });
      clicks = 0;
      lastKey = "";
      caretPos = undefined;
      repaint();
      return;
    }
    const now = Date.now();
    const key = `${x}:${y}`;
    clicks = key === lastKey && now - lastAt <= 500 ? clicks + 1 : 1;
    lastAt = now;
    lastKey = key;
    selectAt(x, y, clicks);
  }

  function applyReport(token: string): void {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(token);
    if (match === null) return;
    const button = Number(match[1] ?? "");
    const x = Number(match[2] ?? "");
    const y = Number(match[3] ?? "");
    const release = match[4] === "m";
    const base = button - (button & 0b11100);
    if (base === 64 || base === 65) {
      if (!release) wheel(base === 64 ? -1 : 1);
      return;
    }
    if ((base & ~32) !== 0) return;
    if (release) releaseAt(x, y);
    else if ((base & 32) !== 0) moveAt(x, y);
    else pressAt(x, y);
  }

  return {
    frame() {
      const rows = plainVisible();
      if (phase === "idle") rows.push(`> ${draftText}`);
      return rows.join("\n");
    },
    draw() {
      const out = pending;
      pending = "";
      return out;
    },
    liveText() {
      return live;
    },
    user(text) {
      cells.push({ kind: "user", text, error: false });
      sync();
    },
    chunk(text) {
      rememberAnswer(text, false);
    },
    revise(text) {
      live = text;
      liveError = false;
      sync();
    },
    fail(text) {
      rememberAnswer(text, true);
    },
    intermediate(text) {
      thought += text;
      sync();
    },
    settle() {
      if (thought.length > 0) cells.push({ kind: "intermediate", text: thought, error: false });
      thought = "";
      if (live.length > 0) cells.push({ kind: "answer", text: live, error: liveError });
      live = "";
      liveError = false;
      if (!inPlace) return;
      sync();
      if (!below && lastRows.length > 0) {
        pending += "\n";
        below = true;
      }
    },
    activity(next) {
      if (next === phase) return;
      phase = next;
      busy = 0;
      if (!inPlace) {
        if (next !== "idle") pending += paint(`${activityLabel(next, 0)}\n`, "working", options.color);
        return;
      }
      sync();
    },
    tick() {
      if (phase === "idle" || !inPlace) return false;
      busy += 1;
      sync();
      return true;
    },
    report(bytes) {
      pendingReport += bytes;
      const pattern = /\x1b\[<\d+;\d+;\d+[Mm]/g;
      let cursor = 0;
      for (const match of pendingReport.matchAll(pattern)) {
        applyReport(match[0]);
        cursor = (match.index ?? 0) + match[0].length;
      }
      pendingReport = pendingReport.slice(cursor);
      const esc = pendingReport.lastIndexOf("\x1b");
      if (esc < 0) pendingReport = "";
      else if (esc > 0) pendingReport = pendingReport.slice(esc);
    },
    draft(text) {
      draftText = text;
    },
    selection() {
      return selected;
    },
    caret() {
      return caretPos;
    },
    picture() {
      return plainVisible();
    },
    pin(origin) {
      if (Number.isInteger(origin)) picturePin = origin;
    },
    hold(text) {
      cells.push({ kind: "user", text, error: false });
      selected = "";
      caretPos = undefined;
      span = undefined;
      if (!inPlace) return;
      const rows = visiblePainted();
      lastRows = rows;
      below = true;
      const shown = rows[rows.length - 1];
      if (shown !== undefined) pending += `\x1b[1A\r\x1b[2K${shown}\n`;
    },
  };
}
