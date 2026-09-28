import { wordsOf } from "./srgs.ts";
import type { GrammarMatch } from "./srgs.ts";
import { DocumentError } from "./xml.ts";

/**
 * VoiceXML 2.1's builtin grammar types (appendix P), for text: `boolean`, `digits`,
 * `number`, `date`, `time`, `currency` and `phone`, each accepting the whole utterance
 * and returning the value the specification gives (a date as `yyyymmdd`, a time as
 * `hhmm` and a/p/h/?, a currency as its ISO code and amount).
 */

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS: ReadonlyMap<string, number> = new Map(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map((w, i) => [w, (i + 2) * 10]));
const SCALES: Readonly<Record<string, number>> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const ORDINALS: Readonly<Record<string, number>> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const DIGIT_WORDS: Readonly<Record<string, string>> = { oh: "0", o: "0", ...Object.fromEntries(UNITS.slice(0, 10).map((w, i) => [w, String(i)])) };

/** A numeral: digits, grouped by commas in threes or not, with a sign and decimals. */
const NUMERAL = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;

/** A whole number (or a decimal, with "point") said in words or numerals; undefined when the words are not one. */
export function numberOf(words: readonly string[]): number | undefined {
  if (words.length === 0) return undefined;
  const [first, ...rest] = words;
  if (first === "minus" || first === "negative") {
    const n = numberOf(rest);
    return n === undefined ? undefined : -n;
  }
  if (words.length === 1 && NUMERAL.test(first!)) return Number(first!.replace(/,/g, ""));
  const point = words.indexOf("point");
  if (point >= 0) {
    const whole = numberOf(words.slice(0, point));
    const decimals = words.slice(point + 1).map((w) => DIGIT_WORDS[w] ?? (/^\d+$/.test(w) ? w : undefined));
    if (whole === undefined || decimals.length === 0 || decimals.includes(undefined)) return undefined;
    return Number(`${whole}.${decimals.join("")}`);
  }
  let total = 0;
  let group: number | undefined;
  let last: "unit" | "ten" | "hundred" | "scale" | undefined;
  // An "and" joins what follows it: one that ends the number, or follows another, joins nothing.
  let joined = false;
  for (const w of words) {
    const unit = UNITS.indexOf(w);
    const ten = TENS.get(w);
    // "a hundred and five", "two thousand and five".
    if (w === "and" && !joined && (last === "hundred" || last === "scale")) {
      joined = true;
      continue;
    }
    joined = false;
    // With no group, the word before (if any) was a scale: "a" can start the next one.
    if (w === "a" && group === undefined) {
      group = 1;
      last = "unit";
    } else if (unit >= 0 && last !== "unit" && !(last === "ten" && unit >= 10) && !(last === "ten" && unit === 0)) {
      group = (group ?? 0) + unit;
      last = "unit";
    } else if (ten !== undefined && last !== "unit" && last !== "ten") {
      group = (group ?? 0) + ten;
      last = "ten";
    } else if (w === "hundred" && group !== undefined && group < 10 && last === "unit") {
      group *= 100;
      last = "hundred";
    } else if (SCALES[w] !== undefined && group !== undefined) {
      total += group * SCALES[w]!;
      group = undefined;
      last = "scale";
    } else {
      return undefined;
    }
  }
  if (joined) return undefined;
  // Every word read a unit, a ten, a hundred or a scale, so there is a number.
  return total + (group ?? 0);
}

