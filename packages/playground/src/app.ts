/**
 * The playground page: a wterm terminal running a just-bash shell, the harness daemon
 * (the browser host) in the same page, and an inspector of what the daemon does.
 * The logic lives in the modules it imports (and their tests); this file is the DOM.
 */
import wtermCss from "@wterm/dom/css?inline";
import { WTerm } from "@wterm/dom";
import { BashShell } from "@wterm/just-bash";
import type { DaemonSnapshot, SnapshotStorage } from "@harness/core";
import { IndexedDbStorage } from "@harness/platform-browser";
import { storedConversations } from "@harness/workers";
import { Coalesced, parsePageState, parseVfsSnapshot, resilient, restoreVfs, snapshotVfs } from "./persist.ts";
import { Playground } from "./playground.ts";
import type { TurnReport } from "./playground.ts";
import { sampleLanguageModel } from "./sample-model.ts";
import type { ModelTier, Sample } from "./sample-model.ts";
import { harnessCommands, Prompter, TurnRenderer } from "./shell.ts";
import type { Settings } from "./shell.ts";
import { shellModel } from "./shell-model.ts";
import { Tracer } from "./trace.ts";
import type { TraceEvent, TraceKind } from "./trace.ts";
import { HOME, walk } from "./vfs.ts";
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
};

const SAMPLE_FILES: Record<string, string> = {
  [`${HOME}/README.md`]: [
    "# Example workspace",
    "",
    "These files are examples. The agent's tools and your terminal share this",
    "filesystem, so whatever a turn changes shows up here and in the Files tab.",
    "",
  ].join("\n"),
  [`${HOME}/notes/todo.md`]: ["# Things to try", "", "- [ ] ask Claude to summarize README.md", "- [ ] ask '$ ls -la' with approvals on, and answer n", "- [ ] harness trace 30 | grep model", ""].join("\n"),
  [`${HOME}/src/greet.sh`]: ['name="${1:-world}"', 'echo "hello, $name"', ""].join("\n"),
};

const GREETING = [
  "\x1b[1mharness playground\x1b[0m \x1b[2m· the daemon runs in this page; this shell shares its files with the agent\x1b[0m",
  "  \x1b[36mask\x1b[0m <prompt>          run a turn on the selected worker (claude, when this page can reach it)",
  "  \x1b[36mask\x1b[0m '$ <command>'     the shell worker runs one command through the same path",
  "  \x1b[36mharness help\x1b[0m          sessions, workers, tier, approvals, traces",
  "",
];

const settings: Settings = { worker: "shell", tier: "default", approval: "ask" };
let workerChosen = false;
const tracer = new Tracer(() => Date.now());
const t0 = Date.now();

// ---- Claude, through the artifact runtime's sample capability ------------------------

let sample: Sample | undefined;
let claudeState: "checking" | "ready" | "off" = "checking";
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
  if (sample && !workerChosen) settings.worker = "claude";
  // A worker restored from a visit where Claude was reachable, on a page where it is not.
  if (!sample && settings.worker === "claude") settings.worker = "shell";
  sync();
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
  $("session-line").textContent = playground?.sessionId ? `session ${short(playground.sessionId)}` : "no session yet";
}

$("worker").addEventListener("click", (e) => {
  const worker = (e.target as HTMLElement).closest("button")?.dataset["worker"];
  if (!worker) return;
  settings.worker = worker;
  workerChosen = true;
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
  for (const k of KINDS) counts.set(k, 0);
  rebuild = true;
  flushEvents(true);
});

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
    h("span", { className: "t" }, `${((e.at - t0) / 1000).toFixed(2)}s`),
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

const turns: { prompt: string; report: TurnReport }[] = [];
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
      h("span", { className: "size" }, `${entry.size} B`),
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
    $("viewer-text").textContent = entry.text ?? `(${entry.size} bytes: too large to show)`;
  }
}

