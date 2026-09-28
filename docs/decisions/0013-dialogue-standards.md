# 0013: Dialogue authoring standards: VoiceXML with SRGS, and AIML

Status: decided, 2026-09-27.

## Question

The scripted dialogue (ADR 0012) answers turns from scripts and flows, and builds scripts
itself. Someone who wants to shape the harness for a task should not have to learn our
script book or write flow code to do it: they should be able to author a dialogue with
tools they already have, or bring a bot they already run. Which standards, and how do
they run so that the harness keeps what it gets from flows (durable state, tools, the
model for what the dialogue cannot answer)?

## Decision

Two standards, the two with the widest body of existing dialogues and tools:

- **VoiceXML 2.1 with SRGS 1.0 grammars and SISR semantics** (W3C). The call-center
  standard: IVR platforms, their design tools and years of call flows are written in it.
  Grammars come in SRGS's XML and ABNF forms, inline or as files, with the builtin types
  (boolean, digits, number, date, time, currency, phone).
- **AIML 2.0.** The chatbot standard of ALICE, Pandorabots and Program AB; public bots
  and their sets, maps, properties and substitutions are imported as they are, in either
  Pandorabots' JSON or Program AB's text files.

`@harness/dialogue-standards` (pure) compiles a document's files and runs it with an
**interpreter** a turn at a time: given the last step's state (JSON) and the utterance, a
step says what to say, and whether to hand the turn on, hand the person over, end, or call
a tool first. The dialogue holds imported documents in its book (`documents`: the files as
they were, so they stay editable with their own tools) and gives flows an `interpret` tool
that runs a step of one.

Each document runs as a **flow** (ADR 0012), the one `importDialogue` generates. A turn is
one flow run: it asks the interpreter for the step, says what it says, calls the tools it
names, and returns `{ continue: state }`. The dialogue keeps that state with the session
and starts the next run with it on the next utterance (Temporal's *continue-as-new*): the
state between turns is the session's, saved with the book, and within a turn every
interpreter step and tool call is journaled, so a run cut short resumes where it was.
Journals stay one turn long however long the conversation. Any flow can end a turn this
way; imported ones always do.

What each standard means in the harness:

- A VoiceXML `<transfer>` hands the person to the model (the IVR's "transfer to an
  agent"). An utterance no active grammar takes, with no `<nomatch>` handler, is the
  model's turn (the field keeps waiting, unprompted); `--option nomatch=reprompt` keeps
  the platform's "I didn't understand" instead. `<data src="tool:x" namelist>` calls the
  host tool or workflow `x` with those variables and puts the result in its variable;
  `<submit next="tool:x">` does the same and ends the application with the result. A
  tool the host does not have (neither one of its tools nor a workflow) is
  `error.badfetch` where the document called it, which the document can catch; a tool that
  fails when called fails the turn's run (a durable workflow's failing effect stops its
  run, so a resume retries it rather than the code swallowing it), which ends the
  application and is reported. A script error (an expression that fails, a `<goto>` or
  link to a document that is not there) is `error.semantic` or `error.badfetch` with its
  message in `_message`, as the specification has it; uncaught, the step fails. A
  script's slots prefill fields of the same name when its reply starts the application.
- References between files (`<goto>`, `<subdialog>`, `application`, grammar `src`, SRGS
  rule references) are relative to the referring file's folder. Menus follow the
  specification: a choice's own grammars replace its text, `accept="approximate"` takes
  some of a choice's words in its order, and `dtmf="true"` numbers the first nine choices
  without keys of their own; a key (`#` and `*` too) is the whole answer as typed, and two
  choices with one key are refused. An error in a body or in visiting an item goes to that
  item's handlers first. The builtin `number` is a string of digits (ECMAScript
  converts it in arithmetic other than `+`), a month and a year alone make a `date` of
  `yyyymm??`, and a rule without SISR tags takes the value of the last rule it referred to.
- An AIML turn that only the catch-all category (`*`) answers, or none, is the model's,
  and changes nothing in the bot's state (`--option fallback=bot` keeps the bot's
  catch-all). `<sraix>` (a question for another service) hands the turn to the model.
  `<random>` picks with a seed kept in the state, so a replayed step picks alike;
  `<date>` reads the clock the dialogue is given; `<learn>` learns for the conversation,
  its categories searched with the bot's as one graph, so AIML's precedence holds between
  them (a category that would not compile, or longer than 64 tokens, is not learned).
  `<date format>` is strftime's and `<date jformat>` Java's SimpleDateFormat, as Program AB
  reads them. Input is normalized with the bot's substitutions, then split into sentences at
  `.`, `!` or `?` followed by whitespace. A turn's matching is bounded: its searches share
  a budget of graph steps, and it makes at most a few hundred reductions (`<srai>`), however
  they nest; predicates and locals have no prototype.

The embedded ECMAScript (VoiceXML's `cond`, `expr` and `<assign>`, SISR's tags) is
evaluated by our evaluator over jsep's parse: expressions and assignments on JSON values,
with a few pure built-ins and no loops, user functions or prototypes, so a document can
neither run long nor reach anything but its variables. A value it makes or assigns is
capped in size, a shared part counted each time it appears (so an assignment repeated turn
after turn, or `a = [a, a]`, cannot grow without bound), a value cannot be put inside itself
(state stays JSON), and a built-in's own errors are script errors. XML is parsed by `@xmldom/xmldom`.
Matching an utterance against an SRGS grammar is ours (no JavaScript library implements
SRGS for text): a backtracking derivation of all its words, alternatives heaviest first,
bounded in steps, so a grammar that would take long (or recurses on the left) does not
match.

What text has no use for, or what would run code on the host, is refused when the
document is imported, naming it: `<script>`, `<record>`, `<object>`, URLs other than
`tool:`, and AIML's `<system>` and `<javascript>` (those categories are dropped, with a
warning). Timeouts, properties and audio are ignored (audio's fallback text is said).

`harness-dialogue import <files or directories> --book <book> --name <name>` imports into
a book and writes the flow next to it (or to `--flows <dir>`: the daemon's `--workflows`
directory when it runs with one, since its flows are then that library's); `--entry` makes
it the flow every session starts in, and `--pattern` adds (or replaces) a script that
starts it; importing again without it keeps that script. From a directory it takes only
the files a standard reads, naming those it skips.

## Alternatives

- **Run documents in the flow's sandbox (QuickJS) as JavaScript interpreters.** A flow's
  code is a string; an interpreter as flow code could not be typed, tested or mutation
  tested as ours is, and its state would live in the journal, which then grows with the
  conversation. An interpreter as a tool keeps the flow a dozen lines.
- **Keep a document's state in its flow's journal (a flow that loops on `hear`).** It
  works for short dialogues (flows written by hand do it), but a bot's conversation has no
  end: its journal, replayed every turn, would grow without bound.
- **Compile documents to scripts.** AIML categories that are plain text with stars map to
  scripts, but `<srai>`, `<that>`, topics, predicates and VoiceXML's form interpretation
  do not, and splitting a document between the two loses its precedence. Documents stay
  whole; scripts and learning work around them (a turn a document hands on goes to the
  scripts, then the model, whose answers the dialogue learns from).
- **Other formats (Dialogflow, Rasa, Bot Framework).** Product export formats rather than
  standards, each tied to its platform's NLU; not taken now.

## Revisit when

- A standard's feature the harness refuses is needed (VoiceXML `<script>` would need a
  sandboxed engine per document, which the QuickJS code mode could provide).
- SCXML (the W3C state-chart standard VoiceXML 3 builds on) is asked for.
