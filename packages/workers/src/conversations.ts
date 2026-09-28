import { modelMessageSchema } from "ai";
import { z } from "zod";
import type { SnapshotStorage } from "@harness/core";
import type { ConversationStore } from "./agent.ts";

const stored = z.object({ version: z.literal(1), messages: z.array(modelMessageSchema) });

/**
 * Each session's conversation in a snapshot-storage record of its own (a file per session
 * on the native host, an IndexedDB key per session in a browser), as plain data:
 * `{ version: 1, messages }`, the messages checked against the AI SDK's own schema. A turn
 * writes only its session's record. Saves of a session run in the order made, and one that
 * fails does not stop the next; a load waits for the session's saves in flight. Something
 * else in a record is no conversation.
 */
export function storedConversations(storageFor: (sessionId: string) => SnapshotStorage): ConversationStore {
  // Each session's latest save, until it settles.
  const saving = new Map<string, Promise<void>>();
  const settled = (sessionId: string) => (saving.get(sessionId) ?? Promise.resolve()).catch(() => undefined);
  return {
    load: async (sessionId) => {
      await settled(sessionId);
      const parsed = stored.safeParse(await storageFor(sessionId).load());
      return parsed.success ? parsed.data.messages : undefined;
    },
    save: (sessionId, messages) => {
      const next = settled(sessionId).then(() => storageFor(sessionId).save({ version: 1, messages }));
      saving.set(sessionId, next);
      const forget = () => {
        if (saving.get(sessionId) === next) saving.delete(sessionId);
      };
      next.then(forget, forget);
      return next;
    },
  };
}
