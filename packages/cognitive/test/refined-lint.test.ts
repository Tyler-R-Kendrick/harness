import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const lint = async (code: string) => {
  const eslint = new ESLint({ cwd: new URL("../../..", import.meta.url).pathname });
  const [result] = await eslint.lintText(code, { filePath: "packages/cognitive/src/example.ts" });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
};

describe("refined types under static analysis", () => {
  it("UN2.1 casting a value to a refined type is a lint error; its constructor is the way to make one", async () => {
    expect(await lint(`import type { Probability } from "./units.ts";\nexport const p = 2 as Probability;\n`)).toEqual([
      "Refined types are made by parsing: use the type's constructor or schema, not a cast.",
    ]);
    expect(await lint(`import type { LessonId } from "x";\nexport const id = <LessonId>"m1";\n`)).toHaveLength(1);
    expect(await lint(`import { probability } from "./units.ts";\nexport const p = probability(0.5);\nexport const n = 2 as number;\n`)).toEqual([]);
  });
});
