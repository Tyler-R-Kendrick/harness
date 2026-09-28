/**
 * The playground page: a wterm terminal running a just-bash shell, the harness daemon
 * (the browser host) in the same page, and an inspector of what the daemon does.
 * The logic lives in the modules it imports (and their tests); this file is the DOM.
 */
import wtermCss from "@wterm/dom/css?inline";
import { WTerm } from "@wterm/dom";
import { BashShell } from "@wterm/just-bash";
import { Bash } from "just-bash";
import type { DaemonSnapshot, SnapshotStorage } from "@harness/core";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4, LanguageModelV4 } from "@ai-sdk/provider";
import xgrammarSource from "@mlc-ai/web-xgrammar?raw";
import { wrapLanguageModel } from "ai";
import { parseCatalog } from "@harness/cognitive";
import type { ModelDescriptor, PortMap, TaskCategory } from "@harness/cognitive";
import { buildBrowserEnsemble, IndexedDbStorage, xgrammarFromSource } from "@harness/platform-browser";
import benchmarksFile from "@harness/cognitive/data/benchmarks.json?raw";
import catalogFile from "@harness/cognitive/data/catalog.json?raw";
import { storedConversations } from "@harness/workers";
import settingsFile from "../data/templates.json?raw";
import helpSeed from "../data/templates/help.md?raw";
import listFilesSeed from "../data/templates/list-files.md?raw";
import runCommandSeed from "../data/templates/run-command.md?raw";
import showFileSeed from "../data/templates/show-file.md?raw";
import todaySeed from "../data/templates/today.md?raw";
import { AGENT, syncAgentDir } from "./agent-dir.ts";
import type { HarnessState } from "./agent-dir.ts";
import { lexicalDecider } from "./decide.ts";
import { deciders, DECIDING, LEXICAL, rankDecisionModels } from "./decision-model.ts";
import { CLAUDE, rankGenerators, WRITING, writers } from "./generator-model.ts";
import { AUTO, LocalModels } from "./local-models.ts";
import type { LocalModel } from "./local-models.ts";
import type { Capabilities, Past } from "./model-choice.ts";
import { TemplateEngine } from "./engine.ts";
import { parseEngineSettings } from "./engine-settings.ts";
import { TEMPLATES, TemplateStore } from "./templates.ts";
import { Coalesced, parsePageState, parseTrace, parseVfsSnapshot, reported, resilient, restoreVfs, snapshotVfs, storableEvent } from "./persist.ts";
import { INSTRUCTIONS, Playground } from "./playground.ts";
import type { TurnReport } from "./playground.ts";
import { sampleLanguageModel } from "./sample-model.ts";
import type { ModelTier, Sample } from "./sample-model.ts";
import { Prompter, SlashCommands, TurnRenderer, withSlashCommands } from "./shell.ts";
import type { Settings } from "./shell.ts";
import { shellModel } from "./shell-model.ts";
import { Tracer, tracingMiddleware } from "./trace.ts";
import type { TraceEvent, TraceKind } from "./trace.ts";
import { HOME, SHELL_ENV, vfsTools, walk } from "./vfs.ts";
import type { FileEntry, VfsDiff } from "./vfs.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style" | "dataset">> & { readonly dataset?: Record<string, string>; readonly style?: string };
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: (Node | string)[]) => {
  const el = document.createElement(tag);
  const { dataset, style, ...rest } = props;
  Object.assign(el, rest);
  if (dataset) Object.assign(el.dataset, dataset);
  if (style) el.setAttribute("style", style);
  el.append(...children);
  return el;
};
const short = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);
const store = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage is a convenience here
    }
  },
  remove: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage is a convenience here
    }
  },
};

const SAMPLE_FILES: Record<string, string> = {
  [`${HOME}/README.md`]: [
    "# Example workspace",
    "",
    "These files are examples. The agent's tools and your terminal share this",
    "filesystem, so whatever a turn changes shows up here and in the Files tab.",
    "",
  ].join("\n"),
  [`${HOME}/notes/todo.md`]: ["# Things to try", "", "- [ ] /ask what files are here? (a template answers: no inference)", "- [ ] /ask $ ls -la with approvals on, and answer n", "- [ ] /ask write a haiku about the sea (no template fits: a generator may write one, asking first)", "- [ ] /templates, then /rate good or /rate bad <why>", "- [ ] /trace 30 | grep model", ""].join("\n"),
  [`${HOME}/src/greet.sh`]: ['name="${1:-world}"', 'echo "hello, $name"', ""].join("\n"),
  // The templates /ask starts with; the ones generators write join them here.
  [`${TEMPLATES}/help.md`]: helpSeed,
  [`${TEMPLATES}/list-files.md`]: listFilesSeed,
  [`${TEMPLATES}/run-command.md`]: runCommandSeed,
  [`${TEMPLATES}/show-file.md`]: showFileSeed,
  [`${TEMPLATES}/today.md`]: todaySeed,
};
const engineSettings = parseEngineSettings(JSON.parse(settingsFile));

