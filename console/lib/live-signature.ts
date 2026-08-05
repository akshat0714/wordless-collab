import { createHmac } from "node:crypto";

export function createLiveRequestSignature({
  body,
  idempotencyKey,
  path,
  secret,
  timestamp,
}: {
  body: string;
  idempotencyKey: string;
  path: string;
  secret: string;
  timestamp: string;
}): string {
  const canonicalPrefix = `v1:${timestamp}\nPOST\n${path}\n${idempotencyKey}\n`;
  return createHmac("sha256", secret)
    .update(canonicalPrefix, "utf8")
    .update(body, "utf8")
    .digest("hex");
}
