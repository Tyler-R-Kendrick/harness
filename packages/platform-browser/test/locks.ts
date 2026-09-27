import type { Locks } from "@harness/platform-browser";

/**
 * Web Locks as one browser profile has them: each name is granted in request order and
 * held until its callback settles. `die(name)` releases a hold the way a context's end
 * does, without its callback settling.
 */
export function profileLocks() {
  const queues = new Map<string, Promise<void>>();
  const holds = new Map<string, () => void>();
  const locks: Locks = {
    request(name, callback) {
      const granted = (queues.get(name) ?? Promise.resolve()).then(
        () =>
          new Promise<unknown>((resolve, reject) => {
            holds.set(name, () => resolve(undefined));
            callback().then(resolve, reject);
          }),
      );
      const held = granted.finally(() => holds.delete(name));
      queues.set(name, held.then(() => undefined, () => undefined));
      return held;
    },
  };
  return { locks, die: (name: string) => holds.get(name)?.(), held: () => [...holds.keys()] };
}
