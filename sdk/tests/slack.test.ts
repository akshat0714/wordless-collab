// sdk/tests/slack.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature, verifySlackUrlVerification } from "../src/slack.js";

const SECRET = "slack-signing-secret-0000000000000000";
const NOW = () => new Date("2023-11-14T22:13:30.000Z");
const TS = String(Math.floor(NOW().getTime() / 1000));
function sign(body: string, ts = TS) {
  return "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`, "utf8").digest("hex");
}

describe("verifySlackSignature", () => {
  it("accepts a valid signature and rejects tampering, wrong secret, and stale timestamps", () => {
    const body = "payload=x";
    expect(verifySlackSignature(body, { signature: sign(body), timestamp: TS }, SECRET, NOW)).toBe(true);
    expect(verifySlackSignature(body, { signature: "v0=bad", timestamp: TS }, SECRET, NOW)).toBe(false);
    const staleTs = String(Math.floor(NOW().getTime() / 1000) - 600);
    expect(verifySlackSignature(body, { signature: sign(body, staleTs), timestamp: staleTs }, SECRET, NOW)).toBe(false);
    expect(verifySlackSignature(body, { signature: null, timestamp: TS }, SECRET, NOW)).toBe(false);
  });
});

describe("verifySlackUrlVerification", () => {
  it("returns the challenge only for url_verification", () => {
    expect(verifySlackUrlVerification({ type: "url_verification", challenge: "c1" })).toBe("c1");
    expect(verifySlackUrlVerification({ type: "event_callback" })).toBeNull();
  });
});
