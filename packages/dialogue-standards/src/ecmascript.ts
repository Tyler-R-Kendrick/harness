import jsep from "jsep";
import type { Expression } from "jsep";
import jsepAssignment from "@jsep-plugin/assignment";
import jsepObject from "@jsep-plugin/object";

jsep.plugins.register(jsepAssignment, jsepObject);
jsep.addUnaryOp("typeof");

/**
 * The ECMAScript that dialogue standards embed (VoiceXML `cond` and `expr` attributes,
 * `<assign>`, SISR tags) is evaluated here, not by an engine: expressions and assignments
 * over JSON values, with a few pure built-ins. There are no loops, no user functions and
 * no prototypes, so an expression takes time in proportion to its size and can reach
 * nothing but the variables it is given. A value it makes or assigns is capped in size
 * (`MAX_LENGTH`: characters, elements and members, a shared part counted each time it
 * appears), so assignments repeated turn after turn cannot grow a value without bound.
 * jsep parses; this file evaluates.
 */

/** The largest value an expression may make or assign: characters of its strings and keys, and its elements and members, all told. */
export const MAX_LENGTH = 100_000;

/** A value's size as MAX_LENGTH counts it (a shared part as often as it appears), in time linear in its distinct parts. */
function sizeOf(v: Value, memo = new Map<object, number>()): number {
  if (typeof v === "string") return v.length;
  if (typeof v !== "object" || v === null || isBuiltin(v)) return 1;
  const known = memo.get(v);
  if (known !== undefined) return known;
  // A value inside itself (only a host could hand one in) is larger than anything.
  memo.set(v, Number.POSITIVE_INFINITY);
  let size = 1;
  for (const [k, x] of Object.entries(v)) size += k.length + sizeOf(x, memo);
  memo.set(v, size);
  return size;
}

/** A value an expression can produce: JSON, `undefined`, or a built-in function. */
export type Value = null | boolean | number | string | undefined | readonly Value[] | { readonly [key: string]: Value } | Builtin;

/** A function scripts may call: one of ours, never one they made. */
export interface Builtin {
  readonly builtin: (...args: Value[]) => Value;
}

export const builtin = (f: (...args: Value[]) => Value): Builtin => ({ builtin: f });
const isBuiltin = (v: unknown): v is Builtin => typeof v === "object" && v !== null && typeof (v as { builtin?: unknown }).builtin === "function";

/** Variables, innermost scope first. A scope is a plain object of names to values; assignments change it in place. */
export type Scopes = readonly Record<string, Value>[];

export class ScriptError extends Error {}

/** A value an expression made, refused when it is larger than `MAX_LENGTH`. */
function capped(v: Value): Value {
  if (sizeOf(v) > MAX_LENGTH) throw new ScriptError(`a value larger than ${MAX_LENGTH} is not supported`);
  return v;
}

const cache = new Map<string, Expression>();

/** An expression's parse (cached: documents evaluate the same attributes every turn). */
export function parse(source: string): Expression {
  let ast = cache.get(source);
  if (ast === undefined) {
    try {
      ast = jsep(source);
    } catch (e) {
      throw new ScriptError(`cannot parse ${JSON.stringify(source)}: ${(e as Error).message}`);
    }
    if (cache.size >= 4096) cache.clear();
    cache.set(source, ast);
  }
  return ast;
}

const plain = (v: unknown): v is Record<string, Value> => typeof v === "object" && v !== null && !Array.isArray(v) && !isBuiltin(v);
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

const STRING_METHODS = new Set(["toUpperCase", "toLowerCase", "trim", "substring", "substr", "slice", "indexOf", "lastIndexOf", "charAt", "split", "concat", "startsWith", "endsWith", "includes", "replace", "toString"]);
const ARRAY_METHODS = new Set(["join", "indexOf", "includes", "slice", "concat"]);
const primitive = (v: Value) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Globals every script sees, outermost. */
export const GLOBALS: Readonly<Record<string, Value>> = {
  undefined: undefined,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  Number: builtin((v) => Number(v)),
  String: builtin((v) => String(v)),
  Boolean: builtin((v) => Boolean(v)),
  parseInt: builtin((v, radix) => Number.parseInt(String(v), radix === undefined ? 10 : Number(radix))),
  parseFloat: builtin((v) => Number.parseFloat(String(v))),
  isNaN: builtin((v) => Number.isNaN(Number(v))),
  Math: Object.freeze({
    abs: builtin((v) => Math.abs(Number(v))),
    floor: builtin((v) => Math.floor(Number(v))),
    ceil: builtin((v) => Math.ceil(Number(v))),
    round: builtin((v) => Math.round(Number(v))),
    min: builtin((...v) => Math.min(...v.map(Number))),
    max: builtin((...v) => Math.max(...v.map(Number))),
  }),
};

