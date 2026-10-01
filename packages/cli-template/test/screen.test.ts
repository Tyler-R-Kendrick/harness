import { describe, expect, it } from "vitest";
import { applyScreen, blankScreen, screenCodePointsCopied } from "../src/screen.ts";

describe("the session screen", () => {
  it("TU5.1 a cleared line is appended without copying the line per character", () => {
    const screen = blankScreen();
    const text = "x".repeat(2000);
    const before = screenCodePointsCopied();
    applyScreen(screen, `\r\x1b[2K${text}`);
    expect(screen.lines[0]?.text).toBe(text);
    expect(screen.col).toBe(text.length);
    expect(screenCodePointsCopied()).toBe(before);
  });

  it("TU5.2 a gap, an overwrite, and an emoji keep their columns", () => {
    const screen = blankScreen();
    applyScreen(screen, "\x1b[5Ghi");
    expect(screen.lines[0]?.text).toBe("    hi");
    applyScreen(screen, "\rabcdef");
    applyScreen(screen, "\r\x1b[3GXY");
    expect(screen.lines[0]?.text).toBe("abXYef");
    expect(screen.col).toBe(4);
    applyScreen(screen, "\r\x1b[2K\u{1F600}");
    expect(screen.lines[0]?.text).toBe("\u{1F600}");
    expect(screen.col).toBe(2);
  });
});
