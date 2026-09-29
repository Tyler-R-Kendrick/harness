/**
 * Static executor for a MAF-shaped declarative workflow.
 * The document is data: SetVariable, AppendValue, If, Foreach, InvokeFunctionTool,
 * EndWorkflow. PowerFx-shaped expressions are If, Last, Count, Index, Blank,
 * comparisons, addition, and subtraction. The executor does not change when a
 * workflow file changes, and an unknown action kind is refused before any tool runs.
 */

export interface DeclarativeInput {
  readonly type: string;
  readonly description?: string;
}

export interface DeclarativeWorkflow {
  readonly name: string;
  readonly description: string;
  readonly inputs: Readonly<Record<string, DeclarativeInput>>;
  readonly id: string;
  readonly actions: readonly DeclarativeAction[];
}

export type DeclarativeAction =
  | { readonly kind: "SetVariable"; readonly id?: string; readonly variable: string; readonly value: unknown }
  | { readonly kind: "AppendValue"; readonly id?: string; readonly variable: string; readonly value: unknown }
  | { readonly kind: "If"; readonly id?: string; readonly condition: string; readonly then: readonly DeclarativeAction[]; readonly else: readonly DeclarativeAction[] }
  | { readonly kind: "Foreach"; readonly id?: string; readonly source: string; readonly itemName: string; readonly indexName: string; readonly actions: readonly DeclarativeAction[] }
  | { readonly kind: "InvokeFunctionTool"; readonly id?: string; readonly functionName: string; readonly arguments: Readonly<Record<string, unknown>>; readonly output?: string }
  | { readonly kind: "EndWorkflow"; readonly id?: string };

export interface DeclarativeCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface DeclarativeReport {
  readonly status: "done" | "halted";
  readonly reason?: string;
  readonly calls: readonly DeclarativeCall[];
}

export interface DeclarativeTool {
  (args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

const LOCAL = /^Local\.[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_LIMIT = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function localName(value: unknown): string {
  if (typeof value !== "string" || !LOCAL.test(value)) throw new TypeError("variable must be Local.<name>");
  return value.slice("Local.".length);
}

function optionalId(record: Record<string, unknown>): string | undefined {
  const id = field(record, "id");
  if (id === undefined) return undefined;
  if (typeof id !== "string" || id.length === 0) throw new TypeError("action id must be a string");
  return id;
}

function expression(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("=") || value.length < 2) throw new TypeError(`${label} must be an expression`);
  return value.slice(1);
}

function parseActions(value: unknown): DeclarativeAction[] {
  if (!Array.isArray(value)) throw new TypeError("actions must be an array");
  return value.map(parseAction);
}

function parseAction(input: unknown): DeclarativeAction {
  if (!isRecord(input)) throw new TypeError("action must be an object");
  const kind = field(input, "kind");
  const id = optionalId(input);
  const identified = id === undefined ? {} : { id };
  if (kind === "SetVariable") {
    return { kind, ...identified, variable: localName(field(input, "variable")), value: field(input, "value") };
  }
  if (kind === "AppendValue") {
    return { kind, ...identified, variable: localName(field(input, "variable")), value: field(input, "value") };
  }
  if (kind === "If") {
    const otherwise = field(input, "else");
    return {
      kind,
      ...identified,
      condition: expression(field(input, "condition"), "condition"),
      then: parseActions(field(input, "then")),
      else: otherwise === undefined ? [] : parseActions(otherwise),
    };
  }
  if (kind === "Foreach") {
    const itemName = field(input, "itemName");
    const indexName = field(input, "indexName");
    return {
      kind,
      ...identified,
      source: expression(field(input, "source"), "source"),
      itemName: itemName === undefined ? "item" : requireName(itemName, "itemName"),
      indexName: indexName === undefined ? "index" : requireName(indexName, "indexName"),
      actions: parseActions(field(input, "actions")),
    };
  }
  if (kind === "InvokeFunctionTool") {
    const functionName = field(input, "functionName");
    if (typeof functionName !== "string" || functionName.length === 0) throw new TypeError("functionName must be a string");
    const raw = field(input, "arguments");
    if (raw !== undefined && !isRecord(raw)) throw new TypeError("arguments must be an object");
    const output = field(input, "output");
    let stored: string | undefined;
    if (output !== undefined) {
      if (!isRecord(output)) throw new TypeError("output must be an object");
      stored = localName(field(output, "result"));
    }
    return {
      kind,
      ...identified,
      functionName,
      arguments: raw === undefined ? {} : raw,
      ...(stored === undefined ? {} : { output: stored }),
    };
  }
  if (kind === "EndWorkflow") return { kind, ...identified };
  throw new TypeError(`unknown action kind ${String(kind)}`);
}

function requireName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError(`${label} must be a name`);
  return value;
}

function parseInputs(value: unknown): Record<string, DeclarativeInput> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("inputs must be an object");
  const inputs: Record<string, DeclarativeInput> = {};
  for (const key of Object.keys(value)) {
    const spec = value[key];
    if (!isRecord(spec) || typeof spec["type"] !== "string") throw new TypeError(`input ${key} needs a type`);
    const description = spec["description"];
    inputs[key] = description === undefined ? { type: spec["type"] } : { type: spec["type"], description: typeof description === "string" ? description : "" };
  }
  return inputs;
}