/** Where a name is declared: the innermost scope that has it. */
function scopeOf(scopes: Scopes, name: string): Record<string, Value> | undefined {
  return scopes.find((s) => Object.hasOwn(s, name));
}

function member(object: Value, key: Value): Value {
  if (typeof key !== "string" && typeof key !== "number") return undefined;
  const k = String(key);
  if (FORBIDDEN.has(k)) throw new ScriptError(`no access to ${k}`);
  if ((typeof object === "string" || Array.isArray(object)) && k === "length") return object.length;
  if (Array.isArray(object)) return /^\d+$/.test(k) ? (object as Value[])[Number(k)] : undefined;
  if (typeof object === "string") return /^\d+$/.test(k) ? object[Number(k)] : undefined;
  if (plain(object)) return Object.hasOwn(object, k) ? object[k] : undefined;
  if (object === undefined || object === null) throw new ScriptError(`cannot read ${k} of ${String(object)}`);
  return undefined;
}

function binary(op: string, a: Value, b: Value): Value {
  // Values are JSON or undefined, as ECMAScript would treat them; built-ins are never operands.
  const x = a as never;
  const y = b as never;
  switch (op) {
    case "+":
      return capped((x as unknown as string) + (y as unknown as string));
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return x / y;
    case "%":
      return x % y;
    case "==":
      // Loose equality is the language's; scripts in the wild rely on it ("1" == 1).
      return x == y;
    case "!=":
      return x != y;
    case "===":
      return x === y;
    case "!==":
      return x !== y;
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    default:
      throw new ScriptError(`operator ${op} is not supported`);
  }
}