const GREETING = [
  "\x1b[1mharness playground\x1b[0m \x1b[2m· the daemon runs in this page; this shell shares its files with the agent\x1b[0m",
  "  \x1b[36m/ask\x1b[0m <prompt>         answered from a template (~/agent/templates) before any inference",
  "  \x1b[36m/ask\x1b[0m $ <command>      runs a command through the agent's bash tool and its approval",
  "  \x1b[36m/templates\x1b[0m /rate /generate  the templates, their feedback, and whether writing one asks first",
  "  \x1b[36m/decide\x1b[0m [slug]        which decision model picks templates: auto (for this browser), lexical, or a model id",
  "  \x1b[36m/writer\x1b[0m [slug]        which model writes templates: auto (local first, then Claude), claude, or a model id",
  "  \x1b[36m/help\x1b[0m                 sessions, workers, tier, approvals, traces; any command takes --help",
  "",
];

// The decision model and the generator are picked for this browser (/decide auto, /writer auto): the best-ranked it can run, local
// first (Claude writes only when no local generator is ready, or for a template it fails); /decide <id> and /writer <id> name one.
const settings: Settings = { worker: "templates", tier: "default", approval: "ask", generate: "ask", decide: AUTO, writer: AUTO };
const tracer = new Tracer(() => Date.now());
/** A trace time as this viewer's wall clock, to the millisecond (events from before a reload keep theirs). */
const clock = (at: number) => {
  const d = new Date(at);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

// ---- Claude, through the artifact runtime's sample capability ------------------------

let sample: Sample | undefined;
let claudeState: "checking" | "ready" | "off" = "checking";
/** Rewrite the harness's agent directory (~/agent) from its state; set once the page has booted. */
let resyncHarness: (() => Promise<void>) | undefined;
const claude = sampleLanguageModel(
  (input, options) =>
    sample
      ? sample(input, options)
      : Promise.reject({ code: "unavailable", message: "Claude is not reachable from this page: open it as a published artifact on claude.ai, or pick the shell or echo worker" }),
  { tier: () => settings.tier },
);
const runtime = (globalThis as { claude?: { use(name: string): Promise<unknown> } }).claude;
const claudeReady = (runtime ? runtime.use("sample").catch(() => null) : Promise.resolve(null)).then((s) => {
  sample = typeof s === "function" ? (s as Sample) : undefined;
  claudeState = sample ? "ready" : "off";
  // Claude is never picked for you: inference is the last resort (it writes templates, asking first, or runs when chosen).
  // A worker restored from a visit where Claude was reachable, on a page where it is not.
  if (!sample && settings.worker === "claude") settings.worker = "templates";
  sync();
  // Whether Claude can write templates is part of the harness's state (~/agent/agent.ts).
  void resyncHarness?.().then(refreshFiles);
});

// ---- local models: decision models (Julia 1) and generators (Qwen3.5 0.8B), picked for this browser -----

/** What became of a model's files on an earlier visit: kept, or why not. */
const pastKey = (id: string) => `harness-playground.model.${id}`;
const KEPT = "kept";
const pastOf = (id: string): Past | undefined => {
  const v = store.get(pastKey(id));
  return v === undefined ? undefined : v === KEPT ? { kept: true } : { kept: false, reason: v };
};
const catalog = parseCatalog(JSON.parse(catalogFile), JSON.parse(benchmarksFile));
/** What this browser offers, once asked (a generator runs on WebGPU when there is an adapter). */
let capabilities: Capabilities | undefined;

/** One catalog model loaded through the browser host's ensemble: its port for the task. */
async function loadLocal<K extends "judge" | "generator">(model: ModelDescriptor, task: TaskCategory, kind: K, cacheProblem: (reason: string) => void): Promise<PortMap[K]> {
  // onnxruntime-web comes with the page (WebGPU when the browser has it, else WebAssembly); its WebAssembly from its CDN.
  const ort = await import("onnxruntime-web/webgpu");
  const onnxWasm = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web ?? ort.env.versions.common}/dist/`;
  // A generator runs on transformers.js (over the same onnxruntime-web), its JSON held to the schema by XGrammar.
  const transformers = kind === "generator" ? await import("@huggingface/transformers") : undefined;
  const onnx = transformers?.env.backends.onnx as { wasm?: { wasmPaths?: unknown } } | undefined;
  if (onnx?.wasm) onnx.wasm.wasmPaths = onnxWasm;
  const ensemble = buildBrowserEnsemble({
    catalog: { models: [model], preferences: {} },
    allowHosted: false,
    onnxruntime: ort,
    onnxWasm,
    ...(transformers ? { transformers, xgrammar: xgrammarFromSource(xgrammarSource), device: capabilities?.webgpu ? ("webgpu" as const) : ("wasm" as const) } : {}),
    onCacheProblem: (key, e) => {
      cacheProblem(e instanceof Error ? e.message : String(e));
      tracer.record({ kind: "host", name: "model not kept", detail: `${key}: ${String(e)}` });
    },
  });
  // A member that fails to load says why; the ensemble only says none is available.
  const { port } = await ensemble.resolve(task, kind).catch((e: unknown) => {
    throw new Error(ensemble.members().find((m) => m.reason)?.reason ?? String(e));
  });
  return port;
}

/** A local model started loading, is ready, or failed: keep whether its files were kept, and move auto on past a failure. */
function localChanged<P>(models: LocalModels<P, ModelDescriptor>, slug: () => string, what: string) {
  return (model: LocalModel<P>) => {
    // A visit whose download the browser would not keep does not start the next one on its own.
    if (model.phase() === "ready") store.set(pastKey(model.id), model.unkept ?? KEPT);
    tracer.record({ kind: "host", name: what, detail: `${model.id}: ${model.status()}` });
    // Auto moves on to the next model that fits when its pick could not load.
    if (model.phase() === "failed" && slug() === AUTO) models.want(AUTO, false);
    sync();
    // Which models decide and write is part of the harness's state (~/AGENTS.md).
    void resyncHarness?.().then(refreshFiles);
  };
}

const decisionModels: LocalModels<EvaluationModelV4, ModelDescriptor> = new LocalModels({
  ranked: rankDecisionModels(catalog),
  settings: engineSettings.choice,
  past: pastOf,
  load: (model) => loadLocal(model, "classification", "judge", (reason) => decisionModels.current(model.id)?.cacheProblem(reason)),
  onChange: (model) => localChanged(decisionModels, () => settings.decide, "decision model")(model),
  role: DECIDING,
});
const localGenerators: LocalModels<LanguageModelV4, ModelDescriptor> = new LocalModels({
  ranked: rankGenerators(catalog),
  settings: engineSettings.choice,
  past: pastOf,
  // The generator's calls show in the timeline, as the worker's do.
  load: async (model) => wrapLanguageModel({ model: await loadLocal(model, "structured-extraction", "generator", (reason) => localGenerators.current(model.id)?.cacheProblem(reason)), middleware: tracingMiddleware(tracer) }),
  onChange: (model) => localChanged(localGenerators, () => settings.writer, "generator")(model),
  role: WRITING,
});

/** What this browser offers a local model: a WebGPU adapter, room in its storage, and whether it asks to save data. */
async function detectCapabilities(): Promise<Capabilities> {
  const nav = navigator as { gpu?: { requestAdapter(): Promise<unknown> }; connection?: { saveData?: boolean }; storage?: { estimate(): Promise<{ quota?: number; usage?: number }> } };
  const webgpu = Boolean(await nav.gpu?.requestAdapter().catch(() => null));
  const estimate = await nav.storage?.estimate().catch(() => undefined);
  const freeBytes = estimate?.quota === undefined ? undefined : estimate.quota - (estimate.usage ?? 0);
  return { webgpu, freeBytes, saveData: nav.connection?.saveData === true };
}
const detected = detectCapabilities()
  .catch((): Capabilities => ({ webgpu: false, freeBytes: undefined, saveData: false }))
  .then((c) => {
    capabilities = c;
    decisionModels.detected(c);
    // The generator's room is what is left after auto's decision model downloads (unless the browser kept it).
    const deciding = settings.decide === AUTO ? decisionModels.pick() : undefined;
    const reserved = deciding && pastOf(deciding.id)?.kept !== true ? deciding.downloadBytes * engineSettings.choice.headroom : 0;
    localGenerators.detected({ ...c, freeBytes: c.freeBytes === undefined ? undefined : c.freeBytes - reserved });
    tracer.record({ kind: "host", name: "browser capabilities", detail: c });
  });
/** Load the local models the slugs want, once the browser's capabilities are known: auto's picks on their own, named ones when asked or kept. */
const wantLocalModels = (asked: boolean) =>
  void detected.then(() => {
    decisionModels.want(settings.decide, asked);
    localGenerators.want(settings.writer, asked);
    sync();
    void resyncHarness?.().then(refreshFiles);
  });

// ---- controls ---------------------------------------------------------------------------

function sync() {
  for (const b of $("worker").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-pressed", String(b.dataset["worker"] === settings.worker));
    if (b.dataset["worker"] === "claude") {
      b.disabled = claudeState === "off";
      b.title = claudeState === "off" ? "Claude is reachable only when this page is opened as an artifact on claude.ai" : "Claude, through this artifact's sample capability";
    }
  }
  const tier = $<HTMLSelectElement>("tier");
  tier.value = settings.tier;
  tier.disabled = settings.worker !== "claude";
  $<HTMLInputElement>("approval").checked = settings.approval === "ask";
  const pill = $("claude-pill");
  pill.dataset["state"] = claudeState;
  pill.textContent = claudeState === "ready" ? "Claude: ready" : claudeState === "off" ? "Claude: not reachable here" : "Claude: checking";
  const decides = $("decide-pill");
  const phase = decisionModels.phase(settings.decide);
  const label = decisionModels.current(settings.decide)?.label ?? "model";
  decides.dataset["state"] = phase === "ready" ? "ready" : phase === "loading" || phase === "idle" || phase === "checking" ? "checking" : "off";
  decides.textContent = `Decides: ${phase === "ready" ? label : phase === "loading" ? `loading ${label}` : "lexical"}`;
  decides.title = `/decide ${settings.decide}: ${decisionModels.status(settings.decide)}`;
  const writes = $("writer-pill");
  const writing = localGenerators.phase(settings.writer);
  const writerLabel = localGenerators.current(settings.writer)?.label ?? "model";
  writes.dataset["state"] = writing === "ready" ? "ready" : writing === "loading" || writing === "idle" || writing === "checking" ? "checking" : "off";
  writes.textContent = `Writes: ${writing === "ready" ? writerLabel : writing === "loading" ? `loading ${writerLabel}` : "Claude"}`;
  writes.title = `/writer ${settings.writer}: ${localGenerators.status(settings.writer)}`;
  $("session-line").textContent = playground?.sessionId ? `session ${short(playground.sessionId)}` : "no session yet";
}

$("worker").addEventListener("click", (e) => {
  const worker = (e.target as HTMLElement).closest("button")?.dataset["worker"];
  if (!worker) return;
  settings.worker = worker;
  sync();
  pageSaver?.request();
});
$<HTMLSelectElement>("tier").addEventListener("change", (e) => {
  settings.tier = (e.target as HTMLSelectElement).value as ModelTier;
  sync();
  pageSaver?.request();
});
$<HTMLInputElement>("approval").addEventListener("change", (e) => {
  settings.approval = (e.target as HTMLInputElement).checked ? "ask" : "auto";
  sync();
  pageSaver?.request();
});

// ---- tabs -------------------------------------------------------------------------------

const TABS = ["timeline", "turns", "files", "daemon"] as const;
function selectTab(name: string) {
  for (const tab of TABS) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`panel-${tab}`).hidden = tab !== name;
  }
  store.set("harness-playground-tab", name);
  if (name === "timeline") flushEvents(true);
}
for (const tab of TABS) $(`tab-${tab}`).addEventListener("click", () => selectTab(tab));

// ---- timeline ---------------------------------------------------------------------------

const KINDS: readonly TraceKind[] = ["acp", "worker", "model", "tool", "vfs", "hook", "host"];
const shownKinds = new Set<TraceKind>(KINDS);
const counts = new Map<TraceKind, number>(KINDS.map((k) => [k, 0]));
let showChunks = false;
let follow = true;
let pending: TraceEvent[] = [];
let rebuild = false;
const MAX_ROWS = 1500;

const chips = new Map<TraceKind, HTMLButtonElement>();
for (const kind of KINDS) {
  const chip = h("button", { type: "button", className: "chip", dataset: { kind } }, kind, " ", h("span", { className: "n" }, "0"));
  chip.setAttribute("aria-pressed", "true");
  chip.addEventListener("click", () => {
    if (shownKinds.has(kind)) shownKinds.delete(kind);
    else shownKinds.add(kind);
    chip.setAttribute("aria-pressed", String(shownKinds.has(kind)));
    rebuild = true;
    flushEvents(true);
  });
  chips.set(kind, chip);
  $("kinds").insertBefore(chip, $("kinds").firstChild);
}
// chips were inserted in reverse; put them back in order before the switch
for (const kind of KINDS) $("kinds").insertBefore(chips.get(kind)!, $("chunks").parentElement);

$<HTMLInputElement>("chunks").addEventListener("change", (e) => {
  showChunks = (e.target as HTMLInputElement).checked;
  rebuild = true;
  flushEvents(true);
});
$("follow").addEventListener("click", () => {
  follow = !follow;
  $("follow").setAttribute("aria-pressed", String(follow));
  $("follow").textContent = follow ? "following" : "paused";
  if (follow) flushEvents(true);
});
$("clear-trace").addEventListener("click", () => {
  tracer.clear();
  recount();
  traceSaver.request();
});

/** Count the kinds again and redraw the timeline (after it was cleared or restored). */
function recount() {
  for (const k of KINDS) counts.set(k, 0);
  for (const e of tracer.events()) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  rebuild = true;
  flushEvents(true);
}

const isChunk = (e: TraceEvent) => e.name.includes("chunk");
const visible = (e: TraceEvent) => shownKinds.has(e.kind) && (showChunks || !isChunk(e));

function json(value: unknown): string {
  const text = JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? `[${v.length} bytes]` : v), 2) ?? String(value);
  return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (${text.length - 40_000} more characters)` : text;
}

