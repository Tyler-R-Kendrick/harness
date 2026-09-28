import { describe, expect, it } from "vitest";
import { builtinGrammar, currencyOf, dateOf, DocumentError, numberOf, phoneOf, timeOf, wordsOf } from "@harness/dialogue-standards";

const table = <T>(f: (x: string) => T, cases: readonly (readonly [string, T])[]) => expect(cases.map(([input]) => [input, f(input)])).toEqual(cases);

describe("builtin grammar types", () => {
  it("BT1.1 numbers in numerals or words, with scales, decimals and signs", () => {
    table((u) => numberOf(wordsOf(u)), [
      ["42", 42],
      ["3.5", 3.5],
      ["1,234", 1234],
      ["1,234.5", 1234.5],
      ["zero", 0],
      ["twenty five", 25],
      ["one hundred and three", 103],
      ["a hundred", 100],
      ["five hundred thousand", 500000],
      ["one thousand two hundred", 1200],
      ["twenty one thousand", 21000],
      ["two million", 2000000],
      ["minus five", -5],
      ["negative ten", -10],
      ["three point one four", 3.14],
      ["two point five", 2.5],
      ["", undefined],
      ["hundred", undefined],
      ["thousand", undefined],
      ["one one", undefined],
      ["ten five", undefined],
      ["twenty ten", undefined],
      ["twenty zero", undefined],
      ["twenty hundred", undefined],
      ["twenty thirty", undefined],
      ["five and", undefined],
      ["minus", undefined],
      ["three point", undefined],
      ["point five", undefined],
      ["three point x", undefined],
      ["banana", undefined],
      ["a a", undefined],
      ["one thousand thousand", undefined],
    ]);
  });

  it("BT1.2 dates as yyyymmdd, ???? for a year not said", () => {
    table(dateOf, [
      ["2024-03-05", "20240305"],
      ["03/05/2024", "20240305"],
      ["3/5", "????0305"],
      ["March 5, 2024", "20240305"],
      ["march 5th", "????0305"],
      ["the fifth of March", "????0305"],
      ["5 March 2024", "20240305"],
      ["twenty first of september", "????0921"],
      ["sept 30", "????0930"],
      ["Feb 29 2024", "20240229"],
      ["Feb 29 2023", undefined],
      ["Feb 29", "????0229"],
      ["February 30", undefined],
      ["April 31", undefined],
      ["2024-13-01", undefined],
      ["March 0", undefined],
      ["March 5 24", undefined],
      ["March 5 999", undefined],
      ["5 March 24", undefined],
      ["5 March 2024 extra", undefined],
      ["next tuesday", undefined],
      ["ma 5", undefined],
      ["thirty second of may", undefined],
      ["1900-02-29", undefined],
      ["2000-02-29", "20000229"],
    ]);
  });

  it("BT1.3 times as hhmm and a, p, h (24 hour) or ? (not said)", () => {
    table(timeOf, [
      ["7pm", "0700p"],
      ["7:30 am", "0730a"],
      ["7:30 a.m.", "0730a"],
      ["11 p. m.", "1100p"],
      ["7:30", "0730?"],
      ["07:30", "0730h"],
      ["19:30", "1930h"],
      ["0:15", "0015h"],
      ["noon", "1200p"],
      ["midday", "1200p"],
      ["midnight", "1200a"],
      ["seven o'clock", "0700?"],
      ["seven thirty pm", "0730p"],
      ["seven oh five", "0705?"],
      ["seven oh fifteen", undefined],
      ["nine", "0900?"],
      ["25:00", undefined],
      ["7:75", undefined],
      ["13pm", undefined],
      ["banana", undefined],
      ["twelve fifteen am", "1215a"],
    ]);
  });

  it("BT1.4 currency as its ISO code and the amount to the cent", () => {
    table(currencyOf, [
      ["$12.50", "USD12.50"],
      ["€3", "EUR3.00"],
      ["£1,200", "GBP1200.00"],
      ["20 euros", "EUR20.00"],
      ["twelve dollars and fifty cents", "USD12.50"],
      ["12 dollars 50", "USD12.50"],
      ["one pound twenty pence", "GBP1.20"],
      ["5 yen", "JPY5.00"],
      ["20", "20.00"],
      ["dollars", undefined],
      ["12 dollars 500", undefined],
      ["12 dollars and 100 cents", undefined],
      ["some dollars", undefined],
      ["minus 5", undefined],
    ]);
  });

  it("BT1.5 phone numbers as digits, with x and the extension", () => {
    table(phoneOf, [
      ["+1 (555) 123-4567", "15551234567"],
      ["555 1234 extension 22", "5551234x22"],
      ["555-1234 ext. 9", "5551234x9"],
      ["5551234x7", "5551234x7"],
      ["five five five one two one two", "5551212"],
      ["12", undefined],
      ["call six", undefined],
      ["555 1234 ext nine x 2", undefined],
      ["555 1234 extension banana", undefined],
    ]);
  });

  it("BT1.6 builtin grammars match the whole utterance: booleans, digits with their lengths, and numbers (a string, as the specification has it)", () => {
    const b = builtinGrammar("boolean");
    table((u) => b(u)?.value, [
      ["Yes please", true],
      ["that's right", true],
      ["1", true],
      ["no thanks", false],
      ["2", false],
      ["maybe", undefined],
    ]);
    const d = builtinGrammar("builtin:grammar/digits?minlength=3;maxlength=4");
    table((u) => d(u)?.value, [
      ["1 2 3", "123"],
      ["one two three four", "1234"],
      ["12", undefined],
      ["12345", undefined],
      ["one banana", undefined],
    ]);
    expect(builtinGrammar("digits?length=2")("42")).toEqual({ value: "42", text: "42" });
    expect(builtinGrammar("digits?length=2")("421")).toBeUndefined();
    const n = builtinGrammar("builtin:voice/number");
    table((u) => n(u)?.value, [
      ["-12.5", "-12.5"],
      ["1,000", "1000"],
      ["forty two", "42"],
      ["lots", undefined],
    ]);
    for (const type of ["date", "time", "currency", "phone"]) expect(builtinGrammar(`builtin:dtmf/${type}`)("nonsense words")).toBeUndefined();
    expect(builtinGrammar("date")("march 5")).toEqual({ value: "????0305", text: "march 5" });
    expect(builtinGrammar("time")("7pm")).toMatchObject({ value: "0700p" });
    expect(builtinGrammar("currency")("$3")).toMatchObject({ value: "USD3.00" });
    expect(builtinGrammar("phone")("555 1212")).toMatchObject({ value: "5551212" });
    expect(() => builtinGrammar("colour")).toThrow(DocumentError);
    expect(() => builtinGrammar("builtin:grammar/")).toThrow("is not a builtin grammar type");
  });

  it("BT1.7 \"and\" joins a scale to what follows it, as it does a hundred", () => {
    expect(numberOf(["two", "thousand", "and", "five"])).toBe(2005);
    expect(numberOf(["one", "million", "and", "twenty"])).toBe(1_000_020);
    expect(numberOf(["and", "five"])).toBeUndefined();
    expect(numberOf(["five", "and"])).toBeUndefined();
  });

  it("BT1.8 times and phone numbers are read in time linear in the text", () => {
    const spaces = " ".repeat(50_000);
    const started = performance.now();
    expect(timeOf(`7${spaces}x`)).toBeUndefined();
    expect(timeOf(`seven thirty${spaces}pm`)).toBe("0730p");
    expect(phoneOf(`555 1234${spaces}extension${spaces}12`)).toBe("5551234x12");
    expect(phoneOf(`555${spaces}x`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("builtin grammar types at their edges", () => {
  const UNIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const TEN_WORDS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

  it("BT2.1 every unit and every ten is a number word", () => {
    table((u) => numberOf(wordsOf(u)), [...UNIT_WORDS.map((w, i) => [w, i] as const), ...TEN_WORDS.map((w, i) => [w, (i + 2) * 10] as const)]);
  });

  it("BT2.2 a numeral is a whole token: digits in groups of three after the first one to three, and any decimals", () => {
    table((u) => numberOf([u]), [
      ["12,345", 12345],
      ["1,234,567", 1234567],
      ["1,234.56", 1234.56],
      ["-1,234", -1234],
      ["3.25", 3.25],
      ["x1,234", undefined],
      ["1,234x", undefined],
      ["1234,567", undefined],
      ["x12", undefined],
      ["12x", undefined],
    ]);
  });

  it("BT2.3 the decimals after \"point\" are digit words or numerals, and nothing else", () => {
    table((u) => numberOf(wordsOf(u)), [
      ["3 point 25", 3.25],
      ["three point oh five", 3.05],
      ["three point o one", 3.01],
      ["three point x5", undefined],
      ["three point 5x", undefined],
    ]);
  });

  it("BT2.4 \"a\" starts a number, and \"hundred\" follows a single unit only", () => {
    table((u) => numberOf(wordsOf(u)), [
      ["one thousand a hundred", 1100],
      ["one hundred a", undefined],
      ["one twenty", undefined],
      ["nine hundred", 900],
      ["ten hundred", undefined],
      ["fifteen hundred", undefined],
      ["zero hundred hundred", undefined],
    ]);
  });

  it("BT2.5 every month is recognised by name or by three letters or more", () => {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    table(dateOf, months.map((m, i) => [`${m} 5`, `????${String(i + 1).padStart(2, "0")}05`] as const));
    table(dateOf, [
      ["jan 5", "????0105"],
      ["dec 5", "????1205"],
    ]);
  });

  it("BT2.6 a day is a numeral with an optional ordinal suffix, ordinal words (a ten and an ordinal at most) or a number", () => {
    table(dateOf, [
      ["march 15th", "????0315"],
      ["march 2nd", "????0302"],
      ["march twenty five", "????0325"],
      ["march twenty first 2024", "20240321"],
      ["march a5", undefined],
      ["march 5x", undefined],
      ["one twenty first march", undefined],
      ["march banana thirtieth", undefined],
      // A four-digit word after the month is a year (and 0012 is none), not a day.
      ["march 0012", undefined],
      ["march 2024", "202403??"],
      ["march 0999", undefined],
      ["march 1000", "100003??"],
    ]);
  });

  it("BT2.7 months run 1 to 12, days 1 to the month's length, and a year has four digits from 1000", () => {
    table(dateOf, [
      ["2024-01-05", "20240105"],
      ["2024-00-05", undefined],
      ["2024-12-05", "20241205"],
      ["2024-03-01", "20240301"],
      ["2024-01-31", "20240131"],
      ["2024-01-32", undefined],
      ["2024-04-30", "20240430"],
      ["2024-06-31", undefined],
      ["2024-09-31", undefined],
      ["2024-11-31", undefined],
      ["2024-12-31", "20241231"],
      ["0999-01-01", undefined],
      ["1000-01-01", "10000101"],
      ["9999-12-31", "99991231"],
    ]);
  });

  it("BT2.8 a date's numerals and year are whole tokens, and the text around them is trimmed", () => {
    table(dateOf, [
      [" 2024-03-05 ", "20240305"],
      ["x2024-03-05", undefined],
      ["2024-03-05x", undefined],
      ["x3/5", undefined],
      ["3/5x", undefined],
      ["3/5/2024x", undefined],
      ["5 march tuesday", undefined],
      ["5 march x2024", undefined],
      ["5 march 2024x", undefined],
    ]);
  });

  it("BT2.9 a time's a.m., p.m. and o'clock are read however they are dotted and spaced", () => {
    table(timeOf, [
      [" noon", "1200p"],
      ["noon o'clock", "1200p"],
      ["7 a. m.", "0700a"],
      ["7 a.m", "0700a"],
      ["7 p.m.", "0700p"],
      ["7 p.m", "0700p"],
      ["seven oclock", "0700?"],
      ["seven o' clock", "0700?"],
      ["x7:30", undefined],
      ["seven pm thirty", undefined],
    ]);
  });

  it("BT2.10 hours and minutes keep to their ranges: minutes to 59, 12 hours said, or 24 with an h", () => {
    table(timeOf, [
      ["12:30", "1230?"],
      ["13", "1300h"],
      ["1:30", "0130?"],
      ["7:59", "0759?"],
      ["7:60", undefined],
      ["23:00", "2300h"],
      ["24:00", undefined],
      ["zero thirty", undefined],
      ["seven o five", "0705?"],
      ["seven o fifteen", undefined],
      ["seven oh nine", "0709?"],
      ["seven fifteen", "0715?"],
    ]);
  });

  it("BT2.11 every currency symbol, name and code gives its ISO code", () => {
    table(currencyOf, [
      ["$5", "USD5.00"],
      ["€5", "EUR5.00"],
      ["£5", "GBP5.00"],
      ["¥5", "JPY5.00"],
      ...["dollar", "dollars", "usd"].map((w) => [`5 ${w}`, "USD5.00"] as const),
      ...["euro", "euros", "eur"].map((w) => [`5 ${w}`, "EUR5.00"] as const),
      ...["pound", "pounds", "gbp"].map((w) => [`5 ${w}`, "GBP5.00"] as const),
      ...["yen", "jpy"].map((w) => [`5 ${w}`, "JPY5.00"] as const),
    ]);
  });

  it("BT2.12 an amount is a whole token, not negative, with cents from 0 to 99 said after the currency", () => {
    table(currencyOf, [
      [" $5", "USD5.00"],
      ["x$5", undefined],
      ["$5x", undefined],
      ["$0", "USD0.00"],
      ["one dollar and one cent", "USD1.01"],
      ["one dollar twenty five cents", "USD1.25"],
      ["one dollar ninety nine cents", "USD1.99"],
      ["12 dollars 5", "USD12.05"],
      ["12 dollars 5 0", undefined],
      ["dollars 50", undefined],
      ["dollar fifty cents", undefined],
      ["one dollar banana cents", undefined],
    ]);
  });

  it("BT2.13 phone numbers: a leading plus, ext with or without a dot and space, one extension, three digits at least", () => {
    table(phoneOf, [
      [" +1 555 1234", "15551234"],
      ["555+1234", undefined],
      ["555 1234 ext 9", "5551234x9"],
      ["555 1234 ext9", "5551234x9"],
      ["555 1234 ext 1 ext 2", undefined],
      ["555", "555"],
      ["five five five oh o one", "555001"],
    ]);
  });

  it("BT2.14 digits are numerals or the digit words zero to nine, oh and o; nothing is not digits", () => {
    const d = builtinGrammar("digits");
    table((u) => d(u)?.value, [
      ["oh o nine", "009"],
      ["12 34", "1234"],
      ["ten", undefined],
      ["a1", undefined],
      ["1a", undefined],
      ["", undefined],
      [" , ", undefined],
      ...UNIT_WORDS.slice(0, 10).map((w, i) => [w, String(i)] as const),
    ]);
    table((u) => builtinGrammar(u)("12")?.value, [
      ["digits?minlength=2", "12"],
      ["digits?minlength=3", undefined],
      ["digits?maxlength=2", "12"],
      ["digits?maxlength=1", undefined],
      ["digits?length=2;", "12"],
    ]);
  });

  it("BT2.15 every yes and every no a boolean grammar knows", () => {
    const b = builtinGrammar("boolean");
    const yes = ["yes", "yeah", "yep", "yup", "sure", "correct", "right", "true", "affirmative", "ok", "okay", "of course", "yes please", "that's right", "that is right", "absolutely", "certainly", "1"];
    const no = ["no", "nope", "nah", "false", "negative", "incorrect", "wrong", "no thanks", "no thank you", "not really", "absolutely not", "2"];
    table((u) => b(u)?.value, [...yes.map((w) => [w, true] as const), ...no.map((w) => [w, false] as const)]);
  });

  it("BT2.16 a number grammar reads trimmed numerals, with commas only in groups of three as numberOf reads them, and words otherwise", () => {
    const n = builtinGrammar("number");
    table((u) => n(u)?.value, [
      [" -12.5", "-12.5"],
      ["1234,567", undefined],
      ["1,234,567.25", "1234567.25"],
      ["007", "7"],
      ["x12", undefined],
      ["12x", undefined],
    ]);
  });

  it("BT2.17 a grammar spec is trimmed and whole, and an unknown type is refused naming the types", () => {
    expect(builtinGrammar(" boolean ")("yes")?.value).toBe(true);
    expect(builtinGrammar("builtin:boolean")("no")?.value).toBe(false);
    expect(() => builtinGrammar("1boolean")).toThrow(DocumentError);
    expect(() => builtinGrammar("boolean!")).toThrow(DocumentError);
    expect(() => builtinGrammar("colour")).toThrow(new DocumentError("colour is not a builtin grammar type (boolean, digits, number, date, time, currency, phone)"));
  });

  it("BT2.18 an \"and\" must join a number to what follows it, and a day is a whole number", () => {
    expect(numberOf(["one", "hundred", "and"])).toBeUndefined();
    expect(numberOf(["two", "thousand", "and", "and", "five"])).toBeUndefined();
    expect(numberOf(["one", "hundred", "and", "five"])).toBe(105);
    expect(dateOf("march 5.5")).toBeUndefined();
    expect(dateOf("march 5")).toBe("????0305");
  });
});
