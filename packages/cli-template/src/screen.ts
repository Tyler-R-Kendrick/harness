/** Who last painted a row. Picture rows are the session frame; everything else is outside it. */
export type Paint = "picture" | "other";

export interface ScreenLine {
  text: string;
  paint: Paint;
}

/** A terminal grid built by walking the bytes actually written. */
export interface Screen {
  lines: ScreenLine[];
  row: number;
  col: number;
  held: string;
}

export function blankScreen(): Screen {
  return { lines: [{ text: "", paint: "other" }], row: 0, col: 0, held: "" };
}

function ensure(screen: Screen, index: number): void {
  while (screen.lines.length <= index) screen.lines.push({ text: "", paint: "other" });
}

function scroll(screen: Screen, height: number | undefined): void {
  if (height === undefined) return;
  while (screen.row >= height) {
    screen.lines.shift();
    if (screen.lines.length === 0) screen.lines.push({ text: "", paint: "other" });
    screen.row -= 1;
    ensure(screen, screen.row);
  }
}

let copied = 0;

/** Code points copied while placing characters. An appended run must not copy the line. */
export function screenCodePointsCopied(): number {
  return copied;
}

function writeChar(screen: Screen, ch: string, paint: Paint): void {
  ensure(screen, screen.row);
  const line = screen.lines[screen.row];
  if (line === undefined) return;
  const chars = [...line.text];
  copied += chars.length + 1;
  while (chars.length < screen.col) chars.push(" ");
  chars[screen.col] = ch;
  line.text = chars.join("");
  line.paint = paint;
  screen.col += 1;
}

function hasSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

/** Place a run of characters. BMP text at the cursor is one append; a surrogate stays one column per code unit. */
function writeRun(screen: Screen, text: string, paint: Paint): void {
  ensure(screen, screen.row);
  const line = screen.lines[screen.row];
  if (line === undefined || text.length === 0) return;
  if (!hasSurrogate(text) && !hasSurrogate(line.text)) {
    if (screen.col > line.text.length) line.text += " ".repeat(screen.col - line.text.length);
    if (screen.col === line.text.length) line.text += text;
    else line.text = line.text.slice(0, screen.col) + text + line.text.slice(screen.col + text.length);
    line.paint = paint;
    screen.col += text.length;
    return;
  }
  for (let index = 0; index < text.length; index += 1) writeChar(screen, text[index] ?? "", paint);
}

/** Put the cursor on a 1-based CPR row. Rows above it stay blank until something paints them. */
export function seedCursor(screen: Screen, row: number, col: number): void {
  if (!Number.isInteger(row) || row < 1) return;
  ensure(screen, row - 1);
  screen.row = row - 1;
  screen.col = Number.isInteger(col) && col >= 1 ? col - 1 : 0;
}