function eventRow(e: TraceEvent): HTMLDetailsElement {
  const arrow = e.direction === "in" ? "→" : e.direction === "out" ? "←" : e.phase === "end" ? "■" : e.phase === "start" ? "▶" : "";
  const summary = h(
    "summary",
    {},
    h("span", { className: "t" }, clock(e.at)),
    h("span", { className: "k" }, e.kind),
    h("span", { className: "d" }, arrow),
    h("span", { className: "n", title: e.name }, e.name),
    h("span", { className: "ms" }, e.duration === undefined ? "" : `${e.duration}ms`),
  );
  const row = h("details", { className: "ev", dataset: { kind: e.kind } }, summary);
  row.addEventListener("toggle", () => {
    if (row.open && !row.querySelector("pre")) row.append(h("pre", {}, json({ seq: e.seq, sessionId: e.sessionId, turnId: e.turnId, detail: e.detail })));
  });
  return row;
}

let flushQueued = false;
function flushEvents(now = false) {
  if (!now) {
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      flushEvents(true);
    });
    return;
  }
  for (const [kind, n] of counts) chips.get(kind)!.querySelector(".n")!.textContent = String(n);
  $("count-timeline").textContent = String(tracer.events().length);
  if ($("panel-timeline").hidden) return;
  const list = $("events");
  if (rebuild) {
    list.replaceChildren(...tracer.events().filter(visible).slice(-MAX_ROWS).map(eventRow));
    rebuild = false;
    pending = [];
  } else {
    list.append(...pending.filter(visible).map(eventRow));
    pending = [];
    while (list.childElementCount > MAX_ROWS) list.firstElementChild!.remove();
  }
  if (list.childElementCount === 0) list.replaceChildren(h("p", { className: "empty" }, "No events for these filters yet."));
  else list.querySelector(".empty")?.remove();
  if (follow) $("panel-timeline").scrollTop = $("panel-timeline").scrollHeight;
}

