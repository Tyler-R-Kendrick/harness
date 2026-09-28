import { describe, expect, it } from "vitest";
import { compileVoiceXml, DocumentError, isVoiceXmlFile, ScriptError, stepVoiceXml, voiceXml } from "@harness/dialogue-standards";
import type { StepResult } from "@harness/dialogue";

const vxml = (body: string, attrs = "") => `<?xml version="1.0"?><vxml version="2.1" xmlns="http://www.w3.org/2001/vxml" ${attrs}>${body}</vxml>`;
const sizes = `<grammar root="size"><rule id="size"><one-of><item>small</item><item>medium</item><item>large</item></one-of></rule></grammar>`;

/** A conversation with a VoiceXML application, a step at a time, as its flow would have it. */
function call(files: Record<string, string> | string, options: Record<string, string> = {}) {
  const compiled = voiceXml.compile(typeof files === "string" ? { "app.vxml": files } : files, options);
  let state: unknown = null;
  const take = (r: StepResult) => ((state = r.state), r);
  return {
    start: (slots: Record<string, string> = {}) => take(compiled.step({ state: null, utterance: "", slots })),
    say: (utterance: string) => take(compiled.step({ state: state as never, utterance })),
    result: (result: unknown) => take(compiled.step({ state: state as never, result: result as never })),
    error: (error: string) => take(compiled.step({ state: state as never, error })),
    get state() {
      return state;
    },
  };
}

const pizza = vxml(`
  <var name="orders" expr="0"/>
  <link event="help"><grammar root="h"><rule id="h">help</rule></grammar></link>
  <catch event="help"><prompt>You can order a pizza.</prompt><reprompt/></catch>
  <form id="order">
    <block>Welcome to Pizza Place.</block>
    <field name="size">
      <prompt>What size?</prompt>
      <prompt count="2">Small, medium or large?</prompt>
      ${sizes}
      <nomatch>Sorry.<reprompt/></nomatch>
      <nomatch count="3">Let me get someone.<goto next="#agent"/></nomatch>
    </field>
    <field name="count" type="number"><prompt>How many?</prompt></field>
    <filled>
      <assign name="orders" expr="orders + Number(count)"/>
      <prompt>That's <value expr="count"/> <value expr="size"/> pizzas.</prompt>
      <goto next="#confirm"/>
    </filled>
  </form>
  <form id="confirm">
    <field name="ok" type="boolean">
      <prompt>Shall I place it?</prompt>
      <filled>
        <if cond="ok"><data name="receipt" src="tool:place-order" namelist="orders"/><prompt>Order <value expr="receipt.id"/> placed.</prompt><exit namelist="orders"/>
        <else/><prompt>Cancelled.</prompt><exit expr="'cancelled'"/></if>
      </filled>
    </field>
  </form>
  <form id="agent"><transfer name="t"><prompt>Transferring.</prompt></transfer></form>`);

describe("VoiceXML: the form interpretation algorithm, a turn at a time", () => {
  it("VX1.1 an order: blocks and prompts are said, fields filled from grammars and builtin types, filled actions run, a tool is called, and the call ends", () => {
    const c = call(pizza);
    expect(c.start()).toEqual({ say: ["Welcome to Pizza Place.", "What size?"], state: expect.anything() });
    expect(c.say("large").say).toEqual(["How many?"]);
    expect(c.say("two").say).toEqual(["That's 2 large pizzas.", "Shall I place it?"]);
    const placing = c.say("yes");
    expect(placing).toMatchObject({ say: [], call: { tool: "place-order", input: { orders: 2 } } });
    expect(c.result({ id: "A1" })).toMatchObject({ say: ["Order A1 placed."], end: "exit", output: { orders: 2 } });
  });

  it("VX1.2 a nomatch runs the handler for its count, which reprompts with the prompt for the prompt count; at its last count it goes on elsewhere", () => {
    const c = call(pizza);
    c.start();
    expect(c.say("huge").say).toEqual(["Sorry.", "Small, medium or large?"]);
    expect(c.say("gigantic").say).toEqual(["Sorry.", "Small, medium or large?"]);
    expect(c.say("enormous")).toMatchObject({ say: ["Let me get someone.", "Transferring."], end: "transfer" });
  });

  it("VX1.3 a link's grammar is active in every field: its event is caught by the document's handler, which reprompts", () => {
    const c = call(pizza);
    c.start();
    // The item is visited again: its prompt count is now 2.
    expect(c.say("help").say).toEqual(["You can order a pizza.", "Small, medium or large?"]);
    expect(c.say("small").say).toEqual(["How many?"]);
  });

  it("VX1.4 an answer no grammar takes, with no handler, is the model's: the field still waits, and is not prompted again", () => {
    const c = call(pizza);
    c.start();
    c.say("small");
    c.say("one");
    expect(c.say("what toppings do you have?")).toMatchObject({ say: [], pass: true });
    expect(c.say("no").say).toEqual(["Cancelled."]);
  });

  it("VX1.5 with nomatch set to reprompt, such an answer is not the model's: the platform says it did not understand, and waits", () => {
    const c = call(pizza, { nomatch: "reprompt" });
    c.start();
    c.say("small");
    c.say("one");
    expect(c.say("what toppings?")).toMatchObject({ say: ["Sorry, I didn't understand.", "Shall I place it?"] });
    expect(c.say("no")).toMatchObject({ end: "exit", output: "cancelled" });
  });

  it("VX1.6 an empty answer is noinput: the field is prompted again", () => {
    const c = call(pizza);
    c.start();
    expect(c.say("  ").say).toEqual(["Small, medium or large?"]);
  });

  it("VX1.7 a script's slots fill fields of the same name when the application starts", () => {
    const c = call(pizza);
    expect(c.start({ size: "medium", unknown: "x" }).say).toEqual(["Welcome to Pizza Place.", "How many?"]);
    expect(c.say("3").say).toEqual(["That's 3 medium pizzas.", "Shall I place it?"]);
  });

  it("VX1.8 the state is JSON: a step from a copy of it goes on the same", () => {
    const c = call(pizza);
    c.start();
    c.say("large");
    const copy = JSON.parse(JSON.stringify(c.state)) as never;
    const compiled = voiceXml.compile({ "app.vxml": pizza }, {});
    expect(compiled.step({ state: copy, utterance: "4" }).say).toEqual(["That's 4 large pizzas.", "Shall I place it?"]);
  });
});