/** Parse a declarative workflow document. The host has already read the YAML into an object. */
export function parseDeclarativeWorkflow(input: unknown): DeclarativeWorkflow {
  if (!isRecord(input)) throw new TypeError("workflow must be an object");
  if (field(input, "kind") !== "Workflow") throw new TypeError("workflow kind must be Workflow");
  const name = field(input, "name");
  if (typeof name !== "string" || name.length === 0) throw new TypeError("workflow name must be a string");
  const description = field(input, "description");
  const trigger = field(input, "trigger");
  if (!isRecord(trigger) || field(trigger, "kind") !== "OnConversationStart") throw new TypeError("workflow trigger must be OnConversationStart");
  const id = field(trigger, "id");
  if (typeof id !== "string" || id.length === 0) throw new TypeError("workflow trigger id must be a string");
  return {
    name,
    description: typeof description === "string" ? description : "",
    inputs: parseInputs(field(input, "inputs")),
    id,
    actions: parseActions(field(trigger, "actions")),
  };
}

type Token =
  | { readonly k: "num"; readonly v: number }
  | { readonly k: "str"; readonly v: string }
  | { readonly k: "id"; readonly v: string }
  | { readonly k: "op"; readonly v: string };

function scan(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] ?? "";
    if (c === " " || c === "\n" || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "\"") {
      let j = i + 1;
      let text = "";
      while (j < input.length && input[j] !== "\"") {
        text += input[j];
        j += 1;
      }
      if (input[j] !== "\"") throw new TypeError("expression string is not closed");
      tokens.push({ k: "str", v: text });
      i = j + 1;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < input.length && (input[j] ?? "") >= "0" && (input[j] ?? "") <= "9") j += 1;
      tokens.push({ k: "num", v: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] ?? "")) j += 1;
      tokens.push({ k: "id", v: input.slice(i, j) });
      i = j;
      continue;
    }
    if ("().,=<>+-".includes(c)) {
      tokens.push({ k: "op", v: c });
      i += 1;
      continue;
    }
    throw new TypeError(`expression has ${c}`);
  }
  return tokens;
}

interface EvalContext {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly local: Record<string, unknown>;
  readonly scope: ReadonlyMap<string, unknown>;
}