let bashRef: BashShell["bash"] = null;
async function refreshFiles() {
  if (!bashRef) return;
  files = await walk(bashRef.fs, HOME);
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
          h("tbody", {}, ...hooks.reverse().slice(0, 60).map((e) => h("tr", {}, h("td", {}, String(e.offset)), h("td", {}, e.type), h("td", {}, e.sessionId ? short(e.sessionId) : ""), h("td", {}, `${((e.at - t0) / 1000).toFixed(2)}s`)))),
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
  return { load: () => storage.load(), save: (value: unknown) => (resetting ? Promise.resolve() : storage.save(value)), clear: () => storage.save(undefined) } satisfies SnapshotStorage & { clear(): Promise<void> };
};
const stores = { daemon: kept("daemon"), conversations: kept("conversations"), vfs: kept("vfs"), page: kept("page") };
let pageSaver: Coalesced | undefined;
let vfsSaver: Coalesced | undefined;
const saveAll = () => {
  vfsSaver?.request();
  pageSaver?.request();
};
tracer.subscribe((e) => {
  // A tool that ran may have changed files; keep them even if the page closes mid-turn.
  if (e.kind === "tool" && e.phase === "end") vfsSaver?.request();
});
addEventListener("pagehide", saveAll);

/** Forget everything this browser keeps: stop saving, let running work and saves land, clear, reload. */
async function reset() {
  resetting = true;
  await playground?.close();
  await Promise.all([vfsSaver?.flush(), pageSaver?.flush()]);
  await Promise.all(Object.values(stores).map((s) => s.clear()));
  location.reload();
}

// ---- boot -------------------------------------------------------------------------------

let playground: Playground | undefined;

async function boot() {
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
  const restored = savedVfs !== undefined || savedPage !== undefined;
  if (savedPage) {
    Object.assign(settings, savedPage.settings);
    workerChosen = true;
    turns.push(...savedPage.turns);
    lastDiff = savedPage.turns.at(-1)?.report.diff ?? lastDiff;
    renderTurns();
  }
  const promptFor = (cwd: string) => `\x1b[36mharness\x1b[0m:\x1b[34m${cwd.replace(HOME, "~") || "/"}\x1b[0m$ `;
  const shell = (late.shell = new BashShell({ files: savedVfs ? {} : SAMPLE_FILES, cwd: HOME, greeting: GREETING, prompt: promptFor }));
  await shell.attach(write);
  const bash = shell.bash!;
  bashRef = bash;
  if (savedVfs) await restoreVfs(bash.fs, HOME, savedVfs);

  playground = await Playground.start({
    bash,
    tracer,
    models: { shell: shellModel(), claude },
    worker: () => settings.worker,
    approval: () => settings.approval,
    onSnapshot,
    storage: stores.daemon,
    conversations: storedConversations(stores.conversations),
  });
  const p = playground;
  vfsSaver = new Coalesced(async () => stores.vfs.save(await snapshotVfs(bash.fs, HOME)), (e) => storageProblem(`files: ${e}`));
  pageSaver = new Coalesced(() => stores.page.save({ version: 1, sessionId: p.sessionId, settings: { ...settings }, turns }), (e) => storageProblem(`page: ${e}`));
  for (const command of harnessCommands({
    playground: p,
    tracer,
    settings,
    prompter,
    write,
    workers: ["echo", "shell", "claude"],
    onChange: () => {
      sync();
      pageSaver?.request();
    },
    onTurn: (prompt, report) => {
      turns.push({ prompt, report });
      lastDiff = report.diff;
      renderTurns();
      void refreshFiles();
      saveAll();
    },
    onReset: reset,
  }))
    bash.registerCommand(command);
  await refreshFiles();
  sync();

  if (restored) {
    // Replace the first prompt with what was restored, then the session's log, then a new prompt.
    const sessions = await p.sessions();
    write(`\r\x1b[K\x1b[2mrestored from this browser: ${sessions.length} session${sessions.length === 1 ? "" : "s"}, ${files.size} file${files.size === 1 ? "" : "s"}, ${turns.length} turn${turns.length === 1 ? "" : "s"} (harness reset starts over)\x1b[0m\r\n`);
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
    document.documentElement.dataset["booted"] = "restored";
    await claudeReady;
    return;
  }

  // A first turn through the whole path (the shell worker, so no model usage), typed as a person would.
  const was = { worker: settings.worker, approval: settings.approval };
  settings.worker = "shell";
  settings.approval = "auto";
  await shell.handleInput(`ask '$ echo "- [x] ran a turn through the daemon" >> notes/todo.md && tail -n 1 notes/todo.md'`);
  await shell.handleInput("\r");
  Object.assign(settings, was, workerChosen || claudeState !== "ready" ? {} : { worker: "claude" });
  sync();
  saveAll();
  term.focus();
  document.documentElement.dataset["booted"] = "fresh";
  await claudeReady;
}

boot().catch((e: unknown) => {
  $("daemon-line").textContent = `failed to start: ${e instanceof Error ? e.message : String(e)}`;
  tracer.record({ kind: "host", name: "boot failed", detail: String(e) });
});
