import { createHmac, timingSafeEqual } from "node:crypto";

/** Decode a Standard Webhooks `whsec_` secret. A raw secret is used as UTF-8. */
export function webhookKey(secret: string): Buffer {
  if (secret.startsWith("whsec_")) return Buffer.from(secret.slice("whsec_".length), "base64");
  return Buffer.from(secret, "utf8");
}

/**
 * Standard Webhooks v1 signature: base64 HMAC-SHA256 over
 * `id.timestamp.body`.
 */
export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const mac = createHmac("sha256", webhookKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

export function verifyWebhook(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
): boolean {
  const expected = signWebhook(secret, headers.id, headers.timestamp, body);
  const presented = headers.signature.split(" ").filter((part) => part.startsWith("v1,"));
  const expectedBytes = Buffer.from(expected);
  return presented.some((part) => {
    const got = Buffer.from(part);
    return got.length === expectedBytes.length && timingSafeEqual(got, expectedBytes);
  });
}

export interface WebhookFreshness {
  /** Milliseconds since the epoch; defaults to now. */
  readonly now?: number;
  /** How old a delivery may be, in seconds. Defaults to five minutes. */
  readonly toleranceSeconds?: number;
  /** Deliveries already accepted; an id seen before is a replay. */
  readonly seen?: { has(id: string): boolean; add(id: string): void };
}

/**
 * Accept a delivery whose signature matches `secret`, whose timestamp is fresh, and whose
 * id is new; reject anything else. A valid signature alone proves nothing about replay.
 */
export function webhookDecision(
  secret: string,
  headers: { id?: string | undefined; timestamp?: string | undefined; signature?: string | undefined },
  body: string,
  freshness: WebhookFreshness = {},
): "accept" | "reject" {
  if (!headers.id || !headers.timestamp || !headers.signature) return "reject";
  const now = freshness.now ?? Date.now();
  const at = Number(headers.timestamp) * 1000;
  if (!Number.isFinite(at) || Math.abs(now - at) > (freshness.toleranceSeconds ?? 300) * 1000) return "reject";
  if (freshness.seen?.has(headers.id)) return "reject";
  const valid = verifyWebhook(secret, { id: headers.id, timestamp: headers.timestamp, signature: headers.signature }, body);
  if (valid) freshness.seen?.add(headers.id);
  return valid ? "accept" : "reject";
}
