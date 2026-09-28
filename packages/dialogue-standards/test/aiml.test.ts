import { describe, expect, it } from "vitest";
import { aimlInterpreter, aimlWords, compileAiml, DocumentError, formatDate, formatJavaDate, isAimlFile, splitSentences } from "@harness/dialogue-standards";
import type { StepResult } from "@harness/dialogue";

const aiml = (categories: string) => `<?xml version="1.0" encoding="UTF-8"?><aiml version="2.0">${categories}</aiml>`;
const cat = (pattern: string, template: string, extra = "") => `<category><pattern>${pattern}</pattern>${extra}<template>${template}</template></category>`;

/** A chat with a bot, a turn at a time, as its flow would have it. */
function chat(files: Record<string, string> | string, options: Record<string, string> = {}, now?: number) {
  const bot = aimlInterpreter.compile(typeof files === "string" ? { "bot.aiml": files } : files, options);
  let state: unknown = null;
  return {
    say(utterance: string): StepResult {
      const r = bot.step({ state: state as never, utterance, ...(now === undefined ? {} : { now }) });
      state = r.state;
      return r;
    },
    warnings: bot.warnings,
  };
}
const said = (r: StepResult) => r.say.join(" ");

describe("AIML: matching", () => {
  it("AM1.1 a category answers its pattern, whatever the case and punctuation; wildcards capture what they cover", () => {
    const c = chat(aiml(cat("HELLO", "Hi there!") + cat("MY NAME IS *", "Nice to meet you, <star/>.") + cat("I LIKE * AND *", "<star index=\"2\"/> and <star/>, then.")));
    expect(said(c.say("hello!"))).toBe("Hi there!");
    expect(said(c.say("My name is Ada Lovelace"))).toBe("Nice to meet you, ADA LOVELACE.");
    expect(said(c.say("i like tea and cake"))).toBe("CAKE and TEA, then.");
  });

  it("AM1.2 AIML 2.0's precedence: $word, #, _, word, set, ^, *", () => {
    const c = chat({
      "bot.aiml": aiml(
        cat("$WHO IS HERE", "priority") + cat("# IS HERE", "hash") + cat("_ IS THERE", "underscore") + cat("WHO IS THERE", "word") + cat("<set>color</set> IS NICE", "set <star/>") + cat("^ IS NICE", "caret") + cat("* IS GOOD", "star") + cat("WHO IS GOOD", "word good"),
      ),
      "color.set": JSON.stringify([["red"], ["light", "blue"]]),
    });
    expect(said(c.say("who is here"))).toBe("priority");
    expect(said(c.say("what is here"))).toBe("hash");
    expect(said(c.say("is here"))).toBe("hash");
    expect(said(c.say("who is there"))).toBe("underscore");
    expect(said(c.say("light blue is nice"))).toBe("set LIGHT BLUE");
    expect(said(c.say("green is nice"))).toBe("caret");
    expect(said(c.say("who is good"))).toBe("word good");
    expect(said(c.say("tea is good"))).toBe("star");
  });

  it("AM1.3 <that> matches the bot's last sentence, and <topic> the topic predicate", () => {
    const c = chat(
      aiml(
        cat("DO YOU LIKE MOVIES", "Yes. Do you?") +
          cat("YES", "Great, let's talk movies.<think><set name=\"topic\">movies</set></think>", "<that>DO YOU</that>") +
          cat("YES", "Yes what?") +
          `<topic name="MOVIES">${cat("*", "About movies: <star/>.")}</topic>`,
      ),
    );
    expect(said(c.say("yes"))).toBe("Yes what?");
    expect(said(c.say("do you like movies"))).toBe("Yes. Do you?");
    expect(said(c.say("yes"))).toBe("Great, let's talk movies.");
    expect(said(c.say("star wars"))).toBe("About movies: STAR WARS.");
  });

  it("AM1.4 each sentence is answered; <thatstar>, <that> and <input> read the conversation", () => {
    const c = chat(aiml(cat("HI", "Hello. What is your favourite colour?") + cat("I SAID *", "You said <input index=\"2\"/>; I said <that/>.") + cat("*", "<thatstar/>!", "<that>WHAT IS YOUR FAVOURITE *</that>")));
    expect(said(c.say("hi"))).toBe("Hello. What is your favourite colour?");
    expect(said(c.say("blue"))).toBe("COLOUR!");
    expect(said(c.say("I said hi. I said again"))).toBe("You said blue; I said COLOUR. You said I said hi; I said COLOUR.");
  });
});