tracer.subscribe((e) => {
  counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  pending.push(e);
  flushEvents();
});
selectTab(TABS.find((t) => t === store.get("harness-playground-tab")) ?? "timeline");

// ---- turns ------------------------------------------------------------------------------

const turns: { prompt: string; report: Omit<TurnReport, "files"> }[] = [];
let lastDiff: VfsDiff = { added: [], modified: [], removed: [] };

function renderTurns() {
  $("count-turns").textContent = String(turns.length);
  if (turns.length === 0) return;
  $("turns").replaceChildren(
    ...[...turns].reverse().map(({ prompt, report }) => {
      const { added, modified, removed } = report.diff;
      const files = [...added.map((p) => ["added", "+", p]), ...modified.map((p) => ["modified", "~", p]), ...removed.map((p) => ["removed", "−", p])];
      return h(
        "article",
        { className: "turn" },
        h("div", { className: "prompt" }, prompt),
        h(
          "div",
          { className: "meta" },
          h("span", { className: "stop", dataset: { stop: report.stopReason } }, report.stopReason),
          `${report.modelCalls} model call${report.modelCalls === 1 ? "" : "s"}`,
          `${report.toolCalls} tool call${report.toolCalls === 1 ? "" : "s"}`,
          files.length ? `${added.length} added · ${modified.length} modified · ${removed.length} removed` : "no file changes",
          `${(report.ms / 1000).toFixed(2)}s`,
        ),
        ...(files.length ? [h("ul", { className: "files" }, ...files.map(([cls, mark, p]) => h("li", { className: `mark-${cls}` }, `${mark} ${p!.replace(`${HOME}/`, "")}`)))] : []),
      );
    }),
  );
}