function evaluate(text: string, ctx: EvalContext): unknown {
  const tokens = scan(text);
  let i = 0;
  const peek = (op?: string): boolean => {
    const token = tokens[i];
    if (token === undefined) return false;
    if (op === undefined) return true;
    return token.k === "op" && token.v === op;
  };
  const take = (): Token => {
    const token = tokens[i];
    if (token === undefined) throw new TypeError("expression ended early");
    i += 1;
    return token;
  };
  const expectOp = (op: string): void => {
    const token = take();
    if (token.k !== "op" || token.v !== op) throw new TypeError(`expression expected ${op}`);
  };
  const expectId = (): string => {
    const token = take();
    if (token.k !== "id") throw new TypeError("expression expected a name");
    return token.v;
  };
  const prop = (value: unknown, name: string): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`expression has no ${name}`);
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, name)) throw new TypeError(`expression has no ${name}`);
    return record[name];
  };
  const dots = (value: unknown): unknown => {
    let current = value;
    while (peek(".")) {
      expectOp(".");
      current = prop(current, expectId());
    }
    return current;
  };
  const args = (): unknown[] => {
    expectOp("(");
    const values: unknown[] = [];
    if (!peek(")")) {
      values.push(comparison());
      while (peek(",")) {
        expectOp(",");
        values.push(comparison());
      }
    }
    expectOp(")");
    return values;
  };
  const call = (name: string): unknown => {
    const values = args();
    if (name === "Blank") {
      if (values.length !== 0) throw new TypeError("Blank takes no arguments");
      return null;
    }
    if (name === "Last") {
      const list = values[0];
      if (values.length !== 1 || !Array.isArray(list) || list.length === 0) throw new TypeError("Last needs a non-empty array");
      return list[list.length - 1];
    }
    if (name === "Count") {
      const list = values[0];
      if (values.length !== 1 || !Array.isArray(list)) throw new TypeError("Count needs an array");
      return list.length;
    }
    if (name === "Index") {
      const list = values[0];
      const at = values[1];
      if (values.length !== 2 || !Array.isArray(list) || typeof at !== "number" || !Number.isInteger(at) || at < 0 || at >= list.length) {
        throw new TypeError("Index is outside the array");
      }
      return list[at];
    }
    throw new TypeError(`unknown expression ${name}`);
  };
  function postfix(): unknown {
    const token = take();
    if (token.k === "num" || token.k === "str") return token.v;
    if (token.k !== "id") throw new TypeError("expression expected a value");
    if (token.v === "If" && peek("(")) return dots(ifValue());
    if (token.v === "Workflow") {
      expectOp(".");
      if (expectId() !== "Inputs") throw new TypeError("expression has no Inputs");
      expectOp(".");
      const key = expectId();
      if (!Object.hasOwn(ctx.inputs, key)) throw new TypeError(`expression has no ${key}`);
      return dots(ctx.inputs[key]);
    }
    if (token.v === "Local") {
      expectOp(".");
      const key = expectId();
      if (!Object.hasOwn(ctx.local, key)) throw new TypeError(`expression has no ${key}`);
      return dots(ctx.local[key]);
    }
    if (peek("(")) return dots(call(token.v));
    if (!ctx.scope.has(token.v)) throw new TypeError(`expression has no ${token.v}`);
    return dots(ctx.scope.get(token.v));
  }
  // The unused branch is not evaluated. Last(Local.commits) is empty on the first task.
  function skipExpression(): void {
    let depth = 0;
    let started = false;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === undefined) break;
      if (token.k === "op" && token.v === "(") {
        depth += 1;
        started = true;
        i += 1;
        continue;
      }
      if (token.k === "op" && token.v === ")") {
        if (depth === 0) return;
        depth -= 1;
        started = true;
        i += 1;
        continue;
      }
      if (token.k === "op" && token.v === "," && depth === 0) return;
      started = true;
      i += 1;
    }
    if (!started) throw new TypeError("expression ended early");
  }
  function ifValue(): unknown {
    expectOp("(");
    const cond = comparison();
    if (typeof cond !== "boolean") throw new TypeError("If condition must be a boolean");
    expectOp(",");
    if (cond) {
      const chosen = comparison();
      expectOp(",");
      skipExpression();
      expectOp(")");
      return chosen;
    }
    skipExpression();
    expectOp(",");
    const chosen = comparison();
    expectOp(")");
    return chosen;
  }
  function sum(): unknown {
    let left = postfix();
    while (peek("+") || peek("-")) {
      const op = take();
      const right = postfix();
      if (op.k !== "op" || typeof left !== "number" || typeof right !== "number") throw new TypeError("expression arithmetic needs numbers");
      left = op.v === "+" ? left + right : left - right;
    }
    return left;
  }
  function comparison(): unknown {
    const left = sum();
    if (!peek("=") && !peek("<") && !peek(">")) return left;
    const op = take();
    const right = sum();
    if (op.k !== "op") throw new TypeError("expression comparison needs an operator");
    if (op.v === "=") return left === right;
    if (typeof left !== "number" || typeof right !== "number") throw new TypeError("expression comparison needs numbers");
    return op.v === "<" ? left < right : left > right;
  }
  const value = comparison();
  if (i !== tokens.length) throw new TypeError("expression has trailing input");
  return value;
}

