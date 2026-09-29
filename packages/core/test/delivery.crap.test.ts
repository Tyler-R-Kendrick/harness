import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Repo branch-coverage floor. CRAP uses it so a function that only just clears coverage still has to stay simple. */
const BRANCH_FLOOR = 0.9;
/** Above this, a change is likely to be a Change Risk Anti-Pattern. */
const CRAP_LIMIT = 30;

const SOURCES = [
  "packages/core/src/work-queue.ts",
  "packages/core/src/task-graph.ts",
  "packages/core/src/task-workflow.ts",
];

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node);
}

/** McCabe complexity of one function, not counting decisions inside nested functions. */
function complexity(node: ts.Node): number {
  let score = 1;
  const visit = (current: ts.Node): void => {
    if (current !== node && isFunction(current)) return;
    if (
      ts.isIfStatement(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
      || ts.isWhileStatement(current)
      || ts.isDoStatement(current)
      || ts.isCatchClause(current)
      || ts.isConditionalExpression(current)
      || ts.isCaseClause(current)
    ) score += 1;
    if (ts.isBinaryExpression(current)) {
      const kind = current.operatorToken.kind;
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
        score += 1;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return score;
}

function crap(cyclomatic: number, coverage: number): number {
  const missed = 1 - coverage;
  return cyclomatic ** 2 * missed ** 3 + cyclomatic;
}

function nameOf(node: ts.FunctionLikeDeclaration): string {
  if (node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  return "anonymous";
}

describe("delivery CRAP", () => {
  it("CR1.1 queue, graph, and workflow functions stay under the CRAP limit at the branch-coverage floor", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const scored: { file: string; name: string; crap: number }[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(resolve(root, file), "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (isFunction(node)) {
          const cyclomatic = complexity(node);
          scored.push({ file, name: nameOf(node), crap: crap(cyclomatic, BRANCH_FLOOR) });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const names = new Set(scored.map((entry) => entry.name));
    expect([...names]).toEqual(expect.arrayContaining(["fromJSON", "ingest", "answer", "finishTaskWorkflow", "taskWorkflow"]));
    const offenders = scored.filter((entry) => entry.crap > CRAP_LIMIT);
    expect(offenders).toEqual([]);
  });
});