describe("AIML: templates", () => {
  it("AM2.1 srai reduces to another category; sr is srai of the star; a loop of reductions stops", () => {
    const c = chat(aiml(cat("HELLO", "Hi!") + cat("HI THERE", "<srai>HELLO</srai>") + cat("PLEASE *", "<sr/>") + cat("LOOP", "<srai>LOOP</srai>x")));
    expect(said(c.say("hi there"))).toBe("Hi!");
    expect(said(c.say("please hello"))).toBe("Hi!");
    expect(said(c.say("loop"))).toBe("xxxxxxxxxxxxxxxxx");
  });

  it("AM2.2 predicates are set and got (unknown until set), locals live in their category, think says nothing", () => {
    const c = chat(aiml(cat("CALL ME *", "<think><set name=\"name\"><star/></set></think>OK.") + cat("WHO AM I", "You are <get name=\"name\"/>.") + cat("TEMP *", "<set var=\"t\"><star/></set> is <get var=\"t\"/>; <get var=\"u\"/>.")));
    expect(said(c.say("who am i"))).toBe("You are unknown.");
    expect(said(c.say("call me Ada"))).toBe("OK.");
    expect(said(c.say("who am i"))).toBe("You are ADA.");
    expect(said(c.say("temp x"))).toBe("X is X; unknown.");
  });

  it("AM2.3 conditions: one value, a list by value, a list by name, the * value, loops", () => {
    const c = chat(
      aiml(
        cat("SET *", "<think><set name=\"mood\"><star/></set></think>ok") +
          cat("ONE", "<condition name=\"mood\" value=\"happy\">Glad!</condition>") +
          cat("LIST", "<condition name=\"mood\"><li value=\"happy\">Glad.</li><li value=\"sad\">Sorry.</li><li>Hmm.</li></condition>") +
          cat("NAMES", "<condition><li name=\"mood\" value=\"sad\">Sad.</li><li name=\"mood\" value=\"*\">Some mood.</li><li>No mood.</li></condition>") +
          cat("COUNT", "<think><set name=\"n\">a</set></think><condition name=\"n\"><li value=\"aaa\">done</li><li><set name=\"n\"><get name=\"n\"/>a</set> <loop/></li></condition>"),
      ),
    );
    expect(said(c.say("names"))).toBe("No mood.");
    c.say("set happy");
    expect(said(c.say("one"))).toBe("Glad!");
    expect(said(c.say("list"))).toBe("Glad.");
    expect(said(c.say("names"))).toBe("Some mood.");
    c.say("set sad");
    expect(said(c.say("one"))).toBe("");
    expect(said(c.say("list"))).toBe("Sorry.");
    expect(said(c.say("names"))).toBe("Sad.");
    c.say("set bored");
    expect(said(c.say("list"))).toBe("Hmm.");
    expect(said(c.say("count"))).toBe("aa aaa done");
  });

  it("AM2.4 random picks deterministically from the state's seed, so a replay picks alike", () => {
    const bot = aiml(cat("PICK", "<random><li>A</li><li>B</li><li>C</li><li>D</li></random>"));
    const a = chat(bot);
    const b = chat(bot);
    const picks = Array.from({ length: 8 }, () => said(a.say("pick")));
    expect(Array.from({ length: 8 }, () => said(b.say("pick")))).toEqual(picks);
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  it("AM2.5 text transforms, bot properties, maps, substitutions, sizes and lists", () => {
    const c = chat({
      "bot.aiml": aiml(
        cat("T *", "<uppercase><star/></uppercase>|<lowercase>ABC</lowercase>|<formal>ada lovelace</formal>|<sentence>hello there</sentence>|<explode>ab c</explode>|<first>x y z</first>|<rest>x y z</rest>") +
          cat("WHO", "<bot name=\"name\"/> (<bot name=\"nope\"/>), <size/> categories, version <version/>, <program/>, <id/>") +
          cat("CAPITAL OF *", "<map name=\"capitals\"><star/></map>") +
          cat("SWAP *", "<person><star/></person>/<person2/>/<gender>he said</gender>/<normalize>it's</normalize>/<denormalize>it is</denormalize>") +
          cat("NOTHING", "<uppercase/>"),
      ),
      "bot.properties": JSON.stringify([["name", "Harness"]]),
      "maps/capitals.txt": "France:Paris\nItaly:Rome",
      "person.substitution": JSON.stringify([[" i ", " you "], [" my ", " your "]]),
      "person2.txt": "\"i\",\"he\"",
      "gender.substitution": JSON.stringify([[" he ", " she "]]),
      "normal.txt": "it's:it is",
      "denormal.txt": "it is:it's",
    });
    expect(said(c.say("t hi"))).toBe("HI|abc|Ada Lovelace|Hello there|a b c|x|y z");
    expect(said(c.say("who"))).toBe("Harness (unknown), 5 categories, version 2.0, harness, user");
    expect(said(c.say("capital of france"))).toBe("Paris");
    expect(said(c.say("capital of spain"))).toBe("unknown");
    expect(said(c.say("swap I love my cat"))).toBe("you LOVE your CAT/he LOVE MY CAT/she said/it is/it's");
  });

  it("AM2.6 dates come from the step's clock, in UTC, by strftime fields", () => {
    const at = Date.UTC(2024, 2, 5, 15, 4, 9);
    const c = chat(aiml(cat("DATE", "<date/>") + cat("FULL", '<date format="%A %a %b %e %m %y %H:%M:%S %I %p %% %Q"/>')), {}, at);
    expect(said(c.say("date"))).toBe("March 05, 2024");
    expect(said(c.say("full"))).toBe("Tuesday Tue Mar 5 03 24 15:04:09 03 PM % %Q");
    expect(formatDate(Date.UTC(1969, 11, 31, 0, 0, 0), "%Y-%m-%d %A %I %p")).toBe("1969-12-31 Wednesday 12 AM");
    expect(said(chat(aiml(cat("DATE", "<date/>"))).say("date"))).toBe("");
  });

  it("AM2.7 learn adds a category for this conversation, evaluating its evals now", () => {
    const c = chat(aiml(cat("REMEMBER * IS *", "<learn><category><pattern>WHAT IS <eval><star/></eval></pattern><template><eval><star index=\"2\"/></eval></template></category></learn>Noted.")));
    expect(said(c.say("remember sky is blue"))).toBe("Noted.");
    expect(said(c.say("what is sky"))).toBe("BLUE");
    const other = chat(aiml(cat("REMEMBER * IS *", "x")));
    expect(other.say("what is sky")).toMatchObject({ pass: true });
  });

  it("AM2.8 attributes may be written as elements, and elements it does not know are said as their text", () => {
    const c = chat(aiml(cat("SET IT", "<set><name>k</name>v</set>") + cat("GET IT", "<get><name>k</name></get> <b>bold</b><br/>x<oob><robot/></oob>")));
    c.say("set it");
    expect(said(c.say("get it"))).toBe("v bold x");
    expect(c.warnings).toEqual(["bot.aiml: <b> is not AIML; its text is said", "bot.aiml: <robot> is not AIML; its text is said"]);
  });
});

describe("AIML and the model", () => {
  it("AM3.1 a turn only the catch-all answers, or none, is the model's, and changes nothing; with fallback bot, the catch-all answers", () => {
    const bot = aiml(cat("HI", "Hello.") + cat("*", "<think><set name=\"x\">1</set></think>I have no answer."));
    const c = chat(bot);
    expect(c.say("what is the meaning of life")).toMatchObject({ say: [], pass: true, state: { predicates: {} } });
    expect(said(c.say("hi"))).toBe("Hello.");
    expect(said(chat(bot, { fallback: "bot" }).say("what now"))).toBe("I have no answer.");
    expect(chat(aiml(cat("HI", "Hello."))).say("bye")).toMatchObject({ pass: true });
    expect(chat(bot).say("...")).toMatchObject({ pass: true });
  });

  it("AM3.2 sraix (a question for another service) hands the turn to the model; system and javascript categories are dropped", () => {
    const c = chat(aiml(cat("ASK *", "<sraix><star/></sraix>") + cat("RUN", "<system>rm -rf /</system>") + cat("JS", "<javascript>1</javascript>") + cat("SKIP", "<gossip>x</gossip><interval/>ok")));
    expect(c.say("ask the weather")).toMatchObject({ pass: true });
    expect(c.say("run")).toMatchObject({ pass: true });
    expect(said(c.say("skip"))).toBe("ok");
    expect(c.warnings).toEqual([
      "bot.aiml: categories using <system> are dropped (it runs code on the host)",
      "bot.aiml: categories using <javascript> are dropped (it runs code on the host)",
      "bot.aiml: <gossip> is not supported and says nothing",
      "bot.aiml: <interval> is not supported and says nothing",
    ]);
  });
});

describe("AIML bots that cannot be run", () => {
  it("AM4.1 are refused, saying why", () => {
    const bad: [Record<string, string>, string][] = [
      [{ "a.txt": "x" }, "not an AIML bot file"],
      [{ "a.set": "[]" }, "no AIML file"],
      [{ "a.aiml": "<bot/>" }, "root is <aiml>"],
      [{ "a.aiml": aiml("<category><pattern>X</pattern></category>") }, "needs a <pattern> and a <template>"],
      [{ "a.aiml": aiml("<meta/>") }, "not a category or a topic"],
      [{ "a.aiml": aiml(cat("<get name='x'/>", "y")) }, "<get> is not allowed in a pattern"],
      [{ "a.aiml": aiml(cat("X", "y")), "a.map": "[1]" }, 'expected [["key", "value"]'],
      [{ "a.aiml": aiml(cat("X", "y")), "a.properties": "novalue" }, "expected key:value"],
      [{ "a.aiml": "<aiml" }, "a.aiml"],
    ];
    for (const [files, message] of bad) expect(() => aimlInterpreter.compile(files, {}), message).toThrow(message);
    expect(() => aimlInterpreter.compile({ "a.aiml": "<aiml" }, {})).toThrow(DocumentError);
  });
});

describe("AIML text", () => {
  it("AM5.1 words are upper case without punctuation; sentences split at . ! ? followed by whitespace or the end, so not in numbers or abbreviations", () => {
    expect(aimlWords("What's up, Doc?")).toEqual(["WHATS", "UP", "DOC"]);
    expect(splitSentences("Hi. It costs 3.50! Ok? Yes")).toEqual(["Hi", "It costs 3.50", "Ok", "Yes"]);
    expect(splitSentences("See www.example.com, e.g.this...  Done!!")).toEqual(["See www.example.com, e.g.this", "Done"]);
  });

  it("AM5.3 input is normalized by the bot's substitutions before it is split into sentences", () => {
    const c = chat({
      "bot.aiml": aiml(cat("HELLO MISTER SMITH", "Good day.") + cat("BYE", "Bye.")),
      "normal.substitution": JSON.stringify([[" mr. ", " mister "]]),
    });
    expect(said(c.say("Hello Mr. Smith. Bye."))).toBe("Good day. Bye.");
  });

  it("AM5.2 sets and maps in Program AB's text, properties in either form, and bot properties in patterns", () => {
    const c = chat({
      "bot.aiml": aiml(cat("I AM <bot name=\"name\"/>", "Me too.") + cat("<set>animal</set>", "An animal: <star/>.") + cat("<set>number</set> PLEASE", "Number <star/>.")),
      "sets/animal.txt": "# animals\ncat\nbig dog\n",
      "properties.txt": "name:Robo",
    });
    expect(said(c.say("i am robo"))).toBe("Me too.");
    expect(said(c.say("big dog"))).toBe("An animal: BIG DOG.");
    expect(said(c.say("42 please"))).toBe("Number 42.");
  });
});

describe("AIML within bounds", () => {
  it("AM6.1 reductions that multiply stop at the turn's budget: the turn ends, it does not run away", () => {
    // Each level reduces to the next twice, ten levels deep (within the depth limit): 2^10 leaves if nothing stopped them.
    const levels = Array.from({ length: 10 }, (_, i) => cat(`L${i}`, `<srai>L${i + 1}</srai><srai>L${i + 1}</srai>`)).join("");
    const c = chat(aiml(levels + cat("L10", "x") + cat("GO", "<srai>L0</srai>")));
    const started = performance.now();
    const leaves = (said(c.say("go")).match(/x/g) ?? []).length;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(leaves).toBeGreaterThan(0);
    expect(leaves).toBeLessThan(2 ** 10);
  });

  it("AM6.2 a learned category takes its place in the bot's precedence: a learned wildcard does not beat the bot's words", () => {
    const c = chat(aiml(cat("WHAT IS TEA", "A drink.") + cat("TEACH", "<learn><category><pattern>WHAT IS *</pattern><template>No idea.</template></category><category><pattern>WHAT IS COCOA</pattern><template>Also a drink.</template></category></learn>Ok.")));
    c.say("teach");
    expect(said(c.say("what is tea"))).toBe("A drink.");
    expect(said(c.say("what is cocoa"))).toBe("Also a drink.");
    expect(said(c.say("what is gravel"))).toBe("No idea.");
  });

  it("AM6.3 predicates and locals are the bot's own: none is found on a prototype", () => {
    const c = chat(aiml(cat("ASK", "<get name=\"constructor\"/> <get var=\"toString\"/> <condition name=\"__proto__\"><li value=\"*\">set</li><li>unset</li></condition>") + cat("SET", "<set name=\"constructor\">mine</set>")));
    expect(said(c.say("ask"))).toBe("unknown unknown unset");
    c.say("set");
    expect(said(c.say("ask"))).toBe("mine unknown unset");
  });
});

/** Why a bot's files are refused: a DocumentError's message (any other error fails the test). */
function refusal(files: Record<string, string>): string {
  try {
    compileAiml(files);
  } catch (e) {
    if (e instanceof DocumentError) return e.message;
    throw e;
  }
  throw new Error("the files compiled");
}
const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("AIML in detail", () => {
  it("AM7.1 Program AB's text files: comments, blank lines and indentation are skipped; keys and values are trimmed; quoted pairs may space their comma", () => {
    const { bot } = compileAiml({
      "bot.aiml": aiml(cat("HI", "x")),
      "sets/animal.txt": "  cat\n\n# a comment\n  // another\nbig dog\n-\n",
      "maps/capitals.txt": "# capital cities\nFrance : Paris\n\n  // more\nUnited Kingdom:London\n",
      "properties.txt": '  name : Robo \n# comment\nmaster:Ada:Lovelace\ngreeting:"hello", "world"\n"a","b":c',
      "person.txt": '"I am" , "you are"\n  "my","your"',
    });
    expect(bot.sets).toEqual(new Map([["animal", [["CAT"], ["BIG", "DOG"]]]]));
    expect(bot.maps).toEqual(new Map([["capitals", new Map([["FRANCE", "Paris"], ["UNITED KINGDOM", "London"]])]]));
    expect(bot.properties).toEqual(
      new Map([
        ["name", "Robo"],
        ["master", "Ada:Lovelace"],
        ["greeting", '"hello", "world"'],
        ['"a","b"', "c"],
      ]),
    );
    expect(bot.substitutions).toEqual(new Map([["person", [["I am", "you are"], ["my", "your"]]]]));
  });

  it("AM7.2 Pandorabots' JSON files may start with whitespace; set entries are phrases or words, map keys are normalized, and the fallback is the model's", () => {
    const { bot } = compileAiml({
      "bot.aiml": aiml(cat("HI", "x")),
      "colors.set": `\n ${JSON.stringify([["red"], ["light", "blue"], "green", []])}`,
      "states.map": `\n${JSON.stringify([["new york", "Albany"]])}`,
      "bot.properties": ` ${JSON.stringify([["Name", "Harness"]])}`,
      "normal.substitution": `\n${JSON.stringify([["it's", "it is"]])}`,
    });
    expect(bot.sets).toEqual(new Map([["colors", [["RED"], ["LIGHT", "BLUE"], ["GREEN"]]]]));
    expect(bot.maps).toEqual(new Map([["states", new Map([["NEW YORK", "Albany"]])]]));
    expect(bot.properties).toEqual(new Map([["name", "Harness"]]));
    expect(bot.substitutions).toEqual(new Map([["normal", [["it's", "it is"]]]]));
    expect(bot.fallback).toBe("model");
  });

  it("AM7.3 JSON pairs must each be two strings", () => {
    const expected = 'a.map: expected [["key", "value"], ...]';
    const refused = (pairs: unknown) => refusal({ "a.aiml": aiml(cat("X", "y")), "a.map": JSON.stringify(pairs) });
    expect(refused([["a", "b"], 1])).toBe(expected);
    expect(refused([["a", "b"], "ab"])).toBe(expected);
    expect(refused([["a", "b", "c"]])).toBe(expected);
    expect(refused([["a", 1]])).toBe(expected);
    expect(refused([[1, 2]])).toBe(expected);
  });

  it("AM7.4 a file's kind is decided by how its whole name ends, and it is named by its base name", () => {
    expect(["bot.aiml.bak", "properties.txt.bak", "mysets/a.txt", "notes.txt", "sets/a/b.txt"].map(isAimlFile)).toEqual([false, false, false, false, false]);
    expect(["Bot.AIML", "a.set", "a.map", "a.properties", "a.substitution", "sets/a.txt", "x/maps/b.txt", "properties.txt", "normal.txt", "denormal.txt", "person.txt", "person2.txt", "gender.txt"].every(isAimlFile)).toBe(true);
    const { bot } = compileAiml({
      "bot.aiml": aiml(cat("HI", "x")),
      "sets/colors.txt.map": "red:rot",
      "maps/capitals.txt.properties": "name:Robo",
      "properties.txt.substitution": "a:b",
      "My.Animals.set": "cat",
    });
    expect(bot.maps).toEqual(new Map([["colors.txt", new Map([["RED", "rot"]])]]));
    expect(bot.sets).toEqual(new Map([["my.animals", [["CAT"]]]]));
    expect(bot.properties).toEqual(new Map([["name", "Robo"]]));
    expect(bot.substitutions).toEqual(new Map([["properties.txt", [["a", "b"]]]]));
  });

  it("AM7.5 in a pattern, a set's name and a bot property's name are trimmed, and a property the bot lacks is spelled unknown", () => {
    const c = chat({
      "bot.aiml": aiml(cat("<set> animal </set>", "animal") + cat("I AM <bot>\n  <name>name</name>\n</bot>", "Me too.") + cat("CALL <bot name=\"nope\"/>", "called")),
      "animal.set": "cat",
      "bot.properties": "name:Robo",
    });
    expect(said(c.say("cat"))).toBe("animal");
    expect(said(c.say("i am robo"))).toBe("Me too.");
    expect(said(c.say("call unknown"))).toBe("called");
  });

  it("AM7.6 an empty pattern or that is *: an empty pattern is the catch-all, but a lone _ is not", () => {
    const empty = aiml(cat("", "Anything.") + cat("HI", "Hi!", "<that></that>"));
    expect(said(chat(empty, { fallback: "bot" }).say("what now"))).toBe("Anything.");
    expect(chat(empty).say("what now")).toMatchObject({ say: [], pass: true });
    const c = chat(empty);
    expect(said(c.say("hi"))).toBe("Hi!");
    expect(said(c.say("hi"))).toBe("Hi!");
    expect(said(chat(aiml(cat("_", "Underscore."))).say("hello"))).toBe("Underscore.");
  });

  it("AM7.7 a <topic> inside a category is its topic", () => {
    const c = chat(aiml(cat("SET *", '<think><set name="topic"><star/></set></think>ok') + cat("WHAT", "movies", "<topic>MOVIES</topic>") + cat("WHAT", "anything")));
    expect(said(c.say("what"))).toBe("anything");
    c.say("set movies");
    expect(said(c.say("what"))).toBe("movies");
  });

  it("AM7.8 <topicstar> and <thatstar> read the topic's and that's wildcards, all their words, UNKNOWN when unset", () => {
    const c = chat(aiml(cat("SET TOPIC *", '<think><set name="topic"><star/></set></think>ok') + cat("WHAT", "[<topicstar/>|<thatstar/>|<star/>]", "<that>*</that><topic>*</topic>") + `<topic name="MOVIES TONIGHT">${cat("WHAT", "tonight")}</topic>`));
    expect(said(c.say("what"))).toBe("[UNKNOWN|UNKNOWN|]");
    c.say("set topic movies");
    expect(said(c.say("what"))).toBe("[MOVIES|OK|]");
    c.say("set topic movies tonight");
    expect(said(c.say("what"))).toBe("tonight");
    c.say("set topic old movies");
    expect(said(c.say("what"))).toBe("[OLD MOVIES|OK|]");
  });

  it("AM7.9 <that> matches the bot's last sentence normalized; after a reply of nothing, it is UNKNOWN", () => {
    const c = chat({
      "bot.aiml": aiml(cat("TIME", "It's late.") + cat("OK", "Bed then.", "<that>IT IS LATE</that>") + cat("OK", "Ok what?") + cat("QUIET", "<think>shh</think>") + cat("THAT", "[<thatstar/>]", "<that>*</that>")),
      "normal.txt": "it's:it is",
    });
    expect(said(c.say("time"))).toBe("It's late.");
    expect(said(c.say("ok"))).toBe("Bed then.");
    expect(said(c.say("ok"))).toBe("Ok what?");
    expect(c.say("quiet")).toMatchObject({ say: [] });
    expect(said(c.say("that"))).toBe("[UNKNOWN]");
  });

  it("AM7.10 sets: the longest phrase is tried first, then shorter ones; a phrase matches all its words; number is digits only", () => {
    const animals = JSON.stringify([["big"], ["big", "dog"]]);
    expect(said(chat({ "bot.aiml": aiml(cat("<set>animal</set> *", "[<star/>|<star index=\"2\"/>]")), "animal.set": animals }).say("big dog barks"))).toBe("[BIG DOG|BARKS]");
    const c = chat({ "bot.aiml": aiml(cat("<set>animal</set> DOG BARKS", "barks: <star/>") + cat("<set>number</set> PLEASE", "n<star/>") + cat("*", "none")), "animal.set": animals }, { fallback: "bot" });
    expect(said(c.say("big dog barks"))).toBe("barks: BIG");
    expect(said(c.say("big cat dog barks"))).toBe("none");
    expect(said(c.say("42 please"))).toBe("n42");
    expect(said(c.say("4x please"))).toBe("none");
    expect(said(c.say("x4 please"))).toBe("none");
    expect(said(c.say("x please"))).toBe("none");
    expect(said(chat(aiml(cat("<set>nope</set>", "a set") + cat("*", "none")), { fallback: "bot" }).say("nope"))).toBe("none");
  });

  it("AM7.11 * and _ cover at least one word", () => {
    const c = chat(aiml(cat("* TEA", "star") + cat("_ COFFEE", "underscore") + cat("*", "none")), { fallback: "bot" });
    expect(said(c.say("tea"))).toBe("none");
    expect(said(c.say("coffee"))).toBe("none");
    expect(said(c.say("green tea"))).toBe("star");
  });

  it("AM7.12 a wildcard covers words of its own section only, so many wildcards cost little", () => {
    const many = "_ _ _ _ _";
    const c = chat(aiml(cat(`A ${many} Z`, "never") + cat("A", "a") + cat("B", "never", `<that>${many} Z</that>`) + cat("B", "b") + cat("LONG", `${words("w", 40)}.`) + cat("TOPIC", `<think><set name="topic">${words("t", 40)}</set></think>ok`)));
    c.say("long");
    expect(said(c.say("a"))).toBe("a");
    c.say("topic");
    expect(said(c.say("b"))).toBe("b");
  });

  it("AM7.13 a turn may take 100,000 graph steps over all its sentences, and no more", () => {
    // With only these categories, a one-word sentence takes 6 steps and a two-word one 7.
    const bot = aimlInterpreter.compile({ "bot.aiml": aiml(cat("A", "a") + cat("B C", "b")) }, {});
    const turn = (a: number, bc: number) => bot.step({ state: null, utterance: "a. ".repeat(a) + "b c. ".repeat(bc) });
    expect(turn(16666, 0).pass).toBeUndefined();
    expect(turn(16667, 0)).toMatchObject({ say: [], pass: true });
    expect(turn(16662, 4).say[0]!.length).toBe(33331);
    expect(turn(16661, 5)).toMatchObject({ say: [], pass: true });
  });

  it("AM7.14 a turn makes at most 256 reductions, sentences answered directly not counted", () => {
    const c = chat(aiml(cat("GO", "<srai>X</srai>".repeat(300)) + cat("X", "x")));
    expect(said(c.say("go"))).toBe("x".repeat(256));
    expect(said(c.say("x. ".repeat(300)))).toBe(Array.from({ length: 300 }, () => "x").join(" "));
  });

  it("AM7.15 <sr/> reduces its star at the next depth, so a reduction to itself stops; an empty reduction says nothing", () => {
    expect(said(chat(aiml(cat("#", "<sr/>x"))).say("loop"))).toBe("x".repeat(17));
    expect(said(chat(aiml(cat("EMPTY", "a<srai>?</srai><sr/>b"))).say("empty"))).toBe("ab");
  });

  it("AM7.16 random is seeded by the first utterance and chooses alike after every upgrade: stored conversations replay", () => {
    const bot = aiml(cat("PICK", "<random><li>A</li><li>B</li><li>C</li><li>D</li></random>"));
    const picks = (first: string) => {
      const c = chat(bot);
      return Array.from({ length: 8 }, (_, i) => said(c.say(i === 0 ? first : "pick")));
    };
    expect(picks("pick")).toEqual(["D", "C", "B", "A", "A", "C", "A", "D"]);
    expect(picks("Pick!")).toEqual(["A", "D", "D", "D", "A", "B", "B", "D"]);
    expect(said(chat(aiml(cat("NONE", "a<random></random>b"))).say("none"))).toBe("ab");
  });

  it("AM7.17 the state keeps the last 10 inputs and responses", () => {
    const c = chat(aiml(cat("N *", "r<star/>")));
    let r: StepResult | undefined;
    for (let i = 1; i <= 12; i++) r = c.say(`n ${i}`);
    expect(r!.state).toMatchObject({ inputs: Array.from({ length: 10 }, (_, i) => `n ${i + 3}`), responses: Array.from({ length: 10 }, (_, i) => `r${i + 3}`) });
  });

  it("AM7.18 <input>, <request> and <response> read back by index, nothing past the history", () => {
    const c = chat(aiml(cat("ONE", "First.") + cat("TWO", "Second.") + cat("RECALL", '<input/>|<request index="2"/>|<response/>|<response index="2"/>|<input index="9"/>|<response index="9"/>')));
    expect(said(c.say("recall"))).toBe("recall|||||");
    c.say("one");
    c.say("two");
    expect(said(c.say("recall"))).toBe("recall|two|Second.|First.||");
  });

  it("AM7.19 <that index=\"response,sentence\"> reads a sentence of an earlier response, nothing past them", () => {
    const c = chat(aiml(cat("A", "One. Two.") + cat("B", "Three. Four.") + cat("THAT", '<that/>|<that index="2,1"/>|<that index="1,2"/>|<that index=" 2 , 2"/>|<that index="3,1"/>|<that index="1,3"/>')));
    c.say("a");
    c.say("b");
    expect(said(c.say("that"))).toBe("Four|Two|Three|One||");
  });

  it("AM7.20 <star> by index: an index that is no number or below one is the first, one past the stars is nothing", () => {
    const c = chat(aiml(cat("I LIKE * AND *", '<star index="0"/>|<star index="x"/>|<star index="3"/>|<star><index>2</index></star>')));
    expect(said(c.say("i like tea and cake"))).toBe("TEA|TEA||CAKE");
  });

  it("AM7.21 set and get: names and values are trimmed, a name may be an element, and attribute elements are not the value", () => {
    const c = chat(
      aiml(
        cat("STORE", '<set><name>a</name>1</set><set><name>b</name>2</set><set name="c"> 3 </set><set><var>t</var>local</set><set name="k"><index>1</index><format>f</format><jformat>j</jformat><default>d</default>v</set>') +
          cat("SHOW", '<get name="a"/>|<get><name> b </name></get>|[<get name="c"/>]|<get var="t"/>|<get name="t"/>|<get name="k"/>'),
      ),
    );
    expect(said(c.say("store"))).toBe("123localv");
    expect(said(c.say("show"))).toBe("1|2|[3]|unknown|unknown|v");
  });

  it("AM7.22 a nameless <set>, <get>, <condition>, <bot> and <map> share the nameless predicate, property and map", () => {
    const c = chat({ "bot.aiml": aiml(cat("SET", "<think><set>v</set></think>ok") + cat("GET", '<get/>|<condition value="v">yes</condition>|<bot/>|<map>a</map>')), "properties.txt": ":blank", ".map": "a:b" });
    expect(said(c.say("get"))).toBe("unknown||blank|b");
    c.say("set");
    expect(said(c.say("get"))).toBe("v|yes|blank|b");
  });

  it("AM7.23 conditions on locals, by value element, by several words, by a spaced *, and none chosen saying nothing", () => {
    const c = chat(
      aiml(
        cat("SET *", '<think><set name="mood"><star/></set></think>ok') +
          cat(
            "LOCAL *",
            '<think><set var="t"><star/></set></think>' +
              '<condition var="t" value="x">vx</condition>|' +
              '<condition var="t"><li value="y">ly</li><li>other</li></condition>|' +
              '<condition><li var="t" value="y">liy</li><li>none</li></condition>|' +
              '<condition var="nope"><li value="*">set</li><li>unset</li></condition>',
          ) +
          cat("MOOD", '<condition name="mood"><value>happy</value>Glad</condition>|<condition name="mood" value="very happy">Very</condition>|<condition name="mood"><li value=" * ">any</li></condition>|<condition name="mood"><li value="sad">s</li></condition>'),
      ),
    );
    expect(said(c.say("local x"))).toBe("vx|other|none|unset");
    expect(said(c.say("local y"))).toBe("|ly|liy|unset");
    c.say("set happy");
    expect(said(c.say("mood"))).toBe("Glad||any|");
    c.say("set very happy");
    expect(said(c.say("mood"))).toBe("|Very|any|");
  });

  it("AM7.24 a condition loops at most 16 rounds, and one choosing no <li> is evaluated once", () => {
    const c = chat(aiml(cat("SPIN", "<condition><li>x<loop/></li></condition>") + cat("ONCE", '<condition name="n"><li><value><think><set name="c"><get name="c"/>x</set></think>zzz</value>never</li></condition>') + cat("C", '<get name="c"/>')));
    expect(said(c.say("spin"))).toBe("x".repeat(16));
    expect(c.say("once")).toMatchObject({ say: [] });
    expect(said(c.say("c"))).toBe("unknownx");
  });

  it("AM7.25 learned categories keep their that and topic, evaluate the rest when they answer, and need a template", () => {
    const c = chat(
      aiml(
        cat("TEACH", "<learn><category><pattern>HELLO *</pattern><that>OK</that><topic>WORK</topic><template>Hi <star/>, at work.</template></category><category><pattern>BROKEN</pattern></category></learn>ok") +
          cat("WORK", '<think><set name="topic">work</set></think>ok') +
          cat("HELLO *", "hello") +
          cat("OTHER", "other") +
          cat("BROKEN", "whole"),
      ),
    );
    expect(said(c.say("teach"))).toBe("ok");
    expect(said(c.say("hello bob"))).toBe("hello");
    c.say("work");
    expect(said(c.say("hello bob"))).toBe("Hi BOB, at work.");
    expect(said(c.say("broken"))).toBe("whole");
    c.say("other");
    expect(said(c.say("hello bob"))).toBe("hello");
  });

  it("AM7.26 a conversation keeps its last 100 learned categories; learnf learns as learn does", () => {
    const c = chat(aiml(cat("LEARN *", "<learnf><category><pattern>KNOW <eval><star/></eval></pattern><template>known <eval><star/></eval></template></category></learnf>ok")));
    const r = c.say(Array.from({ length: 101 }, (_, i) => `learn w${i}.`).join(" "));
    expect((r.state as { learned: unknown[] }).learned).toHaveLength(100);
    expect(said(c.say("know w1"))).toBe("known W1");
    expect(c.say("know w0")).toMatchObject({ pass: true });
  });

  it("AM7.27 text elements: case, sentence, first and rest of text with spaces, maps by several words or none, vocabulary, and elements that say nothing", () => {
    const c = chat({
      "bot.aiml": aiml(
        cat("T", "<uppercase>abc</uppercase>|<lowercase>ABC</lowercase>|[<sentence> hello there</sentence>]|<first> x y</first>|<rest> x y z</rest>|<vocabulary/>|<eval>e</eval>") +
          cat("M", '<map name="states">new york</map>|<map name="nope">x</map>') +
          cat("Q", "a<oob>hidden</oob><loop>x</loop>b<br/>c") +
          cat("SPACE", "a \n\n  b"),
      ),
      "states.map": JSON.stringify([["new york", "Albany"]]),
    });
    expect(said(c.say("t"))).toBe("ABC|abc|[Hello there]|x|y z|4|e");
    expect(said(c.say("m"))).toBe("Albany|unknown");
    expect(said(c.say("q"))).toBe("ab c");
    expect(said(c.say("space"))).toBe("a b");
  });

  it("AM7.28 substitutions: the longest entry first, an empty entry never, and no table changes nothing", () => {
    const c = chat({
      "bot.aiml": aiml(cat("P *", "[<person><star/></person>]|[<person2> me </person2>]") + cat("IT IS", "ok")),
      "person.substitution": JSON.stringify([[" i ", " you "], [" i am ", " you are "]]),
      "normal.txt": "it's:it is\n:x",
    });
    expect(said(c.say("p i am here"))).toBe("[you are HERE]|[ me ]");
    expect(said(c.say("it's"))).toBe("ok");
  });

  it("AM7.29 every AIML element compiles without a warning; the ones not supported warn and say nothing", () => {
    const known = "<star/><thatstar/><topicstar/><that/><input/><request/><response/><get/><set/><srai/><sr/><sraix/><random><li/></random><condition><li><loop/></li></condition><bot/><uppercase/><lowercase/><formal/><sentence/><explode/><normalize/><denormalize/><person/><person2/><gender/><date/><size/><version/><id/><program/><vocabulary/><map/><learn><category><pattern>X</pattern><template>y</template></category></learn><learnf/><eval/><first/><rest/><oob/><br/><name/><var/><value/><index/><format/><jformat/><default/>";
    expect(compileAiml({ "bot.aiml": aiml(cat("ALL", `<think>${known}</think>`)) }).warnings).toEqual([]);
    const c = chat(aiml(cat("SKIP", "a<uniq>1</uniq><select>2</select><addtriple>3</addtriple><deletetriple>4</deletetriple><search>5</search>b")));
    expect(said(c.say("skip"))).toBe("ab");
    expect(c.warnings).toEqual(["uniq", "select", "addtriple", "deletetriple", "search"].map((e) => `bot.aiml: <${e}> is not supported and says nothing`));
  });

  it("AM7.30 dates: every month and weekday by name, January and February, leap days of centuries, noon and midnight", () => {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    for (const year of [1900, 1969, 2000, 2024, 2100]) {
      for (let m = 0; m < 12; m++) expect(formatDate(Date.UTC(year, m, 1), "%Y-%m-%d %B %b")).toBe(`${year}-${String(m + 1).padStart(2, "0")}-01 ${months[m]} ${months[m]!.slice(0, 3)}`);
    }
    expect(["2000-02-29", "2000-03-01", "1900-02-28", "1900-03-01", "2100-02-28", "2100-03-01", "1969-12-31", "1970-01-01", "1600-02-29", "1700-03-01"].map((d) => formatDate(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8))), "%Y-%m-%d"))).toEqual([
      "2000-02-29", "2000-03-01", "1900-02-28", "1900-03-01", "2100-02-28", "2100-03-01", "1969-12-31", "1970-01-01", "1600-02-29", "1700-03-01",
    ]);
    // 2024-03-04 was a Monday.
    expect(Array.from({ length: 7 }, (_, i) => formatDate(Date.UTC(2024, 2, 4 + i), "%A %a"))).toEqual(["Monday Mon", "Tuesday Tue", "Wednesday Wed", "Thursday Thu", "Friday Fri", "Saturday Sat", "Sunday Sun"]);
    expect(formatDate(Date.UTC(2024, 0, 1, 12, 0, 0), "%I %p")).toBe("12 PM");
    expect(formatDate(Date.UTC(2024, 0, 1, 0, 0, 0), "%I %p")).toBe("12 AM");
    expect(formatDate(Date.UTC(2024, 0, 1, 23, 0, 0), "%I %p")).toBe("11 PM");
  });

  it("AM7.31 a step: no utterance is the model's; answers are trimmed and empty ones left out; a reply of nothing says nothing; a turn passed on says nothing", () => {
    const bot = aimlInterpreter.compile({ "bot.aiml": aiml(cat("HI", " Hello ") + cat("QUIET", "<think>shh</think>") + cat("*", "any")) }, { fallback: "bot" });
    expect(bot.step({ state: null })).toMatchObject({ say: [], pass: true });
    expect(bot.step({ state: null, utterance: "quiet. hi" }).say).toEqual(["Hello"]);
    expect(bot.step({ state: null, utterance: "quiet" }).say).toEqual([]);
    expect(chat(aiml(cat("HI", "Hello."))).say("bye").say).toEqual([]);
  });

  it("AM7.32 punctuation between words parts them, as a space does", () => {
    expect(aimlWords("tea,cake;milk")).toEqual(["TEA", "CAKE", "MILK"]);
  });
});

