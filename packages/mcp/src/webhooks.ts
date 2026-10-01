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

/** Accept a delivery whose signature matches `secret`; reject anything else. */
export function webhookDecision(
  secret: string,
  headers: { id?: string | undefined; timestamp?: string | undefined; signature?: string | undefined },
  body: string,
): "accept" | "reject" {
  if (!headers.id || !headers.timestamp || !headers.signature) return "reject";
  return verifyWebhook(secret, { id: headers.id, timestamp: headers.timestamp, signature: headers.signature }, body)
    ? "accept"
    : "reject";
}
