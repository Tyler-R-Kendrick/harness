// The daemon in an extension's service worker, serving the extension's pages over runtime ports.
import { invokeCognitive } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { ConstraintEngine } from "@harness/constrained";
import { instantiateEmscripten } from "@harness/models";
import { BrowserHost, buildBrowserEnsemble, CacheStorageByteCache, IndexedDbStorage, packagedEmscripten, xgrammarFromFactory, xgrammarFromSource } from "@harness/platform-browser";
import type { ExtensionPortSource } from "@harness/platform-browser";
import { EchoWorker } from "@harness/workers";
// Code an extension may not evaluate, packaged at build time instead (factoryImports).
import xgrammarBinding from "@mlc-ai/web-xgrammar?factory";
// Its source too, to show that evaluating it is what the policy refuses.
import xgrammarSource from "@mlc-ai/web-xgrammar?raw";
import engineSource from "./engine.js?raw";
import engineFactory from "./engine.js?factory";

declare const chrome: { runtime: { onConnect: ExtensionPortSource } };

// Listeners must be added as the worker's script runs; serveExtension does, and queues early ports.
void BrowserHost.serveExtension(chrome.runtime.onConnect, { worker: new EchoWorker(), identity: { principal: "profile", kind: "human" }, storage: new IndexedDbStorage({ name: "extension" }) });

/** Manifest V3's content security policy: code cannot be evaluated here. */
function evalRefused(): boolean {
  try {
    new Function("return 1");
    return false;
  } catch {
    return true;
  }
}

/**
 * Leave the caller's task first: a test drives these through DevTools, whose evaluation
 * is exempt from the page's policy for its own synchronous stack, but not afterwards.
 */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** XGrammar from its packaged binding: a JSON Schema constrains tokens, and a grammar it cannot parse is recovered from. */
async function xgrammar() {
  await nextTask();
  const vocab = [..."abcdefghijklmnopqrstuvwxyz0123456789{}\":, ", "<eos>"];
  const engine = await ConstraintEngine.create(xgrammarFromFactory(xgrammarBinding), { tokens: vocab, stopTokens: [vocab.length - 1] });
  const matcher = await engine.matcher({ type: "json-schema", schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } });
  const logits = new Float32Array(vocab.length);
  matcher.mask(logits);
  const broken = await engine.matcher({ type: "grammar", ebnf: "root ::= (" }).then(() => "compiled", (e: Error) => e.message);
  const after = await engine.matcher({ type: "regex", pattern: "[a-c]+" });
  const second = new Float32Array(vocab.length);
  after.mask(second);
  const fromSource = await ConstraintEngine.create(xgrammarFromSource(xgrammarSource), { tokens: vocab, stopTokens: [vocab.length - 1] }).then(
    () => "loaded",
    (e: Error) => e.message,
  );
  return { evalRefused: evalRefused(), allowed: vocab.filter((_, i) => logits[i] !== -Infinity), broken, afterBroken: vocab.filter((_, i) => second[i] !== -Infinity), fromSource };
}

/** A Cactus WASM router: its files fetched and verified, its loader run from the packaged copy. */
async function cognitive(model: ModelDescriptor, hub: string) {
  await nextTask();
  const route = { input: "go", tools: [{ name: "t", description: "", parameters: {} }] };
  // The default loader evaluates the verified source, which the policy refuses.
  const refused = await instantiateEmscripten(new TextEncoder().encode(engineSource), new Uint8Array([0, 97, 115, 109]), { name: "engine.js" }).then(
    () => "loaded",
    (e: Error) => e.message,
  );
  const ensemble = buildBrowserEnsemble({
    catalog: { models: [model], preferences: {} },
    hub,
    cache: new CacheStorageByteCache({ name: "extension-cognitive" }),
    emscripten: packagedEmscripten([{ source: engineSource, factory: engineFactory }]),
  });
  return { evalRefused: evalRefused(), refused, routed: await invokeCognitive(ensemble, "route", route) };
}

Object.assign(globalThis, { smoke: { xgrammar, cognitive } });
