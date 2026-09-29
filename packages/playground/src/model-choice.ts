/**
 * Which model the page uses for a role, when the person has not picked one: the
 * best-ranked candidate (local ones first) that this browser can run. A local model
 * needs a WebGPU adapter when it is large (on WebAssembly alone it takes seconds a call),
 * room in the browser's storage for its download, a browser that does not ask to save
 * data, and files the browser kept the last time it was downloaded. A model whose files
 * the browser kept downloads nothing, so it needs neither room nor data.
 */
import type { ModelDescriptor } from "@harness/cognitive";
import type { EngineSettings } from "./engine-settings.ts";

/** What this browser offers a local model. */
export interface Capabilities {
  /** Whether a WebGPU adapter is available. */
  readonly webgpu: boolean;
  /** The storage the page may still use, when the browser says. */
  readonly freeBytes: number | undefined;
  /** Whether the browser asks pages to save data (a metered connection). */
  readonly saveData: boolean;
}

/** What became of a model's files on an earlier visit: kept in this browser, or not (and why). */
export type Past = { readonly kept: true } | { readonly kept: false; readonly reason: string };

type Candidate = Pick<ModelDescriptor, "id" | "downloadBytes" | "locality">;
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** Why a model does not fit this browser, if it does not. */
export function unfit(m: Omit<Candidate, "id">, capabilities: Capabilities, settings: EngineSettings["choice"], past?: Past): string | undefined {
  if (m.locality !== "local") return undefined;
  if (past?.kept === false) return `not kept in this browser last time (${past.reason})`;
  if (m.downloadBytes > settings.gpuBytes && !capabilities.webgpu) return `no WebGPU adapter for a ${mb(m.downloadBytes)} model`;
  if (past?.kept) return undefined;
  if (capabilities.saveData) return "this browser asks to save data";
  if (capabilities.freeBytes !== undefined && capabilities.freeBytes < m.downloadBytes * settings.headroom) return `${mb(capabilities.freeBytes)} free for a ${mb(m.downloadBytes)} download`;
  return undefined;
}

export interface Choice<M> {
  readonly model?: M;
  /** The better-ranked candidates that did not fit, and why. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/** The first of the ranked candidates (best first) that fits this browser, and is not vetoed (one that failed to load, say). */
export function chooseModel<M extends Candidate>(ranked: readonly M[], capabilities: Capabilities, settings: EngineSettings["choice"], past: (id: string) => Past | undefined, veto: (id: string) => string | undefined = () => undefined): Choice<M> {
  const skipped: { id: string; reason: string }[] = [];
  for (const m of ranked) {
    const reason = veto(m.id) ?? unfit(m, capabilities, settings, past(m.id));
    if (reason === undefined) return { model: m, skipped };
    skipped.push({ id: m.id, reason });
  }
  return { skipped };
}