/** Apply one write. A newline on the last row scrolls. `paint` is the source of the cells this write draws. */
export function applyScreen(screen: Screen, bytes: string, paint: Paint = "other", height?: number): void {
  const data = screen.held + bytes;
  screen.held = "";
  for (let index = 0; index < data.length; index += 1) {
    const ch = data[index] ?? "";
    if (ch === "\r") {
      screen.col = 0;
      continue;
    }
    if (ch === "\n") {
      screen.row += 1;
      screen.col = 0;
      ensure(screen, screen.row);
      scroll(screen, height);
      continue;
    }
    if (ch === "\b") {
      screen.col = Math.max(0, screen.col - 1);
      continue;
    }
    if (ch === "\x1b" && data[index + 1] === "[") {
      let end = index + 2;
      while (end < data.length && !/[A-Za-z]/.test(data[end] ?? "")) end += 1;
      if (end >= data.length) {
        screen.held = data.slice(index);
        return;
      }
      const command = data[end] ?? "";
      const argument = data.slice(index + 2, end);
      const primary = argument.split(";")[0] ?? "";
      const parsed = primary.length === 0 ? 1 : Number(primary);
      const steps = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      if (command === "A") screen.row = Math.max(0, screen.row - steps);
      else if (command === "B") {
        screen.row += steps;
        ensure(screen, screen.row);
        scroll(screen, height);
      } else if (command === "C") screen.col += steps;
      else if (command === "D") screen.col = Math.max(0, screen.col - steps);
      else if (command === "G") screen.col = Math.max(0, steps - 1);
      else if ((command === "H" || command === "f") && !argument.startsWith("?")) {
        const parts = argument.split(";");
        const rawRow = parts[0] ?? "";
        const rawCol = parts[1] ?? "";
        const nextRow = rawRow.length === 0 ? 1 : Number(rawRow);
        const nextCol = rawCol.length === 0 ? 1 : Number(rawCol);
        screen.row = Math.max(0, (Number.isFinite(nextRow) && nextRow > 0 ? nextRow : 1) - 1);
        screen.col = Math.max(0, (Number.isFinite(nextCol) && nextCol > 0 ? nextCol : 1) - 1);
        ensure(screen, screen.row);
      } else if (command === "J" && (argument.length === 0 || argument === "0")) {
        ensure(screen, screen.row);
        const line = screen.lines[screen.row];
        if (line !== undefined) line.text = [...line.text].slice(0, screen.col).join("");
        screen.lines.length = screen.row + 1;
      } else if (command === "K") {
        ensure(screen, screen.row);
        const line = screen.lines[screen.row];
        if (line !== undefined) {
          const chars = [...line.text];
          const mode = argument.length === 0 ? 0 : Number(argument);
          if (mode === 2) line.text = "";
          else if (mode === 1) line.text = chars.slice(screen.col).join("");
          else line.text = chars.slice(0, screen.col).join("");
          line.paint = paint;
        }
      }
      index = end;
      continue;
    }
    if (ch !== "\x1b") {
      let end = index + 1;
      while (end < data.length) {
        const next = data[end] ?? "";
        if (next === "\r" || next === "\n" || next === "\b" || next === "\x1b") break;
        end += 1;
      }
      writeRun(screen, data.slice(index, end), paint);
      index = end - 1;
    }
  }
}

export function screenLines(screen: Screen): readonly string[] {
  return screen.lines.map((line) => line.text);
}

/** Screen row of each picture row. Picture paints win over a later copy of the same text. */
function alignPicture(screen: Screen, picture: readonly string[]): Map<number, number> {
  const aligned = new Map<number, number>();
  let search = 0;
  for (let index = 0; index < picture.length; index += 1) {
    const want = picture[index] ?? "";
    let found = -1;
    for (let line = search; line < screen.lines.length; line += 1) {
      const row = screen.lines[line];
      if (row !== undefined && row.paint === "picture" && row.text === want) {
        found = line;
        break;
      }
    }
    if (found < 0) {
      for (let line = search; line < screen.lines.length; line += 1) {
        const row = screen.lines[line];
        if (row !== undefined && row.text === want) {
          found = line;
          break;
        }
      }
    }
    if (found < 0) continue;
    aligned.set(found, index);
    search = found + 1;
  }
  return aligned;
}

/** Screen row of picture row 0. Negative when that row has scrolled off and a later picture row is still visible. */
export function pictureOrigin(screen: Screen, picture: readonly string[]): number | undefined {
  for (const [line, index] of alignPicture(screen, picture)) return line - index;
  return undefined;
}

/**
 * 1-based picture row for a 1-based screen row.
 * Picture paints win over a later copy of the same text. The cursor row is the prompt.
 */
export function locateClick(screen: Screen, picture: readonly string[], screenY: number): number | undefined {
  if (!Number.isInteger(screenY) || screenY < 1) return undefined;
  const hit = alignPicture(screen, picture).get(screenY - 1);
  if (hit !== undefined) return hit + 1;
  if (screenY - 1 === screen.row) return picture.length + 1;
  return undefined;
}