describe("VoiceXML dialogs", () => {
  it("VX2.1 a menu's choices go where they say, by words or by number; enumerate lists them", () => {
    const c = call(
      vxml(`<menu id="main" dtmf="true"><prompt>Say <enumerate/>.</prompt><choice next="#sales">sales</choice><choice next="#support">technical support</choice><choice event="quit">goodbye</choice></menu>
      <form id="sales"><block>Sales here.<exit/></block></form>
      <form id="support"><block>Support here.<exit/></block></form>
      <catch event="quit">Bye.<exit/></catch>`),
    );
    expect(c.start().say).toEqual(["Say sales, technical support, goodbye."]);
    expect(c.say("technical support")).toMatchObject({ say: ["Support here."], end: "exit" });
    c.start();
    expect(c.say("1")).toMatchObject({ say: ["Sales here."] });
    c.start();
    expect(c.say("goodbye")).toMatchObject({ say: ["Bye."], end: "exit" });
  });

  it("VX2.2 an approximate menu takes some of a choice's words in its order; with dtmf the choices without keys are numbered, and an enumerate template says each", () => {
    const c = call(
      vxml(`<menu accept="approximate" dtmf="true"><prompt><enumerate>For <value expr="_prompt"/> press <value expr="_dtmf"/>.</enumerate></prompt><choice next="#a">billing</choice><choice dtmf="0" next="#o">operator</choice><choice next="#b">opening hours today</choice></menu>
      <form id="a"><block>Billing.</block></form><form id="o"><block>Operator.</block></form><form id="b"><block>Hours.</block></form>`),
    );
    expect(c.start().say).toEqual(["For billing press 1. For operator press 0. For opening hours today press 2."]);
    expect(c.say("hours").say).toEqual(["Hours."]);
    c.start();
    expect(c.say("opening today").say).toEqual(["Hours."]);
    c.start();
    expect(c.say("2").say).toEqual(["Hours."]);
    c.start();
    expect(c.say("0").say).toEqual(["Operator."]);
    c.start();
    // More than a choice says, or its words out of order, is not a subphrase of it.
    expect(c.say("what are your opening hours")).toMatchObject({ pass: true });
    expect(c.say("today hours")).toMatchObject({ pass: true });
  });

  it("VX2.16 a choice with grammars of its own is said by them, not its text; a choice's accept is its own", () => {
    const c = call(
      vxml(`<menu><choice next="#a">sales<grammar root="s"><rule id="s"><one-of><item>buy</item><item>purchase</item></one-of></rule></grammar></choice><choice next="#b" accept="approximate">technical support</choice></menu>
      <form id="a"><block>Sales.</block></form><form id="b"><block>Support.</block></form>`),
    );
    c.start();
    expect(c.say("purchase").say).toEqual(["Sales."]);
    c.start();
    expect(c.say("sales")).toMatchObject({ pass: true });
    expect(c.say("support").say).toEqual(["Support."]);
  });

  it("VX2.3 a field's options are its grammar (with their dtmf keys) and its enumeration", () => {
    const c = call(vxml(`<form><field name="drink"><prompt>We have <enumerate/>.</prompt><option dtmf="1" value="c">coffee</option><option>tea</option><filled>A <value expr="drink"/>.</filled></field></form>`));
    expect(c.start().say).toEqual(["We have coffee, tea."]);
    expect(c.say("1").say).toEqual(["A c."]);
    c.start();
    expect(c.say("Tea").say).toEqual(["A tea."]);
  });

  it("VX2.4 a form grammar fills several fields at once (mixed initiative), after which the initial is done and the rest are asked for", () => {
    const c = call(
      vxml(`<form id="trip">
        <grammar root="trip" tag-format="semantics/1.0"><rule id="trip">from <ruleref uri="#city"/><tag>out.from = rules.city</tag> <item repeat="0-1">to <ruleref uri="#city"/><tag>out.to = rules.latest()</tag></item></rule><rule id="city"><one-of><item>boston</item><item>denver</item></one-of></rule></grammar>
        <initial name="start"><prompt>Where to and from?</prompt></initial>
        <field name="from"><prompt>From where?</prompt><grammar root="c"><rule id="c"><one-of><item>boston</item><item>denver</item></one-of></rule></grammar></field>
        <field name="to"><prompt>To where?</prompt><grammar root="c"><rule id="c"><one-of><item>boston</item><item>denver</item></one-of></rule></grammar></field>
        <filled mode="all">From <value expr="from"/> to <value expr="to"/>.</filled>
      </form>`),
    );
    expect(c.start().say).toEqual(["Where to and from?"]);
    expect(c.say("from boston").say).toEqual(["To where?"]);
    expect(c.say("denver").say).toEqual(["From boston to denver."]);
    c.start();
    expect(c.say("from denver to boston").say).toEqual(["From denver to boston."]);
  });

  it("VX2.5 a form's filled with mode any and a namelist runs when one of those is filled", () => {
    const c = call(
      vxml(`<form><field name="a" type="digits"><prompt>A?</prompt></field><field name="b" type="digits"><prompt>B?</prompt></field>
      <filled mode="any" namelist="a">Got a.</filled><filled namelist="a b">Got both.</filled></form>`),
    );
    c.start();
    expect(c.say("1").say).toEqual(["Got a.", "B?"]);
    expect(c.say("2").say).toEqual(["Got both."]);
  });

  it("VX2.6 a subdialog runs a form with its params and returns its namelist into the calling item; a returned event is thrown there", () => {
    const c = call(
      vxml(`<form id="main">
        <subdialog name="who" src="#ask-name"><param name="greeting" expr="'Hello'"/><filled>Hi <value expr="who.name"/>.</filled></subdialog>
        <subdialog name="again" src="#refuse"><catch event="refused">Fine.<exit/></catch></subdialog>
      </form>
      <form id="ask-name"><var name="greeting"/><field name="name"><prompt><value expr="greeting"/>, your name?</prompt><grammar root="n"><rule id="n"><one-of><item>ann</item><item>bo</item></one-of></rule></grammar><filled><return namelist="name"/></filled></field></form>
      <form id="refuse"><block><return event="refused"/></block></form>`),
    );
    expect(c.start().say).toEqual(["Hello, your name?"]);
    expect(c.say("ann")).toMatchObject({ say: ["Hi ann.", "Fine."], end: "exit" });
  });

  it("VX2.7 clear forgets fields so they are asked again; throw raises an event a catch takes with _event; a catch with a cond applies only when it holds", () => {
    const c = call(
      vxml(`<form><var name="tries" expr="0"/>
        <field name="pin" type="digits"><prompt>PIN?</prompt>
          <filled><if cond="pin != '1234'"><assign name="tries" expr="tries + 1"/><throw event="bad.pin" message="wrong"/></if>Welcome.<exit/></filled>
        </field>
        <catch event="bad" cond="tries &lt; 2">Wrong <value expr="_event"/> (<value expr="_message"/>).<clear namelist="pin"/></catch>
        <catch event="bad">Locked.<exit expr="tries"/></catch>
      </form>`),
    );
    c.start();
    expect(c.say("1111").say).toEqual(["Wrong bad.pin (wrong).", "PIN?"]);
    expect(c.say("2222")).toMatchObject({ say: ["Locked."], end: "exit", output: 2 });
  });

  it("VX2.8 goto goes to another document with its own variables, to an item in the form, or where an expression says", () => {
    const c = call({
      "app.vxml": vxml(`<var name="v" expr="'app'"/><form><block><goto expr="'next.vxml#second'"/></block></form>`),
      "next.vxml": vxml(`<var name="v" expr="'next'"/><form id="first"><block>Wrong.</block></form><form id="second">
        <block name="b1">In <value expr="v"/>.<goto nextitem="b3"/></block><block name="b2">Skipped.</block><block name="b3">Jumped.<goto expritem="'b2'"/></block></form>`),
    });
    expect(c.start()).toMatchObject({ say: ["In next.", "Jumped.", "Skipped."], end: "exit" });
  });

  it("VX2.9 an application root's variables, handlers and links apply in its documents", () => {
    const c = call({
      "root.vxml": vxml(`<var name="brand" expr="'Acme'"/><link next="leaf.vxml#bye"><grammar root="q"><rule id="q">quit</rule></grammar></link><catch event="nomatch">Say a number.<reprompt/></catch>`),
      "leaf.vxml": vxml(`<form><field name="n" type="number"><prompt><value expr="application.brand"/>: a number?</prompt><filled><value expr="n * 2"/>.</filled></field></form><form id="bye"><block>Bye from <value expr="brand"/>.</block></form>`, 'application="root.vxml"'),
    }, { main: "leaf.vxml" });
    expect(c.start().say).toEqual(["Acme: a number?"]);
    expect(c.say("banana").say).toEqual(["Say a number.", "Acme: a number?"]);
    expect(c.say("quit")).toMatchObject({ say: ["Bye from Acme."], end: "exit" });
  });

  it("VX2.10 a document-scoped form's grammar takes the person there from any dialog, filling it", () => {
    const c = call(
      vxml(`<form id="main"><field name="x" type="boolean"><prompt>Ready?</prompt></field><block>Ready.</block></form>
      <form id="weather" scope="document"><grammar root="w"><rule id="w">weather in <ruleref uri="#city"/><tag>out.city = rules.city</tag></rule><rule id="city"><one-of><item>paris</item><item>rome</item></one-of></rule></grammar>
        <field name="city"><prompt>Which city?</prompt><grammar root="c"><rule id="c">paris</rule></grammar><filled>Sunny in <value expr="city"/>.</filled></field></form>`),
    );
    c.start();
    expect(c.say("weather in rome")).toMatchObject({ say: ["Sunny in rome."], end: "exit" });
  });

  it("VX2.11 submit calls its tool and ends with the result; a tool named by an expression is called too", () => {
    const c = call(vxml(`<form><var name="x" expr="1"/><block><submit expr="'tool:save'" namelist="x"/></block></form>`));
    expect(c.start()).toMatchObject({ call: { tool: "save", input: { x: 1 } } });
    expect(c.result({ saved: true })).toMatchObject({ end: "exit", output: { saved: true } });
  });

  it("VX2.12 a field's shadow variable and lastresult$ keep what was said and how it was read; guarded items are skipped; disconnect ends", () => {
    const c = call(
      vxml(`<form><field name="n" type="number"><prompt>N?</prompt></field>
      <block cond="n &gt; 10">Big.</block>
      <block>You said <value expr="n$.utterance"/>, read as <value expr="application.lastresult$[0].interpretation"/>.<disconnect/></block></form>`),
    );
    c.start();
    expect(c.say("five")).toMatchObject({ say: ["You said five, read as 5."], end: "exit", output: null });
  });

  it("VX2.13 a form whose items are all done ends the application", () => {
    expect(call(vxml(`<form><block>Hi.</block></form>`)).start()).toMatchObject({ say: ["Hi."], end: "exit", output: null });
  });

  it("VX2.14 an error no handler takes fails the step, as does a document that never waits; a handler can take one", () => {
    expect(() => call(vxml(`<form><block><value expr="nope.x"/></block></form>`)).start()).toThrow(ScriptError);
    expect(() => call(vxml(`<form id="a"><block><goto next="#a"/></block></form>`)).start()).toThrow("never waits");
    expect(() => call(vxml(`<form><block><throw event="custom.thing"/></block></form>`)).start()).toThrow("custom.thing");
    expect(call(vxml(`<form><block><throw event="error.x"/></block><catch event="error">Oops.<exit/></catch></form>`)).start()).toMatchObject({ say: ["Oops."], end: "exit" });
  });

  it("VX2.15 SSML and audio in prompts are said as their text: audio's fallback, sub's alias, breaks as spaces", () => {
    expect(call(vxml(`<form><block><prompt><emphasis>Hello</emphasis><break/>there, <sub alias="doctor">Dr.</sub> <audio src="x.wav">(chime)</audio></prompt></block></form>`)).start().say).toEqual(["Hello there, doctor (chime)"]);
  });

  it("VX2.17 after a turn handed to the model the field still hears the next answer, and once it is filled the form goes on", () => {
    const c = call(vxml(`<form><field name="a" type="boolean"><prompt>A?</prompt></field><field name="b" type="boolean"><prompt>B?</prompt></field></form>`));
    c.start();
    expect(c.say("what is a?")).toMatchObject({ say: [], pass: true });
    expect(c.say("yes").say).toEqual(["B?"]);
  });

  it("VX2.18 a throw in a field's filled goes to that field's handlers first; after a handler the next item is selected as ever, so one that filled its field moves on", () => {
    const c = call(
      vxml(`<form>
        <field name="size"><prompt>Size?</prompt>${sizes}
          <filled><if cond="size == 'medium'"><throw event="sold.out"/></if></filled>
          <catch event="sold.out">No medium today, so large.<assign name="size" expr="'large'"/></catch>
          <nomatch>Small then.<assign name="size" expr="'small'"/></nomatch>
        </field>
        <field name="n" type="number"><prompt>How many <value expr="size"/>?</prompt></field>
        <catch event="sold">Wrong handler.<exit/></catch>
      </form>`),
    );
    c.start();
    expect(c.say("medium").say).toEqual(["No medium today, so large.", "How many large?"]);
    c.start();
    expect(c.say("huge").say).toEqual(["Small then.", "How many small?"]);
  });

  it("VX2.19 a goto in a subdialog stays in it: its return still returns to the caller", () => {
    const c = call({
      "main.vxml": vxml(`<form><subdialog name="r" src="sub.vxml"><filled>Got <value expr="r.x"/>.<exit/></filled></subdialog></form>`),
      "sub.vxml": vxml(`<form id="one"><block><goto next="#two"/></block></form><form id="two"><var name="x" expr="'it'"/><block><return namelist="x"/></block></form>`),
    }, { main: "main.vxml" });
    expect(c.start()).toMatchObject({ say: ["Got it."], end: "exit" });
  });

  it("VX2.20 a script error is error.semantic, and what cannot be fetched error.badfetch, events a document catches with the message; uncaught, the step fails", () => {
    const caught = (body: string) =>
      call(vxml(`<form>${body}<catch event="error.semantic">Semantic: <value expr="_message"/>.<exit/></catch><catch event="error.badfetch">Badfetch: <value expr="_message"/>.<exit/></catch></form>`)).start();
    expect(caught(`<block><value expr="nope.x"/></block>`)).toMatchObject({ say: ["Semantic: nope is not defined."], end: "exit" });
    expect(caught(`<block><goto next="missing.vxml"/></block>`)).toMatchObject({ say: ["Badfetch: missing.vxml is not among the documents."], end: "exit" });
    expect(caught(`<block cond="nope">Never.</block>`)).toMatchObject({ say: ["Semantic: nope is not defined."], end: "exit" });
    const linked = call(vxml(`<link next="gone.vxml"><grammar root="g"><rule id="g">go</rule></grammar></link><form><field name="f" type="boolean"><prompt>Yes?</prompt><catch event="error.badfetch">Not there.<reprompt/></catch></field></form>`));
    linked.start();
    expect(linked.say("go").say).toEqual(["Not there.", "Yes?"]);
    expect(() => call(vxml(`<form><block><goto next="missing.vxml"/></block></form>`)).start()).toThrow("error.badfetch: missing.vxml is not among the documents");
  });

  it("VX2.21 a tool that could not be called is error.badfetch where the body called it", () => {
    const c = call(vxml(`<form><block>Saving.<data name="r" src="tool:save"/>Saved.</block><catch event="error.badfetch">Could not: <value expr="_message"/>.<exit/></catch></form>`));
    expect(c.start()).toMatchObject({ say: ["Saving."], call: { tool: "save" } });
    const compiled = voiceXml.compile({ "app.vxml": vxml(`<form><block>Saving.<data name="r" src="tool:save"/>Saved.</block><catch event="error.badfetch">Could not: <value expr="_message"/>.<exit/></catch></form>`) }, {});
    expect(compiled.step({ state: c.state as never, error: "error.badfetch: no tool save" })).toMatchObject({ say: ["Could not: no tool save."], end: "exit" });
  });

  it("VX2.22 references are relative to the referring document: goto, subdialog, application roots and grammar files", () => {
    const c = call({
      "ivr/root.vxml": vxml(`<var name="brand" expr="'Acme'"/>`),
      "ivr/main/start.vxml": vxml(`<form><field name="size"><prompt><value expr="brand"/> size?</prompt><grammar src="../grammars/sizes.grxml"/><filled><goto next="../end.vxml#bye"/></filled></field></form>`, 'application="../root.vxml"'),
      "ivr/end.vxml": vxml(`<form id="bye"><subdialog name="s" src="parts/thanks.vxml"/><block>Bye.</block></form>`),
      "ivr/parts/thanks.vxml": vxml(`<form><block>Thanks.<return/></block></form>`),
      "ivr/grammars/sizes.grxml": `<?xml version="1.0"?>${sizes.replace("<grammar ", '<grammar xmlns="http://www.w3.org/2001/06/grammar" version="1.0" ')}`,
    }, { main: "ivr/main/start.vxml" });
    expect(c.start().say).toEqual(["Acme size?"]);
    expect(c.say("small")).toMatchObject({ say: ["Thanks.", "Bye."], end: "exit" });
  });

  it("VX2.23 a body that called a tool is still its item's: what it throws, or a tool that could not be called, goes to that field's handlers", () => {
    const doc = vxml(`<form>
      <field name="ok" type="boolean"><prompt>Save?</prompt>
        <filled><data name="r" src="tool:save"/><throw event="saved"/></filled>
        <catch event="error.badfetch">Field: not saved.<exit/></catch>
        <catch event="saved">Field: saved.<exit/></catch>
      </field>
      <catch event="error.badfetch saved">Form handler.<exit/></catch>
    </form>`);
    const c = call(doc);
    c.start();
    expect(c.say("yes")).toMatchObject({ call: { tool: "save" } });
    expect(c.result({ id: 1 })).toMatchObject({ say: ["Field: saved."], end: "exit" });
    const d = call(doc);
    d.start();
    d.say("yes");
    const compiled = voiceXml.compile({ "app.vxml": doc }, {});
    expect(compiled.step({ state: d.state as never, error: "error.badfetch: no tool save" })).toMatchObject({ say: ["Field: not saved."] });
  });

  it("VX2.24 an error in visiting an item (its prompt, a subdialog's src) goes to that item's handlers first", () => {
    const prompted = call(vxml(`<form><field name="f" type="boolean"><prompt><value expr="nope.x"/></prompt><catch event="error.semantic">Field handler.<exit/></catch></field><catch event="error">Form handler.<exit/></catch></form>`));
    expect(prompted.start()).toMatchObject({ say: ["Field handler."], end: "exit" });
    const sub = call(vxml(`<form><subdialog name="s" src="#missing"><catch event="error.badfetch">Subdialog handler.<exit/></catch></subdialog><catch event="error">Form handler.<exit/></catch></form>`));
    expect(sub.start()).toMatchObject({ say: ["Subdialog handler."], end: "exit" });
  });

  it("VX2.25 DTMF keys are the whole answer as typed, # and * among them; two choices with one key are refused", () => {
    const c = call(vxml(`<menu dtmf="true"><choice dtmf="#" next="#a">again</choice><choice dtmf="*" next="#b">operator</choice><choice next="#c">sales</choice></menu>
      <form id="a"><block>Again.</block></form><form id="b"><block>Operator.</block></form><form id="c"><block>Sales.</block></form>`));
    c.start();
    expect(c.say("#").say).toEqual(["Again."]);
    c.start();
    expect(c.say(" * ").say).toEqual(["Operator."]);
    c.start();
    expect(c.say("1").say).toEqual(["Sales."]);
    expect(() => call(vxml(`<menu dtmf="true"><choice next="#a">one</choice><choice dtmf="1" next="#a">two</choice></menu><form id="a"><block>A.</block></form>`))).toThrow("two choices with the key 1");
  });

  it("VX2.26 after a turn handed to the model, an empty answer is prompted again, as noinput always is", () => {
    const c = call(vxml(`<form><field name="a" type="boolean"><prompt>A?</prompt></field></form>`));
    c.start();
    expect(c.say("banana")).toMatchObject({ pass: true });
    expect(c.say("").say).toEqual(["A?"]);
  });

  it("VX2.27 an object's value is said as ECMAScript says it", () => {
    expect(call(vxml(`<form><var name="o" expr="({ a: 1 })"/><block>O is <value expr="o"/>.<exit/></block></form>`)).start()).toMatchObject({ say: ["O is [object Object]."] });
  });
});

