import { describe, expect, it } from "vitest";
import { openSessionFrame, presentReply, replyPaintCount } from "../src/present.ts";
import type { ActivityPhase } from "../src/present.ts";

/** What those bytes show after CR, LF, erase-line, cursor-up, and SGR. */
function renderScreen(bytes: string): string {
  const rows: string[] = [""];
  let row = 0;
  let col = 0;
  const ensure = (index: number): void => {
    while (rows.length <= index) rows.push("");
  };
  for (let index = 0; index < bytes.length; index += 1) {
    const ch = bytes[index] ?? "";
    if (ch === "\r") {
      col = 0;
      continue;
    }
    if (ch === "\n") {
      row += 1;
      col = 0;
      ensure(row);
      continue;
    }
    if (ch === "\x1b" && bytes[index + 1] === "[") {
      let end = index + 2;
      while (end < bytes.length && !/[A-Za-z]/.test(bytes[end] ?? "")) end += 1;
      const command = bytes[end] ?? "";
      const argument = bytes.slice(index + 2, end);
      if (command === "A") row = Math.max(0, row - (argument.length === 0 ? 1 : Number(argument)));
      else if (command === "K") {
        ensure(row);
        const chars = [...(rows[row] ?? "")];
        const mode = argument.length === 0 ? 0 : Number(argument);
        if (mode === 2) rows[row] = "";
        else if (mode === 1) rows[row] = chars.slice(col).join("");
        else rows[row] = chars.slice(0, col).join("");
      }
      index = end;
      continue;
    }
    ensure(row);
    const chars = [...(rows[row] ?? "")];
    while (chars.length < col) chars.push(" ");
    chars[col] = ch;
    rows[row] = chars.join("");
    col += 1;
  }
  return rows.join("\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

/** The rows the painter owns. The trailing ready prompt belongs to readline. */
function paintedRows(frame: { frame(): string }): string {
  const rows = frame.frame().split("\n");
  if (rows.at(-1) === "> ") rows.pop();
  return rows.join("\n");
}

/** The SGR sequence in force where `word` begins. */
function markBefore(painted: string, word: string): string {
  const at = painted.indexOf(word);
  expect(at).toBeGreaterThanOrEqual(0);
  let active = "";
  for (let index = 0; index < at; index += 1) {
    if (painted[index] !== "\x1b" || painted[index + 1] !== "[") continue;
    let end = index + 2;
    while (end < painted.length && !/[A-Za-z]/.test(painted[end] ?? "")) end += 1;
    if ((painted[end] ?? "") === "m") active = painted.slice(index, end + 1);
    index = end;
  }
  return active;
}

function withoutColor(painted: string): string {
  return painted.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("the session frame", () => {
  it("TU1.1 two chunks update one live answer, a revision replaces it, and the next turn keeps the settled answer", () => {
    const frame = openSessionFrame({ tty: true, color: true });
    let screen = "";
    const take = (): void => {
      screen += frame.draw();
    };
    frame.user("question one");
    frame.activity("responding");
    take();
    frame.chunk("left ");
    take();
    frame.chunk("right");
    const liveDraw = frame.draw();
    screen += liveDraw;
    const live = frame.frame();
    expect(liveDraw).toMatch(/\r|\x1b\[/);
    expect(live.split("left right")).toHaveLength(2);
    expect(live).not.toMatch(/left right[\s\S]*left right/);
    expect(renderScreen(screen).split("left right")).toHaveLength(2);
    frame.revise("replaced-draft");
    const revisedDraw = frame.draw();
    screen += revisedDraw;
    const revised = frame.frame();
    expect(revised).toContain("replaced-draft");
    expect(revised).not.toContain("left right");
    expect(revisedDraw).not.toContain("left right");
    expect(revisedDraw).toContain("replaced-draft");
    expect(renderScreen(screen)).not.toContain("left right");
    frame.activity("idle");
    frame.settle();
    take();
    expect(renderScreen(screen)).toContain("replaced-draft");
    expect(renderScreen(screen)).not.toContain("✶");
    frame.user("question two");
    frame.activity("responding");
    take();
    frame.chunk("turn-two");
    const delta = frame.draw();
    screen += delta;
    const picture = frame.frame();
    expect(picture).toContain("replaced-draft");
    expect(picture).toContain("turn-two");
    expect(picture).toContain("question one");
    expect(picture.split("replaced-draft")).toHaveLength(2);
    expect(delta).not.toContain("replaced-draft");
    expect(delta).toContain("turn-two");
    expect(picture.trimEnd().endsWith(">")).toBe(false);
    frame.activity("idle");
    frame.settle();
    take();
    const settled = renderScreen(screen);
    expect(settled).toContain("replaced-draft");
    expect(settled).toContain("turn-two");
    expect(settled.split("replaced-draft")).toHaveLength(2);
    expect(settled.split("turn-two")).toHaveLength(2);
    expect(settled).not.toContain("✶");
    expect(frame.frame().trimEnd().endsWith(">")).toBe(true);

    const lines = openSessionFrame({ tty: true, color: true });
    let redrawn = "";
    const takeLines = (): void => {
      redrawn += lines.draw();
    };
    lines.activity("responding");
    takeLines();
    lines.chunk("line-one\nline-two");
    takeLines();
    lines.chunk("\nline-three");
    takeLines();
    lines.revise("only-final");
    const shrunk = lines.draw();
    redrawn += shrunk;
    expect(shrunk).toMatch(/\x1b\[[2-9]A/);
    lines.activity("idle");
    lines.settle();
    takeLines();
    const replaced = renderScreen(redrawn);
    expect(replaced).toContain("only-final");
    expect(replaced).not.toContain("line-one");
    expect(replaced).not.toContain("line-two");
    expect(replaced).not.toContain("line-three");
    expect(replaced).not.toContain("responding");
    expect(replaced).not.toContain("✶");

    const fenced = openSessionFrame({ tty: true, color: true });
    let fenceBytes = "";
    const takeFence = (): void => {
      fenceBytes += fenced.draw();
    };
    fenced.activity("responding");
    takeFence();
    fenced.chunk("show **bold** and `code` and ```\ncode\n``` tail");
    takeFence();
    fenced.activity("idle");
    fenced.settle();
    takeFence();
    const fenceScreen = renderScreen(fenceBytes);
    expect(fenceScreen).toContain("bold");
    expect(fenceScreen).toContain("code");
    expect(fenceScreen).toContain("tail");
    expect(fenceScreen).not.toContain("```");
    expect(fenceScreen).not.toContain("**");
    expect(fenceScreen).not.toContain("✶");
    expect(fenceScreen).toBe(paintedRows(fenced));
  });

  it("TU1.2 a bulky intermediate collapses to an identifier while the prompt and settled answer stay", () => {
    const token = "trace-9k2";
    const short = openSessionFrame({ tty: true, color: true });
    short.intermediate("tiny-token");
    expect(short.frame()).toContain("tiny-token");
    expect(short.frame()).not.toContain("...");
    expect(short.draw()).toContain("tiny-token");
    const bulky = `${token}\n${"x".repeat(4000)}`;
    const frame = openSessionFrame({ tty: true, color: true });
    let screen = "";
    const take = (): void => {
      screen += frame.draw();
    };
    frame.user("please look");
    frame.activity("thinking");
    take();
    frame.intermediate(bulky);
    const drawn = frame.draw();
    screen += drawn;
    frame.activity("responding");
    take();
    frame.chunk("settled-answer-4m");
    take();
    frame.activity("idle");
    frame.settle();
    take();
    const picture = frame.frame();
    const shown = renderScreen(screen);
    expect(picture.length).toBeLessThan(bulky.length);
    expect(drawn.length).toBeLessThan(bulky.length);
    expect(shown.length).toBeLessThan(bulky.length);
    expect(picture).toContain(token);
    expect(drawn).toContain(token);
    expect(shown).toContain(token);
    expect(picture).toContain("please look");
    expect(picture).toContain("settled-answer-4m");
    expect(shown).toContain("settled-answer-4m");
    expect(picture).not.toContain("x".repeat(80));
    expect(drawn).not.toContain("x".repeat(80));
    expect(shown).not.toContain("x".repeat(80));
    expect(shown).not.toContain("✶");
    expect(shown).not.toContain("thinking");
    expect(shown).not.toContain("responding");
    expect(frame.frame().trimEnd().endsWith(">")).toBe(true);

    const parked = openSessionFrame({ tty: true, color: true });
    let parkedBytes = "";
    const takeParked = (): void => {
      parkedBytes += parked.draw();
    };
    parked.activity("thinking");
    takeParked();
    parked.intermediate(bulky);
    takeParked();
    parked.activity("idle");
    takeParked();
    parked.activity("processing");
    takeParked();
    const kept = renderScreen(parkedBytes);
    expect(kept).toContain(token);
    expect(kept).toContain("processing");
    expect(kept).not.toContain("thinking");
    expect(kept).not.toContain("x".repeat(80));

    const followed = openSessionFrame({ tty: true, color: true });
    let followedBytes = "";
    const takeFollowed = (): void => {
      followedBytes += followed.draw();
    };
    const trace = `${token}\n${"y".repeat(800)}`;
    followed.activity("responding");
    takeFollowed();
    followed.chunk("kept-answer");
    takeFollowed();
    followed.activity("idle");
    followed.settle();
    takeFollowed();
    followed.activity("responding");
    takeFollowed();
    followed.chunk("one\ntwo\nthree");
    takeFollowed();
    followed.intermediate(trace);
    takeFollowed();
    const during = renderScreen(followedBytes);
    expect(during).toContain("kept-answer");
    expect(during).toContain(token);
    expect(during).toContain("responding");
    expect(during.indexOf("kept-answer")).toBeLessThan(during.indexOf(token));
    expect(during.indexOf(token)).toBeLessThan(during.indexOf("\none"));
    expect(during.split("one")).toHaveLength(2);
    expect(during.split("two")).toHaveLength(2);
    expect(during.split("three")).toHaveLength(2);
    expect(during.split("⠋")).toHaveLength(2);
    expect(during).not.toContain("y".repeat(80));
    followed.activity("thinking");
    takeFollowed();
    const relabeled = renderScreen(followedBytes);
    expect(relabeled).toContain("kept-answer");
    expect(relabeled).toContain(token);
    expect(relabeled).toContain("thinking");
    expect(relabeled).not.toContain("responding");
    expect(relabeled.split("three")).toHaveLength(2);

    const mid = openSessionFrame({ tty: true, color: true });
    let midBytes = "";
    const takeMid = (): void => {
      midBytes += mid.draw();
    };
    mid.activity("responding");
    takeMid();
    mid.chunk("kept-answer");
    takeMid();
    mid.activity("idle");
    mid.settle();
    takeMid();
    mid.activity("responding");
    takeMid();
    mid.chunk("one\ntwo\nthree");
    takeMid();
    mid.activity("thinking");
    takeMid();
    mid.intermediate(trace);
    takeMid();
    const watched = renderScreen(midBytes);
    expect(watched).toContain("kept-answer");
    expect(watched).toContain(token);
    expect(watched).toContain("thinking");
    expect(watched.indexOf("kept-answer")).toBeLessThan(watched.indexOf(token));
    expect(watched.indexOf(token)).toBeLessThan(watched.indexOf("\none"));
    expect(watched.split("three")).toHaveLength(2);
    expect(watched.split("⠋")).toHaveLength(2);
    expect(watched).not.toContain("y".repeat(80));

    const joined = openSessionFrame({ tty: true, color: true });
    let joinedBytes = "";
    const takeJoined = (): void => {
      joinedBytes += joined.draw();
    };
    joined.activity("thinking");
    takeJoined();
    joined.intermediate(`${token}\n`);
    for (let delta = 0; delta < 20; delta += 1) joined.intermediate("y".repeat(20));
    takeJoined();
    joined.activity("responding");
    takeJoined();
    joined.chunk("settled-answer-4m");
    takeJoined();
    joined.activity("idle");
    joined.settle();
    takeJoined();
    const folded = renderScreen(joinedBytes);
    expect(folded).toContain(token);
    expect(folded).toContain("settled-answer-4m");
    expect(folded).not.toContain("y".repeat(40));
    expect(folded.split(token)).toHaveLength(2);
    expect(folded).not.toContain("✶");
    expect(folded.length).toBeLessThan(token.length + 400);
    expect(folded).toBe(paintedRows(joined));
  });

  it("TU1.3 processing, thinking, rewriting, and verifying replace one activity label", () => {
    const frame = openSessionFrame({ tty: true, color: true });
    let screen = "";
    const phases: readonly ActivityPhase[] = ["processing", "thinking", "rewriting", "verifying"];
    let previous = "";
    for (const phase of phases) {
      frame.activity(phase);
      const picture = frame.frame();
      const label = picture.split("\n").find((line) => line.startsWith("⠋ "));
      expect(label).toBe(`⠋ ${phase} 0.0s`);
      expect(picture.split("⠋ ").length).toBe(2);
      if (previous.length > 0) expect(picture).not.toContain(previous);
      const bytes = frame.draw();
      screen += bytes;
      if (previous.length > 0) {
        expect(bytes).toMatch(/\r|\x1b\[/);
        expect(bytes).toContain(phase);
        expect(bytes).not.toContain(previous);
      }
      const shown = renderScreen(screen);
      expect(shown).toContain(phase);
      if (previous.length > 0) expect(shown).not.toContain(previous);
      previous = phase;
    }
    frame.activity("responding");
    screen += frame.draw();
    expect(frame.frame()).toContain("⠋ responding 0.0s");
    expect(frame.frame()).not.toContain("verifying");
    expect(renderScreen(screen)).toContain("responding");
    expect(renderScreen(screen)).not.toContain("verifying");
    frame.activity("permission");
    screen += frame.draw();
    expect(frame.frame()).toContain("⠋ permission 0.0s");
    expect(frame.frame()).not.toContain("responding");
    expect(renderScreen(screen)).toContain("permission");
    expect(renderScreen(screen)).not.toContain("responding");
    frame.activity("idle");
    screen += frame.draw();
    const idle = frame.frame();
    const idleScreen = renderScreen(screen);
    expect(idle).not.toContain("✶");
    expect(idle).not.toContain("permission");
    expect(idle.trimEnd().endsWith(">")).toBe(true);
    expect(idleScreen).not.toContain("✶");
    expect(idleScreen).not.toContain("permission");
  });

  it("TU1.4 piped and colorless frames stay plain and do not redraw in place", () => {
    const piped = openSessionFrame({ tty: false, color: true });
    piped.activity("responding");
    expect(piped.draw()).toBe("\x1b[2m⠋ responding 0.0s\n\x1b[0m");
    piped.chunk("echo: hi");
    expect(piped.draw()).toBe("");
    expect(piped.frame()).toContain("echo: hi");
    const quiet = openSessionFrame({ tty: true, color: false });
    quiet.activity("thinking");
    quiet.chunk("echo: plain");
    const bytes = quiet.draw();
    expect(bytes).toBe("⠋ thinking 0.0s\n");
    expect(bytes).not.toMatch(/\x1b|\r/);
    expect(quiet.frame()).toContain("echo: plain");
    quiet.activity("idle");
    expect(quiet.draw()).toBe("");
    expect(quiet.frame()).not.toMatch(/\x1b/);
    const broken = openSessionFrame({ tty: true, color: true });
    broken.fail("Model call failed: model offline");
    const painted = broken.draw();
    expect(broken.liveText()).toBe("Model call failed: model offline");
    expect(painted).toContain("\x1b[31mModel call failed: model offline");
    expect(painted).not.toContain("\x1b[97mModel call failed");
  });

  it("TU1.5 a busy phase spins and counts each tenth of a second", () => {
    const frame = openSessionFrame({ tty: true, color: true });
    frame.activity("thinking");
    expect(frame.frame()).toContain("\u280b thinking 0.0s");
    expect(frame.frame().split("\u280b").length).toBe(2);
    expect(frame.tick()).toBe(true);
    expect(frame.frame()).toContain("\u2819 thinking 0.1s");
    expect(frame.frame()).not.toContain("thinking 0.0s");
    frame.activity("thinking");
    expect(frame.frame()).toContain("\u2819 thinking 0.1s");
    frame.tick();
    expect(frame.frame()).toContain("\u2839 thinking 0.2s");
    for (let step = 0; step < 8; step += 1) frame.tick();
    expect(frame.frame()).toContain("\u280b thinking 1.0s");
    expect(frame.frame().split("\u280b").length).toBe(2);
    frame.activity("rewriting");
    expect(frame.frame()).toContain("\u280b rewriting 0.0s");
    expect(frame.frame()).not.toContain("thinking");
    frame.activity("idle");
    expect(frame.tick()).toBe(false);
    expect(frame.frame()).not.toContain("rewriting");
    expect(frame.frame()).not.toMatch(/[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/);
    const piped = openSessionFrame({ tty: false, color: true });
    piped.activity("responding");
    expect(piped.tick()).toBe(false);
    expect(piped.frame()).toContain("\u280b responding 0.0s");
  });

  it("TU3.1 a wheel moves the visible rows, holds off the tail, and follows again at the bottom", () => {
    const frame = openSessionFrame({ tty: true, color: true, ...{ rows: 3 } });
    const report = (bytes: string): void => {
      const view = frame as { report?(bytes: string): void };
      if (typeof view.report !== "function") throw new Error("session frame does not take mouse reports");
      view.report(bytes);
    };
    let screen = "";
    const take = (): void => {
      screen += frame.draw();
    };
    const settleLine = (text: string): void => {
      frame.activity("responding");
      frame.chunk(text);
      frame.activity("idle");
      frame.settle();
      take();
    };
    for (let index = 0; index < 6; index += 1) settleLine(`line-${index}`);
    expect(frame.frame()).toBe("line-3\nline-4\nline-5\n> ");
    expect(renderScreen(screen)).toContain("line-5");
    expect(renderScreen(screen)).not.toContain("line-0");
    expect(renderScreen(screen)).not.toContain("\u2736");

    report("\x1b[<64;1");
    take();
    expect(frame.frame()).toBe("line-3\nline-4\nline-5\n> ");
    report(";1M");
    take();
    expect(frame.frame()).toBe("line-2\nline-3\nline-4\n> ");
    expect(renderScreen(screen)).toContain("line-2");
    expect(renderScreen(screen)).not.toContain("line-5");
    expect(frame.frame().split("\n").filter((row) => row.startsWith(">"))).toEqual(["> "]);

    report("\x1b[<64;1;1m");
    take();
    expect(frame.frame()).toBe("line-2\nline-3\nline-4\n> ");

    settleLine("line-6");
    expect(frame.frame()).toBe("line-2\nline-3\nline-4\n> ");
    expect(renderScreen(screen)).not.toContain("line-6");

    report("\x1b[<65;1;1M");
    take();
    expect(frame.frame()).toBe("line-3\nline-4\nline-5\n> ");
    expect(frame.frame()).not.toContain("line-6");

    report("\x1b[<65;1;1M");
    take();
    expect(frame.frame()).toBe("line-4\nline-5\nline-6\n> ");
    expect(renderScreen(screen)).toContain("line-6");
    expect(renderScreen(screen)).not.toContain("line-2");

    settleLine("line-7");
    expect(frame.frame()).toBe("line-5\nline-6\nline-7\n> ");
    expect(renderScreen(screen)).toContain("line-7");
    expect(renderScreen(screen)).not.toContain("line-4");
    expect(frame.frame().endsWith("> ")).toBe(true);
  });

  it("TU3.2 a click, drag, double-click, and triple-click select the visible text", () => {
    const openTail = (draft = ""): {
      frame: ReturnType<typeof openSessionFrame>;
      report: (bytes: string) => void;
      selection: () => string;
      caret: () => number | undefined;
    } => {
      const frame = openSessionFrame({ tty: true, color: true, ...{ rows: 4 } });
      const settleLine = (text: string): void => {
        frame.activity("responding");
        frame.chunk(text);
        frame.activity("idle");
        frame.settle();
      };
      settleLine("older-0");
      settleLine("older-1");
      settleLine("plain-row");
      settleLine("see https://example.com/docs now");
      settleLine("word-target sits here");
      settleLine("http://example.com/raw");
      const view = frame as {
        report?(bytes: string): void;
        draft?(text: string): void;
        selection?(): string;
        caret?(): number | undefined;
      };
      if (draft.length > 0) {
        if (typeof view.draft !== "function") throw new Error("session frame does not show a prompt draft");
        view.draft(draft);
      }
      const report = (bytes: string): void => {
        if (typeof view.report !== "function") throw new Error("session frame does not take mouse reports");
        view.report(bytes);
      };
      const selection = (): string => {
        if (typeof view.selection !== "function") throw new Error("session frame does not report a selection");
        const text = view.selection();
        expect(text).not.toMatch(/\x1b/);
        return text;
      };
      const caret = (): number | undefined => {
        if (typeof view.caret !== "function") throw new Error("session frame does not place a prompt caret");
        return view.caret();
      };
      return { frame, report, selection, caret };
    };
    const click = (report: (bytes: string) => void, x: number, y: number): void => {
      report(`\x1b[<0;${x};${y}M`);
      report(`\x1b[<0;${x};${y}m`);
    };
    const row = openTail();
    expect(row.frame.frame()).toBe("plain-row\nsee https://example.com/docs now\nword-target sits here\nhttp://example.com/raw\n> ");
    click(row.report, 1, 1);
    expect(row.selection()).toBe("plain-row");
    expect(row.caret()).toBeUndefined();

    const url = openTail();
    click(url.report, 5, 2);
    expect(url.selection()).toBe("https://example.com/docs");

    const beside = openTail();
    click(beside.report, 30, 2);
    expect(beside.selection()).toBe("see https://example.com/docs now");

    const http = openTail();
    click(http.report, 8, 4);
    expect(http.selection()).toBe("http://example.com/raw");

    const prompt = openTail("hello");
    expect(prompt.frame.frame().endsWith("> hello")).toBe(true);
    click(prompt.report, 4, 5);
    expect(prompt.caret()).toBe(1);
    expect(prompt.frame.frame().endsWith("> hello")).toBe(true);
    const start = openTail("hello");
    click(start.report, 1, 5);
    expect(start.caret()).toBe(0);
    const end = openTail("hello");
    click(end.report, 30, 5);
    expect(end.caret()).toBe(5);

    const drag = openTail();
    drag.report("\x1b[<0;6;3M");
    drag.report("\x1b[<32;4;4M");
    drag.report("\x1b[<0;4;4m");
    expect(drag.selection()).toBe("target sits here\nhttp");

    const word = openTail();
    click(word.report, 6, 3);
    click(word.report, 6, 3);
    expect(word.selection()).toBe("word-target");

    const line = openTail();
    click(line.report, 5, 2);
    click(line.report, 5, 2);
    click(line.report, 5, 2);
    expect(line.selection()).toBe("see https://example.com/docs now");
  });

  it("TU3.4 a wheel that cannot move stays on the tail", () => {
    const frame = openSessionFrame({ tty: true, color: true, ...{ rows: 3 } });
    const report = (bytes: string): void => {
      const view = frame as { report?(bytes: string): void };
      if (typeof view.report !== "function") throw new Error("session frame does not take mouse reports");
      view.report(bytes);
    };
    const settleLine = (text: string): void => {
      frame.activity("responding");
      frame.chunk(text);
      frame.activity("idle");
      frame.settle();
    };
    settleLine("only-a");
    settleLine("only-b");
    report("\x1b[<64;1;1M");
    settleLine("only-c");
    settleLine("only-d");
    settleLine("only-e");
    expect(frame.frame()).toBe("only-c\nonly-d\nonly-e\n> ");
  });

  it("TU3.5 a click, drag, or double-click reverses the visible text", () => {
    const frame = openSessionFrame({ tty: true, color: true, ...{ rows: 4 } });
    const view = frame as { report?(bytes: string): void };
    const report = (bytes: string): void => {
      if (typeof view.report !== "function") throw new Error("session frame does not take mouse reports");
      view.report(bytes);
    };
    const click = (x: number, y: number): void => {
      report(`\x1b[<0;${x};${y}M`);
      report(`\x1b[<0;${x};${y}m`);
    };
    const settleLine = (text: string): void => {
      frame.activity("responding");
      frame.chunk(text);
      frame.activity("idle");
      frame.settle();
    };
    settleLine("older-0");
    settleLine("plain-row");
    settleLine("see https://example.com/docs now");
    settleLine("word-target sits here");
    settleLine("tail-line");
    frame.draw();
    click(1, 1);
    const row = frame.draw();
    expect(row).toContain("\x1b[7m");
    expect(row).toMatch(/\x1b\[7m(?:\x1b\[[0-9;]*m)*plain-row/);
    expect(frame.frame()).not.toMatch(/\x1b/);
    click(5, 2);
    const url = frame.draw();
    expect(url).toMatch(/\x1b\[7m(?:\x1b\[[0-9;]*m)*https:\/\/example\.com\/docs\x1b\[27m/);
    expect(url).not.toMatch(/\x1b\[7m(?:\x1b\[[0-9;]*m)*see https/);
    click(6, 3);
    frame.draw();
    click(6, 3);
    const word = frame.draw();
    expect(word).toMatch(/\x1b\[7m(?:\x1b\[[0-9;]*m)*word-target\x1b\[27m/);
    expect(word).not.toMatch(/\x1b\[7m(?:\x1b\[[0-9;]*m)*word-target sits here/);
  });

  it("TU4.1 a slash command, a keyword, and an ordinary word take different colors", () => {
    const draw = (color: boolean): string => {
      const frame = openSessionFrame({ tty: true, color });
      frame.user("/sessions export --file notes");
      frame.user("please export the notes");
      return frame.draw();
    };
    const colored = draw(true);
    expect(draw(true)).toBe(colored);
    const command = markBefore(colored, "/sessions");
    const keyword = markBefore(colored, "export");
    const flag = markBefore(colored, "--file");
    const ordinary = markBefore(colored, "notes");
    expect(command).not.toBe("");
    expect(keyword).not.toBe("");
    expect(flag).not.toBe(command);
    expect(keyword).not.toBe(command);
    expect(flag).not.toBe(ordinary);
    expect(keyword).not.toBe(ordinary);
    expect(command).not.toBe(ordinary);
    const sentence = colored.slice(colored.lastIndexOf("please export"));
    expect(markBefore(sentence, "export")).not.toBe(keyword);
    expect(markBefore(sentence, "export")).not.toBe(command);
    expect(markBefore(sentence, "please")).not.toBe(command);
    expect(withoutColor(colored)).toContain("/sessions export --file notes");
    expect(withoutColor(colored)).toContain("please export the notes");
    const quiet = openSessionFrame({ tty: true, color: false });
    quiet.user("/sessions export --file notes");
    quiet.user("please export the notes");
    expect(quiet.draw()).not.toMatch(/\x1b\[/);
    expect(quiet.frame()).toContain("/sessions export --file notes");
    expect(quiet.frame()).toContain("please export the notes");
    expect(quiet.frame()).not.toMatch(/\x1b/);
    const held = openSessionFrame({ tty: true, color: true });
    held.hold("/sessions export --file notes");
    const heldBytes = held.draw();
    expect(markBefore(heldBytes, "/sessions")).toBe(command);
    expect(markBefore(heldBytes, "--file")).toBe(flag);
    expect(withoutColor(heldBytes)).toContain("/sessions export --file notes");
  });

  it("TU4.2 a URL is marked clickable and a click still selects that URL", () => {
    const line = "see https://example.com/docs now";
    const open = (color: boolean) => {
      const frame = openSessionFrame({ tty: true, color });
      frame.activity("responding");
      frame.chunk(line);
      frame.activity("idle");
      frame.settle();
      return frame;
    };
    const click = (frame: ReturnType<typeof openSessionFrame>): void => {
      frame.report("\x1b[<0;5;1M");
      frame.report("\x1b[<0;5;1m");
    };
    const colored = open(true);
    const bytes = colored.draw();
    const again = open(true).draw();
    expect(again).toBe(bytes);
    const url = markBefore(bytes, "https://example.com/docs");
    expect(url).not.toBe("");
    expect(url).not.toBe(markBefore(bytes, "see"));
    expect(url).not.toBe(markBefore(bytes, "now"));
    const http = presentReply("go http://example.com/raw end", true);
    expect(markBefore(http, "http://example.com/raw")).toBe(url);
    expect(markBefore(http, "http://example.com/raw")).not.toBe(markBefore(http, "go"));
    expect(withoutColor(bytes)).toContain(line);
    click(colored);
    expect(colored.selection()).toBe("https://example.com/docs");
    const quiet = open(false);
    expect(quiet.draw()).not.toMatch(/\x1b\[/);
    expect(quiet.frame()).toContain(line);
    expect(quiet.frame()).not.toMatch(/\x1b/);
    expect(presentReply(line, false)).toBe(line);
    click(quiet);
    expect(quiet.selection()).toBe("https://example.com/docs");
  });

  it("TU4.3 a code keyword is colored apart from the rest of its span", () => {
    const inline = "Say `return value` please";
    const fenced = "show **bold** and ```\nconst name\n``` tail";
    const painted = presentReply(inline, true);
    const fencedPaint = presentReply(fenced, true);
    expect(presentReply(inline, true)).toBe(painted);
    expect(presentReply(inline, false)).toBe(inline);
    expect(presentReply(fenced, false)).toBe(fenced);
    expect(fencedPaint).toContain("\x1b[1mbold");
    expect(fencedPaint).not.toContain("**bold**");
    expect(fencedPaint).not.toContain("```");
    expect(withoutColor(painted)).toBe("Say return value please");
    expect(withoutColor(fencedPaint)).toBe("show bold and const name tail");
    const keyword = markBefore(painted, "return");
    const token = markBefore(painted, "value");
    expect(keyword).not.toBe("");
    expect(keyword).not.toBe(token);
    expect(token).not.toBe(markBefore(painted, "Say"));
    expect(token).not.toBe(markBefore(painted, "please"));
    expect(markBefore(fencedPaint, "const")).not.toBe(markBefore(fencedPaint, "name"));
    expect(markBefore(fencedPaint, "name")).not.toBe(markBefore(fencedPaint, "show"));
    expect(markBefore(fencedPaint, "const")).toBe(keyword);
    const frame = openSessionFrame({ tty: true, color: true });
    frame.activity("responding");
    frame.chunk(inline);
    frame.activity("idle");
    frame.settle();
    const drawn = frame.draw();
    expect(markBefore(drawn, "return")).toBe(keyword);
    expect(markBefore(drawn, "value")).toBe(token);
    expect(withoutColor(drawn)).toContain("Say return value please");
    const quiet = openSessionFrame({ tty: true, color: false });
    quiet.activity("responding");
    quiet.chunk(fenced);
    quiet.activity("idle");
    quiet.settle();
    expect(quiet.draw()).not.toMatch(/\x1b\[/);
    expect(quiet.frame()).toContain(fenced);
    expect(quiet.frame()).not.toMatch(/\x1b/);
  });

  it("TU4.4 a later token highlights the live answer and not the settled ones", () => {
    const frame = openSessionFrame({ tty: true, color: true });
    frame.user("one");
    frame.chunk("alpha `code`");
    frame.settle();
    frame.user("two");
    frame.chunk("beta **bold**");
    frame.settle();
    frame.draw();
    const before = replyPaintCount();
    frame.chunk("gamma");
    frame.draw();
    expect(replyPaintCount() - before).toBe(1);
    const shown = paintedRows(frame);
    expect(shown).toContain("alpha");
    expect(shown).toContain("beta");
    expect(shown).toContain("gamma");
  });
});