/** A day of the month said as a number, an ordinal numeral (5th) or ordinal words (twenty first). */
function dayOf(words: readonly string[]): number | undefined {
  if (words.length === 1 && /^\d{1,2}(?:st|nd|rd|th)?$/.test(words[0]!)) return Number.parseInt(words[0]!, 10);
  const last = words[words.length - 1];
  if (last !== undefined && ORDINALS[last] !== undefined) {
    const tens = words.length === 2 ? TENS.get(words[0]!) : words.length === 1 ? 0 : undefined;
    return tens === undefined ? undefined : tens + ORDINALS[last]!;
  }
  return numberOf(words);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthOf = (w: string): number | undefined => {
  // A month is its name or the first three letters of it, or more.
  const i = MONTHS.findIndex((m) => w.length >= 3 && m.startsWith(w));
  return i < 0 ? undefined : i + 1;
};

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const daysIn = (month: number, year: number | undefined) => (month === 2 ? (year === undefined || (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31);

/** A date as VoiceXML returns it: yyyymmdd, with ???? for a year not said and ?? for a day not said (a month and a year). */
export function dateOf(text: string): string | undefined {
  // A year is always four digits (0999 is none), a day a whole number ("march 5.5" is no date).
  const date = (year: number | undefined, month: number | undefined, day: number | undefined): string | undefined => {
    if (month === undefined || day === undefined || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > daysIn(month, year)) return undefined;
    if (year !== undefined && year < 1000) return undefined;
    return `${year === undefined ? "????" : pad(year, 4)}${pad(month, 2)}${pad(day, 2)}`;
  };
  const trimmed = text.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (m) return date(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(trimmed);
  if (m) return date(m[3] === undefined ? undefined : Number(m[3]), Number(m[1]), Number(m[2]));
  const words = wordsOf(trimmed).filter((w) => w !== "the" && w !== "of");
  const at = words.findIndex((w) => monthOf(w) !== undefined);
  if (at < 0) return undefined;
  const month = monthOf(words[at]!);
  const before = words.slice(0, at);
  const after = words.slice(at + 1);
  const year = (ws: readonly string[]) => (ws.length === 1 && /^\d{4}$/.test(ws[0]!) ? Number(ws[0]) : undefined);
  if (before.length === 0) {
    // A month and a year: its day is not said.
    const alone = year(after);
    if (alone !== undefined) return alone < 1000 ? undefined : `${pad(alone, 4)}${pad(month!, 2)}??`;
    // Month first: March 5, March 5 2024, March fifth (a lone year was read above, so a year here follows a day).
    const y = year(after.slice(-1));
    return date(y, month, dayOf(y === undefined ? after : after.slice(0, -1)));
  }
  if (after.length > 1) return undefined;
  const y = after.length === 1 ? year(after) : undefined;
  return after.length === 1 && y === undefined ? undefined : date(y, month, dayOf(before));
}

/** A time as VoiceXML returns it: hhmm and a (am), p (pm), h (24 hour) or ? (not said). */
export function timeOf(text: string): string | undefined {
  const t = text.trim().toLowerCase().replace(/a\.\s?m\.?/g, "am").replace(/p\.\s?m\.?/g, "pm").replace(/o'?\s?clock/g, "").trim();
  if (t === "noon" || t === "midday") return "1200p";
  if (t === "midnight") return "1200a";
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  let hour: number | undefined;
  let minute: number | undefined;
  let suffix: string | undefined;
  if (m) {
    hour = Number(m[1]);
    minute = m[2] === undefined ? 0 : Number(m[2]);
    suffix = m[3];
    // 0 and 00 start with a zero, so they are 24-hour too.
    if (suffix === undefined && (hour > 12 || m[1]!.startsWith("0"))) suffix = "h";
  } else {
    // The suffix is found without a lazy group, so this is linear in the text.
    const said = /(?:^|\s)(am|pm)$/.exec(t);
    const words = wordsOf(said ? t.slice(0, said.index) : t);
    hour = numberOf(words.slice(0, 1));
    const rest = words.slice(1);
    minute = rest.length === 0 ? 0 : rest[0] === "oh" || rest[0] === "o" ? numberOf(rest.slice(1)) : numberOf(rest);
    if ((rest[0] === "oh" || rest[0] === "o") && minute !== undefined && minute > 9) return undefined;
    suffix = said?.[1];
  }
  if (hour === undefined || minute === undefined || !Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return undefined;
  if (suffix === "h") return hour > 23 ? undefined : `${pad(hour, 2)}${pad(minute, 2)}h`;
  if (hour < 1 || hour > 12) return undefined;
  return `${pad(hour, 2)}${pad(minute, 2)}${suffix === "am" ? "a" : suffix === "pm" ? "p" : "?"}`;
}

const CURRENCIES: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", dollar: "USD", dollars: "USD", usd: "USD", euro: "EUR", euros: "EUR", eur: "EUR", pound: "GBP", pounds: "GBP", gbp: "GBP", yen: "JPY", jpy: "JPY" };

/** An amount of money: its ISO 4217 code (when said) and the amount, to the cent. */
export function currencyOf(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  const amount = (code: string | undefined, n: number | undefined) => (n === undefined || n < 0 ? undefined : `${code ?? ""}${n.toFixed(2)}`);
  let m = /^([$€£¥])\s?(\d+(?:\.\d{1,2})?)$/.exec(t.replace(/,/g, ""));
  if (m) return amount(CURRENCIES[m[1]!], Number(m[2]));
  const words = wordsOf(t);
  const at = words.findIndex((w) => CURRENCIES[w] !== undefined);
  if (at < 0) return amount(undefined, numberOf(words));
  const code = CURRENCIES[words[at]!];
  const whole = numberOf(words.slice(0, at));
  const rest = words.slice(at + 1).filter((w) => w !== "and");
  if (rest.length === 0) return amount(code, whole);
  if (rest[rest.length - 1] !== "cents" && rest[rest.length - 1] !== "cent" && rest[rest.length - 1] !== "pence") {
    m = /^\d{1,2}$/.exec(rest.join(" "));
    return m && whole !== undefined ? amount(code, whole + Number(m[0]) / 100) : undefined;
  }
  const cents = numberOf(rest.slice(0, -1));
  return whole === undefined || cents === undefined || cents > 99 ? undefined : amount(code, whole + cents / 100);
}

/** A sequence of digits said as numerals or digit words; undefined for anything else. */
function digitsOf(text: string): string | undefined {
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[\s,.()-]+/).filter((x) => x !== "")) {
    if (/^\d+$/.test(w)) out.push(w);
    else if (DIGIT_WORDS[w] !== undefined) out.push(DIGIT_WORDS[w]!);
    else return undefined;
  }
  return out.length === 0 ? undefined : out.join("");
}

/** A phone number: its digits, and x and an extension's digits when said. */
export function phoneOf(text: string): string | undefined {
  // Split at the extension word alone (whitespace around it is dropped with the digits'), so this is linear in the text.
  const [number, extension, ...more] = text.toLowerCase().trim().replace(/^\+/, "").split(/\bextension\b|\bext\.?(?=\s|\d)|(?<=\d)x(?=\d)/);
  if (more.length > 0) return undefined;
  const digits = digitsOf(number!);
  if (digits === undefined || digits.length < 3) return undefined;
  if (extension === undefined) return digits;
  const ext = digitsOf(extension);
  return ext === undefined ? undefined : `${digits}x${ext}`;
}

const YES = new Set(["yes", "yeah", "yep", "yup", "sure", "correct", "right", "true", "affirmative", "ok", "okay", "of course", "yes please", "that's right", "that is right", "absolutely", "certainly", "1"]);
const NO = new Set(["no", "nope", "nah", "false", "negative", "incorrect", "wrong", "no thanks", "no thank you", "not really", "absolutely not", "2"]);

export const BUILTIN_TYPES = ["boolean", "digits", "number", "date", "time", "currency", "phone"] as const;
export type BuiltinType = (typeof BUILTIN_TYPES)[number];

/** A builtin grammar (`boolean`, `digits?minlength=3`, `builtin:grammar/number`, ...) as a matcher. */
export function builtinGrammar(spec: string): (utterance: string) => GrammarMatch | undefined {
  const m = /^(?:builtin:(?:(?:grammar|voice|dtmf)\/)?)?([a-z]+)(?:\?(.*))?$/.exec(spec.trim());
  const type = m?.[1];
  if (!m || !BUILTIN_TYPES.includes(type as BuiltinType)) throw new DocumentError(`${spec} is not a builtin grammar type (${BUILTIN_TYPES.join(", ")})`);
  // A parameter is name=value; one without a name is never read.
  const params = Object.fromEntries((m[2] ?? "").split(";").map((p) => p.split("=") as [string, string]));
  const length = (s: string) =>
    (params["length"] === undefined || s.length === Number(params["length"])) && (params["minlength"] === undefined || s.length >= Number(params["minlength"])) && (params["maxlength"] === undefined || s.length <= Number(params["maxlength"]));
  const match = (value: unknown, utterance: string): GrammarMatch | undefined => (value === undefined ? undefined : { value, text: wordsOf(utterance).join(" ") });
  switch (type as BuiltinType) {
    case "boolean":
      return (u) => {
        const said = wordsOf(u).join(" ");
        return match(YES.has(said) ? true : NO.has(said) ? false : undefined, u);
      };
    case "digits":
      return (u) => {
        const d = digitsOf(u);
        return match(d !== undefined && length(d) ? d : undefined, u);
      };
    case "number":
      // The value is a string of the number's digits, as the specification has it.
      return (u) => {
        // A numeral is read whole (its sign and point kept), with commas only in groups of three, as numberOf reads one.
        const numeral = u.trim();
        const n = NUMERAL.test(numeral) ? Number(numeral.replace(/,/g, "")) : numberOf(wordsOf(u));
        return match(n === undefined ? undefined : String(n), u);
      };
    case "date":
      return (u) => match(dateOf(u), u);
    case "time":
      return (u) => match(timeOf(u), u);
    case "currency":
      return (u) => match(currencyOf(u), u);
    case "phone":
      return (u) => match(phoneOf(u), u);
  }
}