// ---- files ------------------------------------------------------------------------------

let files = new Map<string, FileEntry>();
let selected: string | undefined;

function renderFiles() {
  $("count-files").textContent = String(files.size);
  const marks = new Map<string, string>([...lastDiff.added.map((p) => [p, "+"] as const), ...lastDiff.modified.map((p) => [p, "~"] as const)]);
  const items: HTMLLIElement[] = [];
  const seenDirs = new Set<string>();
  for (const [path, entry] of files) {
    const rel = path.slice(HOME.length + 1).split("/");
    for (let i = 1; i < rel.length; i++) {
      const dir = rel.slice(0, i).join("/");
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      items.push(h("li", { style: `padding-left:${12 + (i - 1) * 16}px` }, h("span", { className: "m" }, " "), h("span", { className: "dir" }, `${rel[i - 1]}/`)));
    }
    const mark = marks.get(path) ?? " ";
    const open = h("button", { type: "button" }, rel.at(-1)!);
    open.addEventListener("click", () => {
      selected = path;
      renderFiles();
    });
    const li = h(
      "li",
      { style: `padding-left:${12 + (rel.length - 1) * 16}px` },
      h("span", { className: `m ${mark === "+" ? "mark-added" : mark === "~" ? "mark-modified" : ""}` }, mark),
      open,
      h("span", { className: "size" }, entry.link === undefined ? `${entry.size} B` : `→ ${entry.link}`),
    );
    if (path === selected) li.setAttribute("aria-current", "true");
    items.push(li);
  }
  for (const path of lastDiff.removed) items.push(h("li", {}, h("span", { className: "m mark-removed" }, "−"), h("span", { className: "mark-removed" }, path.slice(HOME.length + 1))));
  $("tree").replaceChildren(...items);
  const entry = selected === undefined ? undefined : files.get(selected);
  $("viewer").hidden = entry === undefined;
  if (entry && selected) {
    $("viewer-path").textContent = selected;
    $("viewer-text").textContent = entry.link !== undefined ? `(a link to ${entry.link})` : (entry.text ?? `(${entry.size} bytes: too large to show)`);
  }
}

let bashRef: BashShell["bash"] = null;
async function refreshFiles() {
  if (!bashRef) return;
  files = await walk(bashRef.fs, HOME, { previous: files });
  renderFiles();
}

// ---- daemon -----------------------------------------------------------------------------

let snapshot: DaemonSnapshot | undefined;
let daemonQueued = false;