describe("VoiceXML documents that cannot be run", () => {
  it("VX3.1 are refused at import, saying why", () => {
    const bad: [Record<string, string>, string][] = [
      [{ "a.vxml": `<form/>` }, "root is <vxml>"],
      [{ "a.vxml": vxml("") }, "no <form> or <menu>"],
      [{ "a.vxml": vxml(`<form><block><script>var x = 1;</script></block></form>`) }, "<script> is not supported"],
      [{ "a.vxml": vxml(`<form><record name="r"/></form>`) }, "<record> takes audio"],
      [{ "a.vxml": vxml(`<form><object name="o"/></form>`) }, "<object> runs platform code"],
      [{ "a.vxml": vxml(`<form><block><submit next="http://x"/></block></form>`) }, "only tool:<name>"],
      [{ "a.vxml": vxml(`<form><block><data name="d"/></block></form>`) }, "needs a tool:<name>"],
      [{ "a.vxml": vxml(`<form><field name="f"/></form>`) }, "has no grammar"],
      [{ "a.vxml": vxml(`<form><subdialog name="s"/></form>`) }, "needs a src"],
      [{ "a.vxml": vxml(`<form><field name="f" type="boolean"/><field name="f" type="boolean"/></form>`) }, "named twice"],
      [{ "a.vxml": vxml(`<form><field name="f" type="boolean"><link next="#x"><grammar src="builtin:boolean"/></link></field></form>`) }, "<link> in a <field>"],
      [{ "a.vxml": vxml(`<link next="#x"/><form/>`) }, "needs a grammar"],
      [{ "a.vxml": vxml(`<link><grammar src="builtin:boolean"/></link><form/>`) }, "needs next, expr, event"],
      [{ "a.vxml": vxml(`<form><field name="f"><grammar srcexpr="'x'"/></field></form>`) }, "srcexpr"],
      [{ "a.vxml": vxml(`<form><field name="f"><grammar src="missing.grxml"/></field></form>`) }, "not among the files"],
      [{ "a.vxml": vxml(`<form><field name="f"><grammar src="g.grxml#nope"/></field></form>`), "g.grxml": `<grammar root="r"><rule id="r">x</rule></grammar>` }, "has no such rule"],
      [{ "a.vxml": vxml(`<form><block><if/></block></form>`) }, "<if> needs cond"],
      [{ "a.vxml": vxml(`<form><block><prompt count="0">x</prompt></block></form>`) }, "count is a whole number"],
      [{ "a.vxml": vxml(`<form><catch event="x" count="0"/></form>`) }, "count is a whole number"],
      [{ "a.vxml": vxml(`<form><filled mode="some"/></form>`) }, 'mode="some"'],
      [{ "a.vxml": vxml(`<menu/>`) }, "has no <choice>"],
      [{ "a.vxml": vxml(`<menu><choice>x</choice></menu>`) }, "needs next, expr or event"],
      [{ "a.vxml": vxml(`<form><bogus/></form>`) }, "<bogus> is not supported in <form>"],
      [{ "a.vxml": vxml(`<form><block><bogus/></block></form>`) }, "<bogus> is not supported in executable content"],
      [{ "a.vxml": vxml(`<form/>`, 'application="root.vxml"') }, "application root root.vxml"],
      [{ "a.vxml": vxml(`<form/>`) }, "is not a VoiceXML document"],
      [{ "g.grxml": `<grammar root="r"><rule id="r">x</rule></grammar>` }, "no VoiceXML document"],
    ];
    for (const [files, message] of bad) {
      const main = Object.keys(files).find((f) => f.endsWith(".vxml"));
      const options = message === "is not a VoiceXML document" ? { main: "other.vxml" } : main ? { main } : {};
      expect(() => voiceXml.compile(files, options), message).toThrow(message);
    }
    expect(() => voiceXml.compile({ "a.vxml": "<vxml" }, {})).toThrow(DocumentError);
  });

  it("VX3.2 grammars come inline in XML or ABNF, from grammar files, or builtin; properties and logs are ignored", () => {
    const c = call({
      "app.vxml": vxml(`<property name="timeout" value="3s"/><form>
        <field name="a"><prompt>A?</prompt><grammar type="application/srgs">#ABNF 1.0; $a = alpha | beta;</grammar></field>
        <field name="b"><prompt>B?</prompt><grammar src="g.grxml"/></field>
        <field name="c"><prompt>C?</prompt><grammar src="g.gram#two"/></field>
        <field name="d"><prompt>D?</prompt><grammar src="builtin:grammar/boolean"/><filled><log>done</log><value expr="a + b + c + d"/></filled></field>
      </form>`),
      "g.grxml": `<grammar root="r"><rule id="r">gamma</rule></grammar>`,
      "g.gram": "#ABNF 1.0;\n$one = one;\n$two = two;",
    });
    c.start();
    c.say("beta");
    c.say("gamma");
    c.say("two");
    expect(c.say("yes").say).toEqual(["betagammatwotrue"]);
  });
});

