/**
 * Canonical JSON and content hashes. A revision id or entry id is the sha256 of a
 * value's canonical JSON, so equal content has one id on every host: object keys are
 * sorted by code unit at every depth, there is no whitespace, and arrays keep their
 * order (callers sort what is a set before hashing).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** JSON with sorted keys and no whitespace. Undefined fields are dropped and undefined items are null, as in JSON. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  // Undefined (and anything else JSON cannot write) becomes null, as JSON does inside arrays.
  return JSON.stringify(value) ?? "null";
}

/** The sha256 of text's UTF-8 bytes, as lowercase hex. */
export const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));
