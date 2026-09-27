import { codeModeContract } from "@harness/testkit";
import type { CodeModeContractHost } from "@harness/testkit";
import { quickjsCodeMode } from "@harness/workflows";
import { aiCodeMode } from "@harness/workflows/node";

const host: CodeModeContractHost = { delay: (ms) => new Promise((r) => setTimeout(r, ms)), abortable: () => new AbortController() };

// Workflows run the same on every host: AI SDK code mode natively, QuickJS (WebAssembly) anywhere.
codeModeContract("AI SDK code mode (Node)", () => aiCodeMode, host);
codeModeContract("QuickJS", () => quickjsCodeMode(), host);