/** What compiling the files refuses, as it says it. */
function refusal(files: Record<string, string>, options: Record<string, string> = {}): string | undefined {
  try {
    voiceXml.compile(files, options);
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
  return undefined;
}

describe("VoiceXML in detail, as the specification has it", () => {
  it("VX4.1 SSML and audio in a block's text are said with it, a value inside them too; an enumerate outside a field lists nothing", () => {
    const doc = vxml(`<var name="who" expr="'Ann'"/><form><block>Hello <emphasis>dear <value expr="who"/></emphasis><mark name="m"/>friend. <audio src="a.wav">Chime.</audio> <break/><sub alias="Doctor">Dr</sub> <prosody rate="slow">Slowly</prosody> <say-as interpret-as="digits">12</say-as> <voice gender="female">Voiced</voice> <p><s>Sentence.</s></p> <s>Alone.</s> <phoneme ph="t">Tomato</phoneme> <lang xml:lang="fr">Oui</lang><enumerate/><enumerate>Item <value expr="_prompt"/>.</enumerate></block></form>`);
    expect(call(doc).start().say).toEqual(["Hello dear Ann friend. Chime. Doctor Slowly 12 Voiced Sentence. Alone. Tomato Oui"]);
  });

  it("VX4.2 whitespace between executable content is not said, and what is said after it is", () => {
    expect(call(vxml(`<form><block> <value expr="'A'"/> <assign name="x" expr="1"/> </block><var name="x"/></form>`)).start().say).toEqual(["A"]);
  });

  it("VX4.3 a prompt's whitespace runs are one space; a prompt that renders to nothing, an undefined value's, is not said", () => {
    const doc = vxml(`<form><var name="nothing"/><block><prompt>Hello,
          there.</prompt><prompt> <value expr="nothing"/> </prompt><prompt>Bye.</prompt></block></form>`);
    expect(call(doc).start().say).toEqual(["Hello, there.", "Bye."]);
  });

  it("VX4.4 a prompt with a cond is said only when it holds, in a field and in executable content", () => {
    const c = call(vxml(`<form><field name="f" type="boolean"><prompt cond="false">Never.</prompt><prompt cond="1 &lt; 2">Ready?</prompt>
      <filled><prompt cond="f">Yes it is.</prompt><prompt cond="!f">No it is not.</prompt></filled></field></form>`));
    expect(c.start().say).toEqual(["Ready?"]);
    expect(c.say("yes").say).toEqual(["Yes it is."]);
  });

  it("VX4.5 noinput, help and error elements are handlers of their events, and a handler that does not reprompt leaves its item unprompted", () => {
    const c = call(vxml(`<link event="help"><grammar root="h"><rule id="h">help</rule></grammar></link>
      <form><field name="f" type="boolean"><prompt>Ready?</prompt><noinput>Say yes or no.</noinput><help>Yes means go.</help><filled><value expr="nope.x"/></filled></field><error>Something went wrong.<exit/></error></form>`));
    expect(c.start().say).toEqual(["Ready?"]);
    expect(c.say("").say).toEqual(["Say yes or no."]);
    expect(c.say("help").say).toEqual(["Yes means go."]);
    expect(c.say("yes")).toMatchObject({ say: ["Something went wrong."], end: "exit" });
  });

  it("VX4.6 a catch without an event catches every event", () => {
    expect(call(vxml(`<form><block><throw event="anything.at.all"/></block><catch>Caught <value expr="_event"/>.<exit/></catch></form>`)).start().say).toEqual(["Caught anything.at.all."]);
  });

  it("VX4.7 a catch of several events catches each of them", () => {
    expect(call(vxml(`<form><block><throw event="second"/></block><catch event=" first  second ">Caught <value expr="_event"/>.<exit/></catch></form>`)).start().say).toEqual(["Caught second."]);
  });

  it("VX4.8 a link goes where its expr says, or throws the event its eventexpr names, when any of its grammars takes the answer", () => {
    const doc = vxml(`<link expr="'#' + 'two'"><grammar root="a"><rule id="a">alpha</rule></grammar><grammar root="b"><rule id="b">beta</rule></grammar></link>
      <link eventexpr="'my' + '.event'"><grammar root="c"><rule id="c">gamma</rule></grammar></link>
      <form><field name="f" type="boolean"><prompt>Ready?</prompt><catch event="my">Caught <value expr="_event"/>.<exit/></catch></field></form>
      <form id="two"><block>Two.</block></form>`);
    const c = call(doc);
    c.start();
    expect(c.say("beta").say).toEqual(["Two."]);
    c.start();
    expect(c.say("gamma").say).toEqual(["Caught my.event."]);
  });

  it("VX4.9 a form's own link is active in its fields", () => {
    const c = call(vxml(`<form><link next="#two"><grammar root="g"><rule id="g">skip</rule></grammar></link><field name="f" type="boolean"><prompt>Ready?</prompt></field></form><form id="two"><block>Two.</block></form>`));
    c.start();
    expect(c.say("skip").say).toEqual(["Two."]);
  });

  it("VX4.10 in a modal field only its own grammars are active", () => {
    const c = call(vxml(`<link next="#out"><grammar root="q"><rule id="q">quit</rule></grammar></link>
      <form><field name="pin" type="digits" modal="true"><prompt>PIN?</prompt></field><field name="ok" type="boolean"><prompt>OK?</prompt></field></form><form id="out"><block>Out.</block></form>`));
    expect(c.start().say).toEqual(["PIN?"]);
    expect(c.say("quit")).toMatchObject({ say: [], pass: true });
    expect(c.say("12").say).toEqual(["OK?"]);
    expect(c.say("quit").say).toEqual(["Out."]);
  });

  it("VX4.11 a var in executable content is declared in the body's scope, with its expr's value or undefined", () => {
    expect(call(vxml(`<form><block><var name="x" expr="2"/><var name="y"/>X is <value expr="x * 3"/>, y is <value expr="typeof y"/>.</block></form>`)).start().say).toEqual(["X is 6, y is undefined."]);
  });

  it("VX4.12 clear forgets the fields its namelist names, or every form item without one; a name never declared is error.semantic", () => {
    const doc = vxml(`<form><field name="a" type="digits"><prompt>A?</prompt></field><field name="b" type="digits"><prompt>B?</prompt></field>
      <field name="c" type="digits"><prompt>C?</prompt>
        <filled><if cond="c == '1'"><clear namelist=" a   b "/><elseif cond="c == '2'"/><clear/><else/><clear namelist="nope"/></if></filled></field>
      <catch event="error.semantic">Error: <value expr="_message"/>.<exit/></catch></form>`);
    const c = call(doc);
    c.start();
    c.say("1");
    c.say("1");
    expect(c.say("1").say).toEqual(["A?"]);
    expect(c.say("1").say).toEqual(["B?"]);
    expect(c.say("1")).toMatchObject({ say: [], end: "exit" });
    c.start();
    c.say("1");
    c.say("1");
    expect(c.say("2").say).toEqual(["A?"]);
    c.say("1");
    expect(c.say("1").say).toEqual(["C?"]);
    c.start();
    c.say("1");
    c.say("1");
    expect(c.say("3")).toMatchObject({ say: ["Error: nope is not declared."], end: "exit" });
  });

  it("VX4.13 an if whose conditions all fail runs nothing, and the body goes on after it", () => {
    expect(call(vxml(`<form><block><if cond="false">No.<elseif cond="1 &gt; 2"/>Nor this.</if>Yes.</block></form>`)).start().say).toEqual(["Yes."]);
  });

  it("VX4.14 an event's count is its item's, and a clear of the item starts it again", () => {
    const c = call(vxml(`<form>
      <field name="a" type="digits"><prompt>A?</prompt></field>
      <field name="b" type="digits"><prompt>B?</prompt><filled><if cond="b == '0'"><clear namelist="a"/><goto nextitem="b"/></if></filled></field>
      <nomatch>Miss one.</nomatch><nomatch count="2">Miss two.</nomatch>
    </form>`));
    expect(c.start().say).toEqual(["A?"]);
    expect(c.say("x").say).toEqual(["Miss one."]);
    expect(c.say("5").say).toEqual(["B?"]);
    expect(c.say("x").say).toEqual(["Miss one."]);
    expect(c.say("x").say).toEqual(["Miss two."]);
    expect(c.say("0").say).toEqual(["B?"]);
    // b is filled, so the form goes on to a, asked again from its first prompt, and its count starts again.
    expect(c.say("x").say).toEqual(["Miss two.", "A?"]);
    expect(c.say("x").say).toEqual(["Miss one."]);
  });

  it("VX4.15 data from a srcexpr calls the tool it names, and its result goes into the variable declared with its name", () => {
    const c = call(vxml(`<form><var name="r"/><var name="q" expr="'x'"/><block><data name="r" srcexpr="'tool:' + 'lookup'" namelist="q"/></block><block>Got <value expr="r.id"/>.</block></form>`));
    expect(c.start()).toMatchObject({ say: [], call: { tool: "lookup", input: { q: "x" } } });
    expect(c.result({ id: 7 }).say).toEqual(["Got 7."]);
  });

  it("VX4.16 exit ends with null, or with the values its namelist names", () => {
    const bye = call(vxml(`<form><block>Bye.<exit/></block><block>Never.</block></form>`)).start();
    expect(bye).toMatchObject({ say: ["Bye."], end: "exit" });
    expect(bye.output).toBeNull();
    expect(call(vxml(`<form><var name="a" expr="1"/><var name="b" expr="'two'"/><block><exit namelist=" a  b "/></block></form>`)).start().output).toEqual({ a: 1, b: "two" });
  });

  it("VX4.17 return throws the event its eventexpr names in the calling item", () => {
    const doc = vxml(`<form><subdialog name="s" src="#sub"><catch event="sub.done">Caught <value expr="_event"/>.<exit/></catch></subdialog></form><form id="sub"><block><return eventexpr="'sub.' + 'done'"/></block></form>`);
    expect(call(doc).start().say).toEqual(["Caught sub.done."]);
  });

  it("VX4.18 a return outside a subdialog is error.semantic", () => {
    expect(call(vxml(`<form><block><return/></block><catch event="error.semantic">Error: <value expr="_message"/>.<exit/></catch></form>`)).start().say).toEqual(["Error: <return> outside a subdialog."]);
  });

  it("VX4.19 throw takes its event and message from expressions; a throw without an event is error.semantic", () => {
    expect(call(vxml(`<form><var name="n" expr="2"/><block><throw eventexpr="'err.' + n" messageexpr="'number ' + n"/></block><catch event="err.2">Caught <value expr="_event"/>: <value expr="_message"/>.<exit/></catch></form>`)).start().say).toEqual(["Caught err.2: number 2."]);
    expect(call(vxml(`<form><block><throw/></block><catch event="error.semantic">Error: <value expr="_message"/>.<exit/></catch></form>`)).start().say).toEqual(["Error: <throw> needs an event."]);
  });

  it("VX4.20 disconnect ends the application at once", () => {
    const r = call(vxml(`<form><block>Bye.<disconnect/>Never.</block><block>Nor this.</block></form>`)).start();
    expect(r).toMatchObject({ say: ["Bye."], end: "exit" });
    expect(r.output).toBeNull();
  });

  it("VX4.21 meta, metadata and log are ignored wherever they are", () => {
    expect(call(vxml(`<meta name="author" content="me"/><metadata/><form><meta name="x" content="y"/><metadata/><block>Hi.<log>logged</log></block></form>`)).start().say).toEqual(["Hi."]);
  });

  it("VX4.22 a block with an expr is done already; a block visited is true", () => {
    expect(call(vxml(`<form><block name="skipped" expr="true">Never.</block><block name="hello">Hi.</block><block>Hello is <value expr="hello"/>, skipped is <value expr="skipped"/>.</block></form>`)).start().say).toEqual(["Hi.", "Hello is true, skipped is true."]);
  });

  it("VX4.23 a field's options are enumerated by their text, with their keys; only an approximate option takes some of its words", () => {
    const c = call(vxml(`<form><field name="drink"><prompt>We have <enumerate/>.</prompt><prompt><enumerate>For <value expr="_prompt"/> press <value expr="_dtmf"/>.</enumerate></prompt>
      <option dtmf="1" value="coffee">  black coffee  </option><option accept="approximate"> green tea </option><filled>A <value expr="drink"/>.</filled></field></form>`));
    expect(c.start().say).toEqual(["We have black coffee, green tea.", "For black coffee press 1. For green tea press ."]);
    expect(c.say("tea").say).toEqual(["A green tea."]);
    c.start();
    expect(c.say("coffee")).toMatchObject({ pass: true });
    expect(c.say("1").say).toEqual(["A coffee."]);
  });

  it("VX4.24 a param's value is a string as written, and an empty one without expr or value", () => {
    const doc = vxml(`<form><subdialog name="s" src="#sub"><param name="a" value="literal"/><param name="b"/><param name="c" expr="1 + 1"/><filled><value expr="s.out"/>.<exit/></filled></subdialog></form>
      <form id="sub"><var name="a"/><var name="b"/><var name="c"/><var name="out"/><block><assign name="out" expr="a + '|' + b + '|' + c"/><return namelist="out"/></block></form>`);
    expect(call(doc).start().say).toEqual(["literal||2."]);
  });

  it("VX4.25 what is refused names the file and the element, and where it is", () => {
    expect(refusal({ "a.vxml": vxml(`<bogus/><form/>`) })).toBe("DocumentError: a.vxml: <bogus> is not supported in <vxml>");
    expect(refusal({ "a.vxml": vxml(`<form><field name="f" type="boolean"><bogus/></field></form>`) })).toBe("DocumentError: a.vxml: <bogus> is not supported in <field>");
    expect(refusal({ "a.vxml": vxml(`<menu><choice next="#a">x</choice><bogus/></menu>`) })).toBe("DocumentError: a.vxml: <bogus> is not supported in <menu>");
    expect(refusal({ "a.vxml": vxml(`<form><field name="f"><grammar root="r"><rule id="r"><ruleref uri="#nope"/></rule></grammar></field></form>`) })).toBe("DocumentError: rule a.vxml#grammar-1#nope is not defined");
  });

  it("VX4.26 a subdialog's src can be an expression", () => {
    const doc = vxml(`<form><var name="target" expr="'#sub'"/><subdialog name="s" srcexpr="target"><filled>Got <value expr="s.x"/>.<exit/></filled></subdialog></form><form id="sub"><var name="x" expr="'it'"/><block><return namelist="x"/></block></form>`);
    expect(call(doc).start().say).toEqual(["Got it."]);
  });

  it("VX4.27 a field whose cond fails, or whose expr gives it a value, is not visited", () => {
    expect(call(vxml(`<form><field name="a" type="boolean" cond="false"><prompt>A?</prompt></field><field name="b" type="boolean" expr="true"><prompt>B?</prompt></field><field name="c" type="boolean"><prompt>C?</prompt></field></form>`)).start().say).toEqual(["C?"]);
  });

  it("VX4.28 a field takes its slot's property of the interpretation, else all of it, null among interpretations", () => {
    const doc = vxml(`<form><field name="dest" slot="city"><prompt>Where?</prompt>
      <grammar root="r"><rule id="r"><one-of><item>paris<tag>out.city = 'Paris'; out.country = 'FR'</tag></item><item>somewhere<tag>out.country = 'XX'</tag></item><item>nowhere<tag>out = null</tag></item></one-of></rule></grammar>
      <filled>To <value expr="dest === null ? 'null' : typeof dest == 'object' ? dest.country : dest"/>.<exit/></filled></field></form>`);
    const c = call(doc);
    c.start();
    expect(c.say("paris").say).toEqual(["To Paris."]);
    c.start();
    expect(c.say("somewhere").say).toEqual(["To XX."]);
    c.start();
    expect(c.say("nowhere").say).toEqual(["To null."]);
  });

  it("VX4.29 a second unnamed form is resumed as itself, entered by its document-scoped grammar; an answer no grammar takes does not enter it", () => {
    const c = call(vxml(`<form><field name="x" type="boolean"><prompt>Ready?</prompt><filled>Ready.</filled></field></form>
      <form scope="document"><grammar root="w"><rule id="w">weather</rule></grammar><field name="city"><prompt>Which city?</prompt><grammar root="c"><rule id="c"><one-of><item>paris</item><item>rome</item></one-of></rule></grammar><filled>Sunny in <value expr="city"/>.</filled></field></form>`));
    expect(c.start().say).toEqual(["Ready?"]);
    expect(c.say("banana")).toMatchObject({ say: [], pass: true });
    expect(c.say("weather").say).toEqual(["Which city?"]);
    // The dialog entered replaces the one the person was in.
    expect((c.state as { frames: unknown[] }).frames).toHaveLength(1);
    expect(c.say("rome")).toMatchObject({ say: ["Sunny in rome."], end: "exit" });
  });

  it("VX4.30 a form's filled runs by its mode and namelist: any of them, all of them, or all the form's fields and subdialogs", () => {
    const c = call(vxml(`<form><field name="a" type="digits"><prompt>A?</prompt></field><field name="b" type="digits"><prompt>B?</prompt></field><block>Done.</block>
      <filled mode="any" namelist="a b">Any.</filled><filled namelist=" a  b ">Both.</filled><filled>All.</filled></form>`));
    expect(c.start().say).toEqual(["A?"]);
    expect(c.say("1").say).toEqual(["Any.", "B?"]);
    expect(c.say("2").say).toEqual(["Any.", "Both.", "All.", "Done."]);
    const sub = call(vxml(`<form><subdialog name="s" src="#sub"/><filled>Filled <value expr="s.x"/>.</filled></form><form id="sub"><var name="x" expr="1"/><block><return namelist="x"/></block></form>`));
    expect(sub.start()).toMatchObject({ say: ["Filled 1."], end: "exit" });
  });

  it("VX4.31 a form's grammar without scope document is not active in other dialogs", () => {
    const c = call(vxml(`<form><field name="x" type="boolean"><prompt>Ready?</prompt></field></form>
      <form id="w"><grammar root="w"><rule id="w">weather in <ruleref uri="#c"/><tag>out.city = rules.c</tag></rule><rule id="c"><one-of><item>paris</item><item>rome</item></one-of></rule></grammar><field name="city"><prompt>City?</prompt><grammar src="builtin:boolean"/></field></form>`));
    c.start();
    expect(c.say("weather in rome")).toMatchObject({ say: [], pass: true });
  });

  it("VX4.32 a form grammar's interpretation fills only the fields it names: one naming none, a string or null is a nomatch", () => {
    const c = call(vxml(`<form id="f" scope="document"><grammar root="g"><rule id="g"><one-of><item>plain</item><item>nothing<tag>out = null</tag></item><item>other<tag>out.other = 1</tag></item></one-of></rule></grammar>
      <field name="x" type="boolean"><prompt>Ready?</prompt></field></form>`));
    c.start();
    expect(c.say("plain")).toMatchObject({ say: [], pass: true });
    expect(c.say("nothing")).toMatchObject({ say: [], pass: true });
    expect(c.say("other")).toMatchObject({ say: [], pass: true });
  });

  it("VX4.33 entered by its grammar, a form's initial is done, the fields filled keep what was said, and only their filled actions run", () => {
    const c = call(vxml(`<form><field name="q" type="boolean"><prompt>Ready?</prompt></field></form>
      <form id="trip" scope="document">
        <grammar root="t"><rule id="t">from <ruleref uri="#c"/><tag>out.from = rules.c</tag></rule><rule id="c"><one-of><item>boston</item><item>denver</item></one-of></rule></grammar>
        <initial name="start"><prompt>Where from and to?</prompt></initial>
        <field name="from"><prompt>From?</prompt><grammar src="builtin:boolean"/><filled>From <value expr="from$.interpretation"/>, said as <value expr="from$.utterance"/> by <value expr="from$.inputmode"/>.</filled></field>
        <field name="to"><prompt>To?</prompt><grammar src="builtin:boolean"/><filled>To filled.</filled></field>
      </form>`));
    c.start();
    expect(c.say("from denver").say).toEqual(["From denver, said as from denver by voice.", "To?"]);
  });

  it("VX4.34 a menu is gone to by its id; without dtmf its choices have no keys; its text is trimmed; a choice's expr says where; its handlers take its events", () => {
    const c = call(vxml(`<form><block><goto next="#main"/></block></form>
      <menu id="main"><prompt>Say <enumerate/>.</prompt><choice expr="'#' + 'a'">  sales  </choice><choice next="#b">technical support</choice><nomatch>Say sales or technical support.<reprompt/></nomatch></menu>
      <form id="a"><block>Sales.</block></form><form id="b"><block>Support.</block></form>`));
    expect(c.start().say).toEqual(["Say sales, technical support."]);
    expect(c.say("1").say).toEqual(["Say sales or technical support.", "Say sales, technical support."]);
    expect(c.say("support").say).toEqual(["Say sales or technical support.", "Say sales, technical support."]);
    expect(c.say("sales").say).toEqual(["Sales."]);
  });

  it("VX4.35 with dtmf only a menu's first nine choices without keys are numbered", () => {
    const choices = Array.from({ length: 10 }, (_, i) => `<choice next="#c${i + 1}">c${i + 1}</choice>`).join("");
    const forms = Array.from({ length: 10 }, (_, i) => `<form id="c${i + 1}"><block>C${i + 1}.</block></form>`).join("");
    const c = call(vxml(`<menu dtmf="true"><prompt><enumerate><value expr="_prompt"/>=<value expr="_dtmf"/></enumerate></prompt>${choices}</menu>${forms}`));
    expect(c.start().say).toEqual(["c1=1 c2=2 c3=3 c4=4 c5=5 c6=6 c7=7 c8=8 c9=9 c10="]);
    expect(c.say("9").say).toEqual(["C9."]);
    c.start();
    expect(c.say("10")).toMatchObject({ say: [], pass: true });
  });

  it("VX4.36 an approximate menu: a key said with punctuation, a choice by any of its grammars; words none of its choices has, or none at all, are no choice", () => {
    const c = call(vxml(`<menu accept="approximate" dtmf="true"><choice next="#a"><grammar root="x"><rule id="x">alpha</rule></grammar><grammar root="y"><rule id="y">beta</rule></grammar>first</choice><choice next="#b">second option</choice></menu>
      <form id="a"><block>A.</block></form><form id="b"><block>B.</block></form>`));
    c.start();
    expect(c.say("beta").say).toEqual(["A."]);
    c.start();
    expect(c.say("2.").say).toEqual(["B."]);
    c.start();
    expect(c.say("option").say).toEqual(["B."]);
    c.start();
    expect(c.say("gamma")).toMatchObject({ say: [], pass: true });
    expect(c.say("?!")).toMatchObject({ say: [], pass: true });
  });

  it("VX4.37 a document-scoped menu is chosen from in any dialog, and the document's links are active in a menu", () => {
    const c = call(vxml(`<link next="#out"><grammar root="q"><rule id="q">quit</rule></grammar></link>
      <form><field name="x" type="boolean"><prompt>Ready?</prompt></field></form>
      <menu id="m" scope="document"><prompt>Menu.</prompt><choice next="#a">apples</choice></menu>
      <form id="a"><block>Apples.</block></form><form id="out"><block>Out.</block></form>`));
    c.start();
    expect(c.say("apples").say).toEqual(["Apples."]);
    const menu = call(vxml(`<link next="#out"><grammar root="q"><rule id="q">quit</rule></grammar></link><menu><prompt>Menu.</prompt><choice next="#a">apples</choice></menu>
      <form id="a"><block>Apples.</block></form><form id="out"><block>Out.</block></form>`));
    expect(menu.start().say).toEqual(["Menu."]);
    expect(menu.say("quit").say).toEqual(["Out."]);
  });

  it("VX4.38 only .vxml files are documents and only grammar files are grammars; the main document is the first .vxml", () => {
    const files = { "notes.vxml.orig": "not xml", "a.vxml": vxml(`<form><field name="f"><prompt>F?</prompt><grammar src="g.grxml"/></field></form>`), "g.grxml": `<grammar root="r"><rule id="r">go</rule></grammar>`, "g.grxml.orig": "not a grammar" };
    const c = call(files);
    expect(c.start().say).toEqual(["F?"]);
    expect(isVoiceXmlFile("a.VXML")).toBe(true);
    expect(isVoiceXmlFile("g.gram")).toBe(true);
    expect(isVoiceXmlFile("g.grxml.orig")).toBe(false);
    expect(isVoiceXmlFile("a.vxml.orig")).toBe(false);
  });

  it("VX4.39 compiled without options, an answer no grammar takes is the model's", () => {
    const { compiled } = compileVoiceXml({ "a.vxml": vxml(`<form><field name="f" type="boolean"><prompt>F?</prompt></field></form>`) }, "a.vxml");
    const started = stepVoiceXml(compiled, { state: null });
    expect(stepVoiceXml(compiled, { state: started.state, utterance: "banana" })).toMatchObject({ say: [], pass: true });
  });

  it("VX4.40 document variables see those before them and the application's; one declared without a value stays declared across JSON state", () => {
    const compiled = voiceXml.compile({
      "root.vxml": vxml(`<var name="brand" expr="'Acme'"/>`),
      "leaf.vxml": vxml(`<var name="greeting" expr="'Hi from ' + brand"/><var name="loud" expr="greeting + '!'"/><var name="later"/>
        <form><var name="n"/><field name="a" type="boolean"><prompt><value expr="loud"/> A?</prompt><filled><assign name="n" expr="a ? 1 : 2"/><assign name="later" expr="n + 1"/>N is <value expr="n"/>, later <value expr="later"/>.</filled></field></form>`, 'application="root.vxml"'),
    }, { main: "leaf.vxml" });
    const json = (r: StepResult) => JSON.parse(JSON.stringify(r.state)) as never;
    const started = compiled.step({ state: null });
    expect(started.say).toEqual(["Hi from Acme! A?"]);
    expect(compiled.step({ state: json(started), utterance: "yes" }).say).toEqual(["N is 1, later 2."]);
  });

  it("VX4.41 the state is each frame's JSON: its dialog, scopes, prompt and event counts, and the body under way with where it stopped", () => {
    const c = call(vxml(`<menu><choice next="#f">go</choice></menu>
      <form id="f"><var name="v"/><block> <log>starting</log> <data src="tool:first"/> <data name="r" src="tool:second"/> <exit/></block></form>`));
    const empty = { vars: {}, unset: [] };
    expect(c.start().state).toEqual({ app: empty, frames: [{ file: "app.vxml", dialog: "_menu0", doc: empty, vars: { vars: {}, unset: ["_menu"] }, prompts: { _menu: 1 }, events: {}, queue: [] }], waiting: "_menu" });
    const app = { vars: { lastresult$: [{ utterance: "go", interpretation: "0", confidence: 1, inputmode: "voice" }] }, unset: [] };
    const frame = (path: number[], scope: unknown) => ({ file: "app.vxml", dialog: "f", doc: empty, vars: { vars: { _block1: true }, unset: ["v"] }, prompts: {}, events: {}, queue: [{ body: 0, path, scope, item: "_block1" }] });
    expect(c.say("go").state).toEqual({ app, frames: [frame([1], empty)], calling: { exit: false } });
    expect(c.result({ a: 1 }).state).toEqual({ app, frames: [frame([2], empty)], calling: { into: "r", exit: false } });
    expect(c.result({ b: 2 })).toEqual({ say: [], state: { app, frames: [frame([2], { vars: { r: { b: 2 } }, unset: [] })] }, end: "exit", output: null });
  });

  it("VX4.42 a transfer's item is true in the state it ends with", () => {
    expect(call(vxml(`<form><transfer name="t"><prompt>Transferring.</prompt></transfer></form>`)).start()).toMatchObject({ say: ["Transferring."], end: "transfer", state: { frames: [{ vars: { vars: { t: true } } }] } });
  });

  it("VX4.43 a goto to an item the form does not have is error.badfetch", () => {
    expect(call(vxml(`<form><block><goto nextitem="nope"/></block><catch event="error.badfetch">Error: <value expr="_message"/>.<exit/></catch></form>`)).start().say).toEqual(["Error: no form item nope."]);
  });

  it("VX4.44 a goto to another document starts its first dialog with that document's variables only", () => {
    const c = call({
      "app.vxml": vxml(`<var name="mine" expr="'app'"/><form><block><goto next="next.vxml#"/></block></form>`),
      "next.vxml": vxml(`<form><block><value expr="mine"/></block><catch event="error.semantic">No <value expr="_message"/>.<exit/></catch></form><form id="other"><block>Wrong.</block></form>`),
    });
    expect(c.start().say).toEqual(["No mine is not defined."]);
  });

  it("VX4.45 a document may take a thousand actions between two answers, and no more", () => {
    const looping = (n: number) =>
      call(vxml(`<form><var name="i" expr="0"/><subdialog name="s" src="#sub"/><block name="b"><assign name="i" expr="i + 1"/><if cond="i &lt; ${n}"><goto nextitem="b"/></if></block><field name="f" type="boolean"><prompt>Done.</prompt></field></form><form id="sub"><block><return/></block></form>`));
    // A subdialog and its return take three actions, each round of the block two, and the field one: 3 + 2 * 498 + 1.
    expect(looping(498).start().say).toEqual(["Done."]);
    expect(() => looping(499).start()).toThrow("error.semantic: the document never waits for input");
  });

  it("VX4.46 an error in a body stops it there: its handler runs, and the form goes on", () => {
    const c = call(vxml(`<form><var name="x"/><block>One.<assign name="x" expr="nope.x"/>Never.</block><block>Two.<goto next="missing.vxml"/>Nor this.</block><field name="f" type="boolean"><prompt>Ready?</prompt></field><catch event="error">Caught <value expr="_event"/>.</catch></form>`));
    expect(c.start().say).toEqual(["One.", "Caught error.semantic.", "Two.", "Caught error.badfetch.", "Ready?"]);
  });

  it("VX4.47 a subdialog in the same document shares its variables; one in another document has that document's own", () => {
    const c = call({
      "main.vxml": vxml(`<var name="v" expr="'main'"/><form><block><assign name="v" expr="'changed'"/></block>
        <subdialog name="same" src="#here"><filled>Same saw <value expr="same.seen"/>.</filled></subdialog>
        <subdialog name="other" src="sub.vxml#"><filled>Other saw <value expr="other.seen"/>, here v is <value expr="v"/>.<exit/></filled></subdialog></form>
        <form id="here"><var name="seen"/><block><assign name="seen" expr="v"/><return namelist="seen"/></block></form>`),
      "sub.vxml": vxml(`<var name="v" expr="'sub'"/><form><var name="seen"/><block><assign name="seen" expr="v"/><return namelist="seen"/></block></form>`),
    }, { main: "main.vxml" });
    expect(c.start().say).toEqual(["Same saw changed.", "Other saw sub, here v is changed."]);
  });

  it("VX4.48 by default noinput reprompts the item waiting, and so does nomatch when set to reprompt, though an earlier item is unfilled", () => {
    const doc = vxml(`<form><block><goto nextitem="b"/></block><field name="a" type="boolean"><prompt>A?</prompt></field><field name="b" type="boolean"><prompt>B?</prompt></field></form>`);
    const c = call(doc, { nomatch: "reprompt" });
    expect(c.start().say).toEqual(["B?"]);
    expect(c.say("").say).toEqual(["B?"]);
    expect(c.say("maybe").say).toEqual(["Sorry, I didn't understand.", "B?"]);
  });

  it("VX4.49 noinput and nomatch thrown outside any item go on to the next item, whatever nomatch is set to; help from a waiting item is the model's even with nomatch set to reprompt", () => {
    const doc = vxml(`<link event="help"><grammar root="h"><rule id="h">help</rule></grammar></link>
      <form><field name="a" type="boolean"><prompt>A?</prompt></field><field name="b" type="boolean"><prompt>B?</prompt></field>
      <filled mode="any" namelist="a"><if cond="a"><throw event="noinput"/><else/><throw event="nomatch"/></if></filled></form>`);
    const c = call(doc, { nomatch: "reprompt" });
    c.start();
    expect(c.say("help")).toMatchObject({ say: [], pass: true });
    expect(c.say("yes").say).toEqual(["B?"]);
    c.start();
    expect(c.say("no").say).toEqual(["Sorry, I didn't understand.", "B?"]);
    // With nomatch the model's too, one thrown outside any item goes on: no item waits to hand the turn from.
    const model = call(doc);
    model.start();
    expect(model.say("no").say).toEqual(["B?"]);
    expect(model.say("yes")).toMatchObject({ end: "exit" });
  });

  it("VX4.50 cancel with no handler is ignored and does not reprompt a quiet item; exit and connection.disconnect end the application; any other event fails the step", () => {
    const doc = vxml(`<link event="cancel"><grammar root="c"><rule id="c">cancel</rule></grammar></link>
      <link event="connection.disconnect.hangup"><grammar root="b"><rule id="b">bye</rule></grammar></link>
      <link event="exit"><grammar root="x"><rule id="x">stop</rule></grammar></link>
      <form><field name="a" type="boolean"><prompt>A?</prompt></field></form>`);
    const c = call(doc);
    c.start();
    expect(c.say("banana")).toMatchObject({ say: [], pass: true });
    expect(c.say("cancel").say).toEqual([]);
    const bye = c.say("bye");
    expect(bye).toMatchObject({ say: [], end: "exit" });
    expect(bye.output).toBeNull();
    c.start();
    expect(c.say("stop")).toMatchObject({ say: [], end: "exit" });
    expect(() => call(vxml(`<form><block><throw event="custom.thing"/></block></form>`)).start()).toThrow(/^custom\.thing$/);
  });

  it("VX4.51 noinput thrown in a field's filled asks that field again, even after a tool the form's filled calls", () => {
    const c = call(vxml(`<form><field name="a" type="digits"><prompt>A?</prompt><filled><if cond="a == '0'"><throw event="noinput"/></if></filled></field><field name="b" type="digits"><prompt>B?</prompt></field>
      <filled mode="any" namelist="a"><data name="r" src="tool:log"/></filled></form>`));
    c.start();
    expect(c.say("0")).toMatchObject({ call: { tool: "log" } });
    expect(c.result(null).say).toEqual(["A?"]);
  });

  it("VX4.52 what a handler throws goes to its item's handlers first", () => {
    const c = call(vxml(`<form><field name="a" type="boolean"><prompt>A?</prompt><filled><throw event="first"/></filled><catch event="first"><throw event="second"/></catch><catch event="second">Field caught second.<exit/></catch></field><catch event="second">Form caught second.<exit/></catch></form>`));
    c.start();
    expect(c.say("yes").say).toEqual(["Field caught second."]);
  });

  it("VX4.53 a script's slots fill only fields, and a field with no slot keeps its expr", () => {
    const c = call(vxml(`<form><block name="greeting">Hello.</block><field name="a" type="boolean" expr="'preset'"><prompt>A?</prompt></field><field name="b" type="boolean"><prompt>B?</prompt></field><block>A is <value expr="a"/>, b is <value expr="b"/>.</block></form>`));
    expect(c.start({ greeting: "x", b: "given" }).say).toEqual(["Hello.", "A is preset, b is given."]);
  });

  it("VX4.54 a tool error that names no event is error.semantic with all its text", () => {
    const c = call(vxml(`<form><block><data name="r" src="tool:save"/></block><catch event="error">Caught <value expr="_event"/>: <value expr="_message"/>.<exit/></catch></form>`));
    c.start();
    expect(c.error("save failed: error.badfetch: disk").say).toEqual(["Caught error.semantic: save failed: error.badfetch: disk."]);
  });

  it("VX4.55 a step hears its utterance, none being noinput, and takes an error only after calling a tool", () => {
    const compiled = voiceXml.compile({ "app.vxml": vxml(`<form><field name="a" type="boolean"><prompt>A?</prompt><noinput>Nothing heard.</noinput><filled>A is <value expr="a"/>.</filled></field></form>`) }, {});
    const started = compiled.step({ state: null });
    expect(compiled.step({ state: started.state }).say).toEqual(["Nothing heard."]);
    expect(compiled.step({ state: started.state, utterance: "yes", error: "error.badfetch: stray" }).say).toEqual(["A is true."]);
  });

  it("VX4.56 after a resumed tool call the body goes on in the branch it was in, and an if after it takes its own branch", () => {
    const c = call(vxml(`<form><var name="r"/><block><if cond="r === undefined"><data name="r" src="tool:t"/>After.<else/>Else.</if><if cond="false">Wrong.<else/>Right.</if></block></form>`));
    expect(c.start()).toMatchObject({ call: { tool: "t" } });
    expect(c.result({ ok: true }).say).toEqual(["After.", "Right."]);
  });

  it("VX4.57 unnamed dialogs never share a name, however few bodies come before them", () => {
    const c = call(vxml(`<form><field name="a" type="boolean"><prompt>A?</prompt></field></form>
      <form scope="document"><grammar root="w"><rule id="w">weather<tag>out.w = true</tag></rule></grammar><field name="w" type="boolean"><prompt>W?</prompt></field><block>Weather.<exit/></block></form>`));
    c.start();
    expect(c.say("weather")).toMatchObject({ say: ["Weather."], end: "exit" });
    expect(call(vxml(`<form/><menu><choice next="#x">x</choice></menu><form id="x"/>`)).start().state).toMatchObject({ frames: [{ dialog: "_form0" }] });
  });

  it("VX4.58 cancel with no handler does not reprompt the item waiting", () => {
    const c = call(vxml(`<link event="cancel"><grammar root="c"><rule id="c">stop</rule></grammar></link><form><field name="a" type="boolean"><prompt>A?</prompt></field></form>`));
    c.start();
    expect(c.say("stop")).toMatchObject({ say: [] });
    expect(c.say("yes")).toMatchObject({ end: "exit" });
  });

  it("VX4.59 a goto names exactly one place to go", () => {
    for (const attrs of ["", 'next="#a" nextitem="b"'])
      expect(() => call(vxml(`<form id="a"><block name="b"><goto ${attrs}/></block></form>`))).toThrow("a <goto> needs exactly one of next, expr, nextitem or expritem");
  });
});
