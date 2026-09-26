import type { Entropy } from "./ports.ts";

/**
 * Durable identities. Each kind has its own prefix and is validated at runtime:
 * a TypeScript brand alone cannot stop a session id arriving where an effect id belongs.
 */
export const ID_KINDS = {
  principal: "prn",
  daemon: "dmn",
  workspace: "wsp",
  connection: "con",
  session: "ses",
  subagent: "sub",
  task: "tsk",
  node: "nod",
  attempt: "att",
  effect: "eff",
  message: "msg",
  request: "req",
  capability: "cap",
  provider: "prv",
  lease: "lea",
  plugin: "plg",
  event: "evt",
  correlation: "cor",
} as const;

export type IdKind = keyof typeof ID_KINDS;
export type Id<K extends IdKind> = string & { readonly __idKind: K };

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BYTES = 16;
const CHARS = 26; // ceil(128 / 5)
const BODY = new RegExp(`^[${ALPHABET}]{${CHARS}}$`);

function encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function newId<K extends IdKind>(kind: K, entropy: Entropy): Id<K> {
  const bytes = entropy.bytes(BYTES);
  if (bytes.length !== BYTES) throw new Error(`entropy returned ${bytes.length} bytes, expected ${BYTES}`);
  return `${ID_KINDS[kind]}_${encode(bytes)}` as Id<K>;
}

export function parseId<K extends IdKind>(kind: K, raw: unknown): Id<K> | undefined {
  if (typeof raw !== "string") return undefined;
  const prefix = `${ID_KINDS[kind]}_`;
  if (!raw.startsWith(prefix)) return undefined;
  const body = raw.slice(prefix.length);
  if (!BODY.test(body)) return undefined;
  // The last character carries 3 data bits and 2 padding bits that must be zero.
  const last = ALPHABET.indexOf(body.charAt(CHARS - 1));
  if ((last & 3) !== 0) return undefined;
  return raw as Id<K>;
}
