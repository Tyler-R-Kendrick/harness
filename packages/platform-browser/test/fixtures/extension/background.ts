// The daemon in an extension's service worker, serving the extension's pages over runtime ports.
import { BrowserHost, IndexedDbStorage } from "@harness/platform-browser";
import type { ExtensionPortSource } from "@harness/platform-browser";
import { EchoWorker } from "@harness/workers";

declare const chrome: { runtime: { onConnect: ExtensionPortSource } };

// Listeners must be added as the worker's script runs; serveExtension does, and queues early ports.
void BrowserHost.serveExtension(chrome.runtime.onConnect, { worker: new EchoWorker(), identity: { principal: "profile", kind: "human" }, storage: new IndexedDbStorage({ name: "extension" }) });