function renderDaemon() {
  daemonQueued = false;
  const snap = snapshot;
  if (!snap || !playground) return;
  const hooks = ((snap.hooks as { events?: { offset: number; type: string; sessionId?: string; at: number; source: string }[] }).events ?? []).slice();
  $("count-daemon").textContent = String(hooks.length);
  $("daemon-line").textContent = `daemon up · ${snap.sessions.length} session${snap.sessions.length === 1 ? "" : "s"} · ${hooks.length} hook events`;
  const current = playground.sessionId;
  const sessionRows = snap.sessions.map((s) => {
    const log = s.log as { base: number; entries: unknown[] };
    const nodes = (s.tree as { nodes: { state: string; id: string }[] }).nodes;
    return h(
      "tr",
      {},
      h("td", { title: s.id }, `${s.id === current ? "● " : "  "}${short(s.id)}`),
      h("td", {}, String(log.base + log.entries.length)),
      h("td", {}, s.turnId ? `running ${short(s.turnId)}` : "idle"),
      h("td", {}, String(nodes.filter((n) => n.id.startsWith("conn:") && n.state === "active").length)),
    );
  });
  const session = snap.sessions.find((s) => s.id === current);
  const nodes = session ? (session.tree as { nodes: { id: string; parent?: string; kind: string; state: string; grants: string[] }[] }).nodes : [];
  const depth = (id: string | undefined, d = 0): number => {
    const n = nodes.find((x) => x.id === id);
    return n?.parent === undefined ? d : depth(n.parent, d + 1);
  };
  const raw = h("details", { className: "raw" }, h("summary", {}, "Snapshot JSON (what the daemon saves after every change)"));
  raw.addEventListener("toggle", () => {
    if (raw.open) raw.append(h("pre", {}, json(snapshot)));
    else raw.querySelector("pre")?.remove();
  });
  const capabilities = playground.host.daemon.capabilities();
  $("daemon").replaceChildren(
    h(
      "div",
      { className: "section" },
      h("h3", {}, "Sessions"),
      h("div", { className: "scroll-x" }, h("table", { className: "grid" }, h("thead", {}, h("tr", {}, h("th", {}, "id"), h("th", {}, "log"), h("th", {}, "turn"), h("th", {}, "clients"))), h("tbody", {}, ...sessionRows))),
    ),
    h(
      "div",
      { className: "section" },
      h("h3", {}, "Subagent tree of the current session"),
      ...(nodes.length
        ? nodes.map((n) =>
            h(
              "div",
              { className: "node", style: `padding-left:${depth(n.id) * 16}px` },
              `${n.id} `,
              h("span", { className: "kindtag" }, `${n.kind} · ${n.state}`),
              " ",
              h("span", { className: "grants" }, n.grants.join(" ")),
            ),
          )
        : [h("p", { className: "empty" }, "No session yet: run ask to start one.")]),
    ),
    h(
      "div",
      { className: "section" },
      h("h3", {}, `Hook events (${hooks.length}, newest first)`),
      h(
        "div",
        { className: "scroll-x" },
        h(
          "table",
          { className: "grid" },
          h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "type"), h("th", {}, "session"), h("th", {}, "at"))),
          h("tbody", {}, ...hooks.reverse().slice(0, 60).map((e) => h("tr", {}, h("td", {}, String(e.offset)), h("td", {}, e.type), h("td", {}, e.sessionId ? short(e.sessionId) : ""), h("td", {}, clock(e.at))))),
        ),
      ),
    ),
    h("div", { className: "section" }, h("h3", {}, "Capabilities"), h("p", { className: "node" }, capabilities.length ? capabilities.map((c) => c.name).join(", ") : "none offered (clients and a cognitive core add them)")),
    h("div", { className: "section" }, raw),
  );
  sync();
}

function onSnapshot(s: DaemonSnapshot) {
  snapshot = s;
  if (daemonQueued) return;
  daemonQueued = true;
  requestAnimationFrame(renderDaemon);
}

// ---- what this browser keeps across reloads ----------------------------------------------

let resetting = false;
const storageProblem = (error: string) => tracer.record({ kind: "host", name: "storage", detail: error });
/** One record of the playground's IndexedDB database. Once a reset begins, only clearing writes. */
const kept = (key: string) => {
  const storage = resilient(() => new IndexedDbStorage({ name: "harness-playground", key }), storageProblem);
  return { load: () => storage.load(), save: (value: unknown) => (resetting ? Promise.resolve() : storage.save(value)), clear: () => storage.clear() } satisfies SnapshotStorage & { clear(): Promise<void> };
};
// `conversations` held every session's conversation in one record before they got a record each; reset still clears it.
const stores = { daemon: kept("daemon"), conversations: kept("conversations"), vfs: kept("vfs"), page: kept("page"), trace: kept("trace") };
/**
 * Each session's conversation, in a record of its own (`conversation:<session id>`). Its
 * failures are passed on to the agent worker, whose fallback is right for them: a
 * conversation it could not load is kept in memory and not saved over.
 */
const conversationRecords = new Map<string, SnapshotStorage & { clear(): Promise<void> }>();
const conversationRecord = (sessionId: string) => {
  const known = conversationRecords.get(sessionId);
  if (known) return known;
  const key = `conversation:${sessionId}`;
  const storage = reported(() => new IndexedDbStorage({ name: "harness-playground", key }), (e) => storageProblem(`${key}: ${e}`));
  const record = { load: () => storage.load(), save: (value: unknown) => (resetting ? Promise.resolve() : storage.save(value)), clear: () => storage.save(undefined).catch(() => undefined) };
  conversationRecords.set(sessionId, record);
  return record;
};
let pageSaver: Coalesced | undefined;
let vfsSaver: Coalesced | undefined;
const saveAll = () => {
  vfsSaver?.request();
  pageSaver?.request();
  traceSaver.request();
};

// The timeline's newest events, kept as plain data (each event converted once).
const KEPT_EVENTS = 2_000;
const storable = new WeakMap<TraceEvent, TraceEvent>();
const stored = (e: TraceEvent) => storable.get(e) ?? (storable.set(e, storableEvent(e)), storable.get(e)!);
const traceSaver = new Coalesced(() => stores.trace.save({ version: 1, events: tracer.events().slice(-KEPT_EVENTS).map(stored) }), (e) => storageProblem(`timeline: ${e}`));
let traceTimer: ReturnType<typeof setTimeout> | undefined;
tracer.subscribe(() => {
  // Events come in bursts (every streamed chunk): save at most once a second.
  traceTimer ??= setTimeout(() => {
    traceTimer = undefined;
    traceSaver.request();
  }, 1_000);
});
tracer.subscribe((e) => {
  // A tool that ran may have changed files; keep them even if the page closes mid-turn.
  if (e.kind === "tool" && e.phase === "end") vfsSaver?.request();
});
addEventListener("pagehide", saveAll);