/** The value of an expression in scopes; anything that goes wrong is a ScriptError. */
export function evaluate(source: string, scopes: Scopes): Value {
  try {
    return run(parse(source), [...scopes, GLOBALS as Record<string, Value>]);
  } catch (e) {
    // A built-in can throw the language's own errors (a RangeError from toFixed, say).
    if (e instanceof ScriptError) throw e;
    throw new ScriptError(`${JSON.stringify(source)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Whether a condition holds, as ECMAScript's truthiness has it. */
export const holds = (source: string, scopes: Scopes): boolean => Boolean(evaluate(source, scopes));

/** Runs statements (expressions and assignments, separated by `;`) in scopes. */
export function execute(source: string, scopes: Scopes): void {
  evaluate(source, scopes);
}

function run(node: Expression, scopes: Scopes): Value {
  switch (node.type) {
    case "Literal":
      return node["value"] as Value;
    case "Identifier": {
      const name = node["name"] as string;
      const scope = scopeOf(scopes, name);
      if (!scope) throw new ScriptError(`${name} is not defined`);
      return scope[name];
    }
    case "ThisExpression":
      throw new ScriptError("this is not supported");
    case "Compound": {
      let last: Value;
      for (const e of node["body"] as Expression[]) last = run(e, scopes);
      return last;
    }
    case "ArrayExpression":
      return capped((node["elements"] as (Expression | null)[]).map((e) => (e === null ? undefined : run(e, scopes))));
    case "ObjectExpression": {
      const out: Record<string, Value> = {};
      for (const p of node["properties"] as Expression[]) {
        const key = p["computed"] ? run(p["key"] as Expression, scopes) : ((p["key"] as Expression)["name"] ?? (p["key"] as Expression)["value"]);
        if (FORBIDDEN.has(String(key))) throw new ScriptError(`no access to ${String(key)}`);
        // A shorthand property ({ n }) has its key as its value.
        out[String(key)] = run(p["value"] as Expression, scopes);
      }
      return capped(out);
    }
    case "MemberExpression": {
      const object = run(node["object"] as Expression, scopes);
      const property = node["property"] as Expression;
      return member(object, node["computed"] ? run(property, scopes) : (property["name"] as string));
    }
    case "UnaryExpression": {
      const argument = node["argument"] as Expression;
      // typeof of a name declared nowhere is "undefined", not an error.
      if (node["operator"] === "typeof" && argument.type === "Identifier" && !scopeOf(scopes, argument["name"] as string)) return "undefined";
      const v = run(argument, scopes) as never;
      switch (node["operator"]) {
        case "!":
          return !v;
        case "-":
          return -v;
        case "+":
          return +v;
        case "typeof":
          return typeof v;
        default:
          throw new ScriptError(`operator ${String(node["operator"])} is not supported`);
      }
    }
    case "BinaryExpression": {
      const op = node["operator"] as string;
      const left = run(node["left"] as Expression, scopes);
      if (op === "&&") return left ? run(node["right"] as Expression, scopes) : left;
      if (op === "||") return left ? left : run(node["right"] as Expression, scopes);
      return binary(op, left, run(node["right"] as Expression, scopes));
    }
    case "ConditionalExpression":
      return run(node["test"] as Expression, scopes) ? run(node["consequent"] as Expression, scopes) : run(node["alternate"] as Expression, scopes);
    case "CallExpression":
      return call(node, scopes);
    case "AssignmentExpression":
      return assign(node, scopes);
    default:
      throw new ScriptError(`${node.type} is not supported`);
  }
}

function call(node: Expression, scopes: Scopes): Value {
  const callee = node["callee"] as Expression;
  const args = (node["arguments"] as Expression[]).map((a) => run(a, scopes));
  if (callee.type === "MemberExpression" && !callee["computed"]) {
    const object = run(callee["object"] as Expression, scopes);
    const method = (callee["property"] as Expression)["name"] as string;
    if (typeof object === "string" && STRING_METHODS.has(method) && args.every(primitive)) return capped((String.prototype as unknown as Record<string, (...a: unknown[]) => Value>)[method]!.apply(object, args));
    if (Array.isArray(object) && ARRAY_METHODS.has(method) && args.every((a) => primitive(a) || Array.isArray(a))) return capped((Array.prototype as unknown as Record<string, (...a: unknown[]) => Value>)[method]!.apply(object, args));
    if (typeof object === "number" && method === "toFixed") return object.toFixed(Number(args[0] ?? 0));
    const f = member(object, method);
    if (isBuiltin(f)) return f.builtin(...args);
    throw new ScriptError(`${method} is not a function`);
  }
  const f = run(callee, scopes);
  if (!isBuiltin(f)) throw new ScriptError("not a function");
  return capped(f.builtin(...args));
}

function assign(node: Expression, scopes: Scopes): Value {
  const target = node["left"] as Expression;
  const op = node["operator"] as string;
  const value = (current: () => Value) => {
    const right = run(node["right"] as Expression, scopes);
    if (op === "=") return right;
    if (op === "+=") return binary("+", current(), right);
    if (op === "-=") return binary("-", current(), right);
    throw new ScriptError(`operator ${op} is not supported`);
  };
  if (target.type === "Identifier") {
    const name = target["name"] as string;
    const scope = scopeOf(scopes, name);
    if (!scope || scope === GLOBALS) throw new ScriptError(`${name} is not declared`);
    const v = capped(value(() => scope[name]));
    if (contains(v, scope)) throw new ScriptError(`cannot put ${name} inside itself`);
    return (scope[name] = v);
  }
  if (target.type === "MemberExpression") {
    const object = run(target["object"] as Expression, scopes);
    const property = target["property"] as Expression;
    const key = String(target["computed"] ? run(property, scopes) : property["name"]);
    if (FORBIDDEN.has(key)) throw new ScriptError(`no access to ${key}`);
    if (!plain(object) || Object.isFrozen(object)) throw new ScriptError(`cannot set ${key} here`);
    const v = value(() => member(object, key));
    // An object cannot be put inside itself: values stay JSON, which has no cycles.
    if (contains(v, object)) throw new ScriptError(`cannot put ${key} inside itself`);
    const into = object as Record<string, Value>;
    const had = Object.hasOwn(into, key);
    const old = into[key];
    into[key] = v;
    // The object grown past the cap is put back as it was.
    if (sizeOf(into) > MAX_LENGTH) {
      if (had) into[key] = old;
      else delete into[key];
      throw new ScriptError(`a value larger than ${MAX_LENGTH} is not supported`);
    }
    return v;
  }
  throw new ScriptError("cannot assign to this");
}

/** Whether `object` is `v` or is found inside it. */
function contains(v: Value, object: Value, seen = new Set<unknown>()): boolean {
  if (v === object) return true;
  if (typeof v !== "object" || v === null || isBuiltin(v) || seen.has(v)) return false;
  seen.add(v);
  return (Array.isArray(v) ? (v as Value[]) : Object.values(v)).some((x) => contains(x, object, seen));
}

/** A value as JSON: what state and results keep (`undefined` and built-ins dropped). */
export function toJson(v: Value): unknown {
  if (v === undefined || isBuiltin(v)) return undefined;
  // A value grown past the cap in place (a member assigned inside a member) is not kept.
  if (sizeOf(v) > MAX_LENGTH) throw new ScriptError(`a value larger than ${MAX_LENGTH} is not supported`);
  try {
    return JSON.parse(JSON.stringify(v) ?? "null");
  } catch (e) {
    throw new ScriptError(`not a JSON value: ${(e as Error).message}`);
  }
}
