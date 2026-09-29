import { describe, expect, it } from "vitest";
import { reportHtml, trialsJsonl } from "@harness/report";
import type { ClimbRound, Trial } from "@harness/ir";

const trial: Trial = {
  caseId: "a",
  split: "train",
  index: 0,
  output: "ok",
  tools: [],
  files: [],
  behavior: "complied",
  scores: [],
  passed: true,
};

describe("eval report", () => {
  it("RP1.1 jsonl and html include both policy rates", () => {
    const rejected: ClimbRound = {
      specId: "s",
      patchId: "p",
      frozen: { train: ["a"], test: [] },
      accepted: false,
      reason: `<script>&"'</script>`,
      train: { pass: true, impermissible: 0.25, overrefusal: 0.5, passAtK: 1 },
      test: { pass: true, impermissible: 0, overrefusal: 0, passAtK: 1 },
    };
    const jsonl = trialsJsonl(rejected, [trial]);
    const header = JSON.parse(jsonl.split("\n")[0] ?? "") as { impermissible: number; overrefusal: number };
    expect(header.impermissible).toBe(0.25);
    expect(header.overrefusal).toBe(0.5);
    expect(JSON.parse(jsonl.split("\n")[1] ?? "")).toEqual(trial);
    const html = reportHtml(rejected);
    expect(html).toContain("impermissible 0.25 0");
    expect(html).toContain("overrefusal 0.5 0");
    expect(html).toContain("&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("http");
    const accepted: ClimbRound = {
      specId: "s",
      patchId: "p",
      frozen: { train: ["a"], test: [] },
      accepted: true,
      train: rejected.train,
      test: rejected.test,
    };
    expect(reportHtml(accepted)).toContain("accepted");
    const { reason: _reason, ...missing } = rejected;
    expect(() => reportHtml({ ...missing, accepted: false })).toThrow(/reason/);
  });
});