/** Forget everything this browser keeps: stop saving, let running work and saves land, clear, reload. */
async function reset() {
  resetting = true;
  await playground?.close();
  await Promise.all([vfsSaver?.flush(), pageSaver?.flush(), traceSaver.flush()]);
  const sessions = playground?.snapshot().sessions.map((s) => s.id) ?? [];
  await Promise.all([...Object.values(stores), ...sessions.map(conversationRecord)].map((s) => s.clear()));
  location.reload();
}

// ---- boot -------------------------------------------------------------------------------

let playground: Playground | undefined;

async function boot() {
  // The timeline from before a reload goes first, so everything after follows it.
  const savedTrace = await stores.trace.load().then(parseTrace);
  if (savedTrace) {
    tracer.restore(savedTrace);
    recount();
  }
  tracer.record({ kind: "host", name: "page loaded" });

  const style = document.createElement("style");
  style.textContent = wtermCss;
  document.head.append(style);

  // Keys reach the terminal before the shell exists: they wait for it.
  const late: { prompter?: Prompter; shell?: BashShell } = {};
  const input = (data: string) => {
    if (late.prompter?.handleKey(data)) return;
    const done = late.shell?.handleInput(data);
    if (data === "\r")
      void done?.then(() => {
        saveAll();
        return refreshFiles();
      });
  };
  const term = new WTerm($("terminal"), { onData: input });
  await term.init();
  const write = (s: string) => term.write(s);
  const prompter = (late.prompter = new Prompter(write));
  prompter.onAsk = () => term.focus();
  const [savedVfs, savedPage] = await Promise.all([stores.vfs.load().then(parseVfsSnapshot), stores.page.load().then(parsePageState)]);
  const restored = savedVfs !== undefined || savedPage !== undefined || savedTrace !== undefined;
  if (savedPage) {
    Object.assign(settings, savedPage.settings);
    turns.push(...savedPage.turns);
    lastDiff = savedPage.turns.at(-1)?.report.diff ?? lastDiff;
    renderTurns();
  }
  const promptFor = (cwd: string) => `\x1b[36mharness\x1b[0m:\x1b[34m${cwd.replace(HOME, "~") || "/"}\x1b[0m$ `;
  const shell = (late.shell = new BashShell({ files: savedVfs ? {} : SAMPLE_FILES, cwd: HOME, env: { ...SHELL_ENV }, greeting: GREETING, prompt: promptFor }));
  await shell.attach(write);
  const bash = shell.bash!;
  bashRef = bash;
  if (savedVfs) await restoreVfs(bash.fs, HOME, savedVfs);

  const templateStore = new TemplateStore(bash.fs, { retireMargin: engineSettings.curation.retireMargin });
  const lexical = lexicalDecider(engineSettings.lexical);
  const facts = {
    cwd: () => HOME,
    files: () => [...files.keys()].filter((f) => !f.startsWith(`${HOME}/agent/`)).map((f) => f.slice(HOME.length + 1)).join("\n"),
    date: () => new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    templates: async () => (await templateStore.list()).templates.map((t) => `${t.id}: ${t.description}`).join("\n"),
    sessions: async () => (playground ? (await playground.sessions()).join("\n") : ""),
    worker: () => settings.worker,
  };
  const engine = new TemplateEngine({
    store: templateStore,
    settings: engineSettings,
    facts,
    deciders: () => deciders(decisionModels, settings.decide, lexical),
    // A local generator writes first; Claude only when none is ready, or for a template it fails.
    generators: () => writers(localGenerators, settings.writer, claudeState === "ready" ? claude : undefined),
    generation: () => settings.generate,
    // A written script is tried on a throwaway copy of the files (no network here) before it is kept.
    trial: async (script) => {
      const copy = new Bash({ cwd: HOME });
      await restoreVfs(copy.fs, HOME, await snapshotVfs(bash.fs, HOME));
      return copy.exec(script, { cwd: HOME, env: { ...SHELL_ENV }, signal: AbortSignal.timeout(engineSettings.generation.trialMs) });
    },
  });
  // The harness as an Eve agent in its own filesystem (~/AGENTS.md, ~/agent/), kept in sync with its state.
  const commands: { slash?: SlashCommands } = {};
  const WORKERS = [
    { name: "templates", description: "Answers from the templates in ~/agent/templates; generates only what cannot be decided, asking first", model: "harness.templates/templates", instructions: "Answer each request from a template: a decision model picks it, and its holes are filled from facts, the request and choices. Write, fill or rewrite a template only when nothing else answers, and only with consent." },
    { name: "echo", description: "Echoes the prompt: no model, no tools" },
    { name: "shell", description: "Runs `$ <command>` through the bash tool, deterministically", model: "harness.playground/shell" },
    { name: "claude", description: "Claude through this artifact's sample capability: inference on every turn, only when picked", model: "claude.sample/sample", instructions: INSTRUCTIONS },
  ];
  const approvalOf = (name: string) => {
    const generation = engine.approval(name);
    if (generation !== undefined) return generation === "user-approval" ? "asks first (/generate ask)" : generation === "denied" ? "off (/generate off)" : "runs on its own (/generate auto)";
    return name === "readFile" ? "never asks" : settings.approval === "ask" ? "asks first (/approve ask)" : "runs on its own (/approve auto)";
  };
  const harnessState = async (): Promise<HarnessState> => ({
    instructions: INSTRUCTIONS,
    workers: WORKERS,
    tools: { ...vfsTools(bash), ...engine.tools() },
    approval: approvalOf,
    settings,
    decisionModel:
      settings.decide === LEXICAL
        ? "the lexical judge (harness.lexical/tf-idf) alone (/decide lexical)"
        : `${decisionModels.name(settings.decide) ?? "no model"} (/decide ${settings.decide}): ${decisionModels.status(settings.decide)}; the lexical judge (harness.lexical/tf-idf) behind it`,
    generators: [
      ...(settings.writer === CLAUDE || !localGenerators.current(settings.writer) ? [] : [`${localGenerators.name(settings.writer)}: ${localGenerators.status(settings.writer)}`]),
      ...(claudeState === "ready" ? [`${claude.provider}/${claude.modelId}`] : []),
    ],
    templates: (await templateStore.list()).templates,
    facts: Object.keys(facts),
    commands: commands.slash?.list() ?? [],
    sessions: playground ? await playground.sessions() : [],
  });
  let syncing = Promise.resolve();
  const syncHarness = () => (syncing = syncing.then(async () => void (await syncAgentDir(bash.fs, await harnessState()))).catch((e: unknown) => void storageProblem(`agent directory: ${String(e)}`)));
  resyncHarness = syncHarness;
  playground = await Playground.start({
    bash,
    tracer,
    instructions: async () => (await bash.fs.readFile(`${AGENT}/instructions.md`).catch(() => INSTRUCTIONS)).trim() || INSTRUCTIONS,
    afterTurn: () => {
      // A decision the model left to the lexical judge shows in the pill.
      decisionModels.current(settings.decide)?.fellBack(engine.lastProblems);
      // So does a template the local generator's writing was refused for (its own problems, not Claude's).
      const writer = localGenerators.current(settings.writer);
      const own = writer?.port && `${writer.port.provider}/${writer.port.modelId}: `;
      writer?.fellBack(own ? engine.lastWriteProblems.filter((p) => p.startsWith(own)) : []);
      sync();
      return syncHarness();
    },
    models: { templates: engine.model(), shell: shellModel(), claude },
    tools: engine.tools(),
    toolApproval: (name) => engine.approval(name),
    worker: () => settings.worker,
    approval: () => settings.approval,
    onSnapshot,
    storage: stores.daemon,
    conversations: storedConversations(conversationRecord),
  });
  const p = playground;
  vfsSaver = new Coalesced(async () => stores.vfs.save(await snapshotVfs(bash.fs, HOME)), (e) => storageProblem(`files: ${e}`));
  pageSaver = new Coalesced(() => stores.page.save({ version: 1, sessionId: p.sessionId, settings: { ...settings }, turns }), (e) => storageProblem(`page: ${e}`));
  const slash = (commands.slash = new SlashCommands({
    playground: p,
    tracer,
    settings,
    prompter,
    write,
    workers: ["templates", "echo", "shell", "claude"],
    engine,
    store: templateStore,
    decider: decisionModels,
    writer: localGenerators,
    onChange: () => {
      wantLocalModels(true);
      sync();
      pageSaver?.request();
      void syncHarness().then(refreshFiles);
    },
    onTurn: (prompt, report) => {
      const { files: after, ...summary } = report;
      turns.push({ prompt, report: summary });
      lastDiff = report.diff;
      renderTurns();
      // The turn's own walk is the Files tab's; files are saved only when the turn changed some.
      files = new Map(after);
      renderFiles();
      pageSaver?.request();
      traceSaver.request();
      if (report.diff.added.length + report.diff.modified.length + report.diff.removed.length > 0) vfsSaver?.request();
    },
    onReset: reset,
  }));
  withSlashCommands(bash, slash);
  await syncHarness();
  await refreshFiles();
  sync();

  if (restored) {
    // Replace the first prompt with what was restored, then the session's log, then a new prompt.
    const sessions = await p.sessions();
    write(`\r\x1b[K\x1b[2mrestored from this browser: ${sessions.length} session${sessions.length === 1 ? "" : "s"}, ${files.size} file${files.size === 1 ? "" : "s"}, ${turns.length} turn${turns.length === 1 ? "" : "s"}, ${savedTrace?.length ?? 0} timeline events (harness reset starts over)\x1b[0m\r\n`);
    const current = savedPage?.sessionId;
    if (current !== undefined && sessions.includes(current)) {
      write(`\x1b[2m── session ${current}\x1b[0m\r\n`);
      const renderer = new TurnRenderer();
      await p.use(current, (u) => write(renderer.update(u)));
      write(renderer.end());
    }
    write(promptFor(shell.cwd));
    sync();
    term.focus();
    wantLocalModels(false);
    document.documentElement.dataset["booted"] = "restored";
    await claudeReady;
    return;
  }

  // A first turn through the whole path, typed as a person would: a template (run-command) answers it, so no inference.
  const was = { worker: settings.worker, approval: settings.approval };
  document.documentElement.dataset["demo"] = "running";
  settings.worker = "templates";
  settings.approval = "auto";
  await shell.handleInput(`/ask $ echo "- [x] ran a turn through the daemon" >> notes/todo.md && tail -n 1 notes/todo.md`);
  await shell.handleInput("\r");
  delete document.documentElement.dataset["demo"];
  Object.assign(settings, was);
  sync();
  saveAll();
  term.focus();
  wantLocalModels(false);
  document.documentElement.dataset["booted"] = "fresh";
  await claudeReady;
}

boot().catch((e: unknown) => {
  $("daemon-line").textContent = `failed to start: ${e instanceof Error ? e.message : String(e)}`;
  tracer.record({ kind: "host", name: "boot failed", detail: String(e) });
});