describe("AIML learning within bounds, and Java dates", () => {
  it("AM8.1 a category too long, or one a pattern cannot hold, is not learned; the conversation goes on", () => {
    const c = chat(aiml(cat("LEARN *", "<learn><category><pattern><eval><star/></eval></pattern><template>Learned.</template></category></learn>Ok.") + cat("BAD", "<learn><category><pattern>X <get name=\"n\"/></pattern><template>No.</template></category></learn>Tried.") + cat("*", "Default.", "") ), { fallback: "bot" });
    const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(" ");
    expect(said(c.say(`learn ${long}`))).toBe("Ok.");
    expect(said(c.say(long))).toBe("Default.");
    expect(said(c.say("bad"))).toBe("Tried.");
    expect(said(c.say("x unknown"))).toBe("Default.");
    expect(said(c.say("learn short phrase"))).toBe("Ok.");
    expect(said(c.say("short phrase"))).toBe("Learned.");
  });

  it("AM8.2 jformat is Java's SimpleDateFormat: names, widths, quoted text and a quote", () => {
    // Friday, 5 March 2021, 15:04:09 UTC.
    const at = Date.UTC(2021, 2, 5, 15, 4, 9);
    const c = chat(aiml(cat("WHEN", "<date jformat=\"EEEE, MMMM d, yyyy 'at' h:mm:ss a (EEE MMM dd yy HH) ''\"/>")), {}, at);
    expect(said(c.say("when"))).toBe("Friday, March 5, 2021 at 3:04:09 PM (Fri Mar 05 21 15) '");
    expect(formatJavaDate(at, "M/d/yyyy q")).toBe("3/5/2021 q");
  });
});
