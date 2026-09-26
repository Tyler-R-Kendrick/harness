// A daemon in a shared worker: one per origin, serving every tab that connects.
import { BrowserHost, IndexedDbStorage } from "@harness/platform-browser";
import type { PortSource } from "@harness/platform-browser";
import { EchoWorker } from "@harness/workers";

void BrowserHost.serve(self as unknown as PortSource, { worker: new EchoWorker(), identity: { principal: "profile", kind: "human" }, storage: new IndexedDbStorage({ name: "shared" }) });
