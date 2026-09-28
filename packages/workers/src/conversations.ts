import type { ModelMessage } from "ai";
import { z } from "zod";
import type { SnapshotStorage } from "@harness/core";
import type { ConversationStore } from "./agent.ts";

const stored = z.object({ version: z.literal(1), messages: z.array(z.unknown()) });

/**
 * Each session's conversation in a snapshot-storage record of its own (a file per session
 * on the native host, an IndexedDB key per session in a browser), as plain data:
 * `{ version: 1, messages }`. A turn writes only its session's record. Saves of a session
 * run in the order made, and one that fails does not stop the next; something else in a
 * record is no conversation.
 */
export function storedConversations(storageFor: (sessionId: string) => SnapshotStorage): ConversationStore {
  const saving = new Map<string, Promise<void>>();
  return {
    load: async (sessionId) => {
      const parsed = stored.safeParse(await storageFor(sessionId).load());
      return parsed.success ? (parsed.data.messages as ModelMessage[]) : undefined;
    },
    save: (sessionId, messages) => {
      const next = (saving.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(() => storageFor(sessionId).save({ version: 1, messages }));
      saving.set(sessionId, next);
      return next;
    },
  };
}
