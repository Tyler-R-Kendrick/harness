import type { ModelMessage } from "ai";
import { z } from "zod";
import type { SnapshotStorage } from "@harness/core";
import type { ConversationStore } from "./agent.ts";

const stored = z.object({ version: z.literal(1), sessions: z.record(z.string(), z.array(z.unknown())) });

/**
 * Every session's conversation in one record of snapshot storage (a file on the native
 * host, IndexedDB in a browser), as plain data: `{ version: 1, sessions: { [id]: messages } }`.
 * Saves run one after another, each storing every session as it is then. Something else
 * in the record is no conversations; a failed load is tried again on the next one.
 */
export function storedConversations(storage: SnapshotStorage): ConversationStore {
  let sessions: Promise<Record<string, readonly ModelMessage[]>> | undefined;
  const loaded = () =>
    (sessions ??= storage.load().then(
      (value) => {
        const parsed = stored.safeParse(value);
        return parsed.success ? (parsed.data.sessions as Record<string, readonly ModelMessage[]>) : {};
      },
      (e: unknown) => {
        sessions = undefined;
        throw e;
      },
    ));
  let saving = Promise.resolve();
  return {
    load: async (sessionId) => (await loaded())[sessionId],
    save: async (sessionId, messages) => {
      const all = await loaded();
      all[sessionId] = messages;
      saving = saving.then(() => storage.save({ version: 1, sessions: all }));
      await saving;
    },
  };
}
