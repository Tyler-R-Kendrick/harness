import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { PassThrough } from "node:stream";
import { paint } from "./present.ts";
import type { SessionFrame } from "./present.ts";
import { applyScreen, blankScreen, locateClick, pictureOrigin, seedCursor } from "./screen.ts";
import type { Paint, Screen, ScreenLine } from "./screen.ts";

const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
/** Alternate screen: the TUI draws here, and leaving it restores the shell the person had open. */
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";



export interface SessionConsole {
  next(): Promise<string | undefined>;
  show(): void;
  /** Write the frame's pending rows and remember them as picture rows. */
  paint(): void;
  interrupt(): void;
  close(): void;
}

/** A prefix that can still grow into an SGR 1006 mouse report. */
function isHeldReport(text: string): boolean {
  return /^\x1b(?:\[(?:<?\d*(?:;\d*){0,2})?)?$/.test(text);
}

interface RawInput extends Readable {
  setRawMode?(mode: boolean): void;
}

/**
 * The reader main uses for the session. Mouse reports are taken out of the
 * line and applied to the frame. Reporting is enabled only when `tty` is set.
 */
export function openSessionConsole(options: {
  readonly input: Readable;
  readonly output: Writable;
  readonly tty: boolean;
  readonly color: boolean;
  readonly frame: SessionFrame;
  /** Terminal height. The prompt keeps the last row, and a newline above it scrolls the picture. */
  readonly height?: number;
  /** Command typeahead. Absent, Tab stays a character. */
  readonly complete?: (prefix: string) => Promise<readonly string[]>;
  readonly onArm: () => void;
  readonly onExit: () => void;
}): SessionConsole {
  const filtered = new PassThrough();
  const complete = options.complete;
  const lines = createInterface({
    input: filtered,
    output: options.output,
    terminal: options.tty,
    prompt: paint("> ", "prompt", options.color),
    ...(complete === undefined
      ? {}
      : {
          completer: (line: string, callback: (error: null, result: [string[], string]) => void) => {
            void Promise.resolve(complete(line)).then(
              (texts) => {
                callback(null, [texts.filter((text) => text.startsWith(line)), line]);
              },
              () => {
                callback(null, [[], line]);
              },
            );
          },
        }),
  });
  // Readline leaves Tab as a character on this stream, so accept the completion here.
  if (complete !== undefined) {
    const [handler] = filtered.listeners("keypress");
    if (typeof handler === "function") {
      filtered.removeAllListeners("keypress");
      filtered.on("keypress", (sequence: string, key: { readonly name?: string } | undefined) => {
        if (key?.name === "tab") {
          const tab: unknown = Reflect.get(lines, "_tabComplete");
          if (typeof tab === "function") {
            tab.call(lines, true);
            return;
          }
        }
        handler.call(filtered, sequence, key);
      });
    }
  }
  const queued: (string | undefined)[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let held = "";
  let closed = false;
  let ended = false;
  let exitArmed = false;
  let exiting = false;
  const screen: Screen = blankScreen();
  const early: { text: string; paint: Paint }[] = [];
  let anchored = false;
  let abandoned = false;
  let painting = false;
  let pictureLine: ScreenLine | undefined;
  const write = options.output.write.bind(options.output);

  const onPromptRow = (): boolean => {
    const height = options.height;
    return height !== undefined && height > 1 && screen.row === height - 1;
  };

  const rememberPicture = (): void => {
    if (onPromptRow()) return;
    const line = screen.lines[screen.row];
    if (line !== undefined) pictureLine = line;
  };

  /** Hold rewrites the row above the cursor, so that cursor sits just under the new picture row. */
  const armHoldCursor = (): void => {
    const height = options.height;
    if (height === undefined || height < 2) {
      rememberPicture();
      return;
    }
    const picture = options.frame.picture();
    const origin = pictureOrigin(screen, picture);
    const slot = origin === undefined ? -1 : origin + picture.length;
    if (origin === undefined || origin >= height - 1 || slot <= 0 || slot >= height) return;
    while (screen.lines.length <= slot) screen.lines.push({ text: "", paint: "other" });
    const line = screen.lines[slot];
    if (line !== undefined) pictureLine = line;
  };

  /** The picture keeps the row under the banner. The prompt row is not that cursor. */
  const markContentCursor = (text: string): void => {
    const height = options.height;
    if (pictureLine !== undefined || height === undefined || height < 2) return;
    if (!text.startsWith(`\x1b[${height};1H`)) return;
    const after = screen.row + 1;
    while (screen.lines.length <= after) screen.lines.push({ text: "", paint: "other" });
    const line = screen.lines[after];
    if (line !== undefined) pictureLine = line;
  };

  const note = (text: string): void => {
    if (!options.tty || abandoned) return;
    const kind: Paint = painting ? "picture" : "other";
    if (!anchored) {
      if (early.reduce((total, chunk) => total + chunk.text.length, 0) + text.length > 8192) {
        early.length = 0;
        abandoned = true;
        return;
      }
      early.push({ text, paint: kind });
      return;
    }
    markContentCursor(text);
    applyScreen(screen, text, kind, options.height);
    if (painting) rememberPicture();
    seatPicture();
  };

  const seatPicture = (): void => {
    if (!anchored) return;
    const origin = pictureOrigin(screen, options.frame.picture());
    const height = options.height;
    if (origin === undefined || (height !== undefined && height > 1 && origin >= height - 1)) return;
    options.frame.pin(origin);
  };

  /** The next picture diff was computed from this row. Foreign writes move the real cursor. */
  const park = (): void => {
    if (!anchored || pictureLine === undefined) return;
    let at = screen.lines.indexOf(pictureLine);
    if (at < 0) {
      let last = -1;
      for (let index = 0; index < screen.lines.length; index += 1) {
        if (screen.lines[index]?.paint === "picture") last = index;
      }
      at = last < 0 ? -1 : last + 1;
    }
    if (at < 0 || at === screen.row) return;
    options.output.write(`\x1b[${at + 1};1H`);
  };

  const writePicture = (drawn: string): void => {
    if (drawn.length === 0) return;
    const parked = pictureLine;
    const atPicture = parked !== undefined && screen.lines.indexOf(parked) === screen.row;
    const promptAt = screen.row;
    const promptCol = screen.col;
    park();
    painting = true;
    options.output.write(drawn);
    painting = false;
    const height = options.height;
    if (anchored && height !== undefined && height > 1) {
      if (screen.row !== height - 1 || screen.col !== promptCol) {
        options.output.write(`\x1b[${height};${promptCol + 1}H`);
      }
    } else if (parked !== undefined && !atPicture && anchored && promptAt !== screen.row) {
      options.output.write(`\x1b[${promptAt + 1};1H`);
    }
  };

  const retarget = (token: string): string => {
    if (!anchored) return token;
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(token);
    if (match === null) return token;
    const local = locateClick(screen, options.frame.picture(), Number(match[3] ?? ""));
    return `\x1b[<${match[1]};${match[2]};${local ?? 0}${match[4]}`;
  };

  const paintFrame = (): void => {
    writePicture(options.frame.draw());
  };

  if (options.tty) {
    options.output.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const raw = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const text = !painting && anchored && onPromptRow() && raw === "\r\n" ? "\r" : raw;
      const payload: string | Uint8Array = text === raw ? chunk : text;
      note(text);
      if (typeof encoding === "function") return write(payload, encoding);
      if (encoding === undefined) {
        if (callback === undefined) return write(payload);
        return write(payload, callback);
      }
      if (callback === undefined) return write(payload, encoding);
      return write(payload, encoding, callback);
    }) as typeof options.output.write;
  }

  const deliver = (line: string | undefined): void => {
    if (line === undefined) {
      if (ended) return;
      ended = true;
    }
    const waiter = waiting.shift();
    if (waiter !== undefined) waiter(line);
    else queued.push(line);
  };

  const seatPrompt = (): void => {
    const height = options.height;
    if (!options.tty || height === undefined || height < 2) return;
    options.output.write(`\x1b[${height};1H\x1b[2K`);
  };

  const refreshInput = (): boolean => {
    if (!options.tty) return false;
    seatPrompt();
    const refresh: unknown = Reflect.get(lines, "_refreshLine");
    if (typeof refresh !== "function") return false;
    refresh.call(lines);
    return true;
  };

  const show = (): void => {
    if (closed || options.input.readableEnded === true) return;
    if (refreshInput()) return;
    lines.prompt();
  };

  const interrupt = (): void => {
    if (closed || exiting) return;
    if (!exitArmed) {
      exitArmed = true;
      options.onArm();
      options.output.write(`\r\x1b[2K${paint("Press Ctrl+C again to exit.\n", "hint", options.color)}`);
      show();
      return;
    }
    exiting = true;
    options.onExit();
  };

  const place = (caret: number): void => {
    Reflect.set(lines, "cursor", caret);
    if (refreshInput()) return;
    const refresh: unknown = Reflect.get(lines, "_refreshLine");
    if (typeof refresh === "function") refresh.call(lines);
  };

  const applyPlain = (text: string): void => {
    if (text.length === 0) return;
    filtered.write(text);
    options.frame.draft(lines.line);
  };

  const applyReport = (token: string): void => {
    options.frame.draft(lines.line);
    seatPicture();
    options.frame.report(retarget(token));
    const caret = options.frame.caret();
    if (caret !== undefined) place(caret);
    const drawn = options.frame.draw();
    if (drawn.length > 0) {
      writePicture(drawn);
      refreshInput();
    }
  };

  const take = (chunk: string): void => {
    held += chunk;
    let plain = "";
    const flush = (): void => {
      if (plain.length === 0) return;
      applyPlain(plain);
      plain = "";
    };
    while (held.length > 0) {
      const esc = held.indexOf("\x1b");
      if (esc < 0) {
        plain += held;
        held = "";
        break;
      }
      plain += held.slice(0, esc);
      const rest = held.slice(esc);
      const reported = /^\x1b\[(\d+);(\d+)R/.exec(rest);
      if (reported !== null) {
        flush();
        const reportedRow = Number(reported[1] ?? "");
        const reportedCol = Number(reported[2] ?? "");
        if (!abandoned && Number.isInteger(reportedRow) && reportedRow >= 1) {
          seedCursor(screen, reportedRow, Number.isInteger(reportedCol) && reportedCol >= 1 ? reportedCol : 1);
          anchored = true;
          const pending = early.splice(0);
          for (const chunk of pending) {
            markContentCursor(chunk.text);
            applyScreen(screen, chunk.text, chunk.paint, options.height);
            if (chunk.paint === "picture") rememberPicture();
          }
          seatPicture();
        }
        held = rest.slice(reported[0].length);
        continue;
      }
      const match = /^\x1b\[<\d+;\d+;\d+[Mm]/.exec(rest);
      if (match !== null) {
        flush();
        applyReport(match[0]);
        held = rest.slice(match[0].length);
        continue;
      }
      if (isHeldReport(rest)) {
        held = rest;
        break;
      }
      plain += rest[0] ?? "";
      held = rest.slice(1);
    }
    flush();
  };

  const onData = (chunk: Buffer | string): void => {
    take(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  };

  lines.on("line", (line: string) => {
    exitArmed = false;
    options.frame.draft("");
    if (options.tty && options.color) {
      options.frame.hold(line);
      if (anchored) {
        armHoldCursor();
        seatPicture();
      }
    }
    deliver(line);
  });
  lines.on("SIGINT", () => {
    interrupt();
  });
  lines.on("close", () => {
    deliver(undefined);
  });
  options.input.on("data", onData);
  options.input.on("end", () => {
    if (!closed) filtered.end();
  });

  if (options.tty) {
    options.output.write(ALT_ON);
    options.output.write("\x1b[6n");
    options.output.write(MOUSE_ON);
    (options.input as RawInput).setRawMode?.(true);
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    options.input.off("data", onData);
    options.input.pause();
    if (options.tty) options.output.write = write as typeof options.output.write;
    if (options.tty) {
      options.output.write(MOUSE_OFF);
      options.output.write(ALT_OFF);
      (options.input as RawInput).setRawMode?.(false);
    }
    lines.close();
  };

  return {
    next() {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    show,
    paint: paintFrame,
    interrupt,
    close,
  };
}