function resolve(value: unknown, ctx: EvalContext): unknown {
  if (typeof value === "string" && value.startsWith("=")) return evaluate(value.slice(1), ctx);
  if (Array.isArray(value)) return value.map((item) => resolve(item, ctx));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = resolve(value[key], ctx);
    return out;
  }
  return value;
}

export async function executeDeclarative(options: {
  readonly workflow: DeclarativeWorkflow;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly tools: Readonly<Record<string, DeclarativeTool>>;
  readonly onFailure?: (reason: string) => Promise<void>;
  readonly limit?: number;
}): Promise<DeclarativeReport> {
  for (const key of Object.keys(options.workflow.inputs)) {
    if (!Object.hasOwn(options.inputs, key)) throw new TypeError(`workflow input ${key} is missing`);
  }
  const calls: DeclarativeCall[] = [];
  const local: Record<string, unknown> = {};
  let scope = new Map<string, unknown>();
  const limit = options.limit ?? STEP_LIMIT;
  let steps = 0;
  const ctx = (): EvalContext => ({ inputs: options.inputs, local, scope });
  const run = async (actions: readonly DeclarativeAction[]): Promise<"end" | "ok"> => {
    for (const action of actions) {
      steps += 1;
      if (steps > limit) throw new Error("workflow exceeded its step budget");
      if (action.kind === "EndWorkflow") return "end";
      if (action.kind === "SetVariable") {
        local[action.variable] = resolve(action.value, ctx());
        continue;
      }
      if (action.kind === "AppendValue") {
        const current = local[action.variable];
        if (current !== undefined && !Array.isArray(current)) throw new TypeError(`Local.${action.variable} is not an array`);
        const list = Array.isArray(current) ? [...current] : [];
        list.push(resolve(action.value, ctx()));
        local[action.variable] = list;
        continue;
      }
      if (action.kind === "If") {
        const cond = evaluate(action.condition, ctx());
        if (typeof cond !== "boolean") throw new TypeError("If condition must be a boolean");
        const nested = cond ? action.then : action.else;
        if (nested.length > 0 && (await run(nested)) === "end") return "end";
        continue;
      }
      if (action.kind === "Foreach") {
        const list = evaluate(action.source, ctx());
        if (!Array.isArray(list)) throw new TypeError("Foreach source must be an array");
        for (let index = 0; index < list.length; index += 1) {
          const saved = scope;
          scope = new Map(saved);
          scope.set(action.itemName, list[index]);
          scope.set(action.indexName, index);
          const signal = await run(action.actions);
          scope = saved;
          if (signal === "end") return "end";
        }
        continue;
      }
      const tool = options.tools[action.functionName];
      if (tool === undefined) throw new Error(`no tool ${action.functionName}`);
      const args = resolve(action.arguments, ctx());
      if (!isRecord(args)) throw new TypeError("arguments must be an object");
      calls.push({ name: action.functionName, arguments: args });
      const result = await tool(args);
      if (action.output !== undefined) local[action.output] = result;
    }
    return "ok";
  };
  try {
    await run(options.workflow.actions);
    return { status: "done", calls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.onFailure !== undefined) {
      try {
        await options.onFailure(reason);
      } catch (cleanup) {
        const extra = cleanup instanceof Error ? cleanup.message : String(cleanup);
        return { status: "halted", reason: `${reason}; ${extra}`, calls };
      }
    }
    return { status: "halted", reason, calls };
  }
}
