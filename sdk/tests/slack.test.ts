// sdk/tests/slack.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSlackPostMessage, parseSlackBlockActions, parseSlackMessageEvent, SLACK_SHOW_CHOICES_LABEL, verifySlackSignature, verifySlackUrlVerification } from "../src/slack.js";
import type { WordlessSupportChatTurn } from "../src/server.js";

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

describe("parseSlackMessageEvent", () => {
  it("parses a user message and ignores bot/self/subtype events", () => {
    const body = { type: "event_callback", team_id: "T1",
      event: { type: "message", channel: "C1", user: "U1", ts: "1700000000.1", text: "charged twice" } };
    expect(parseSlackMessageEvent(body, "UBOT")).toMatchObject({ teamId: "T1", channelId: "C1", userId: "U1", messageTs: "1700000000.1", text: "charged twice" });
    expect(parseSlackMessageEvent({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U1", ts: "1", text: "x", bot_id: "B1" } }, "UBOT")).toMatchObject({ ignored: "not_a_user_message" });
    expect(parseSlackMessageEvent({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U1", ts: "1", subtype: "message_changed" } }, "UBOT")).toMatchObject({ ignored: "not_a_user_message" });
    expect(parseSlackMessageEvent({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "UBOT", ts: "1", text: "x" } }, "UBOT")).toMatchObject({ ignored: "not_a_user_message" });
  });
});

describe("parseSlackBlockActions", () => {
  it("parses a button action and ignores non-button payloads", () => {
    const payload = { type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.test/1", actions: [{ type: "button", action_id: "c1", value: "wl2.sg.x", action_ts: "1700000005.5" }] };
    expect(parseSlackBlockActions(payload)).toMatchObject({ teamId: "T1", channelId: "C1", userId: "U1", value: "wl2.sg.x", responseUrl: "https://hooks.slack.test/1" });
    expect(parseSlackBlockActions({ type: "shortcut" })).toMatchObject({ ignored: "not_a_button_action" });
  });
});

const SIG = "slack-choice-secret-000000000000000000";
const IN = { teamId: "T1", channelId: "C1", userId: "U1", messageTs: "1700000000.1" };
const SUG = "sg_" + "d".repeat(32);

describe("buildSlackPostMessage", () => {
  it("maps a grounded_reply to a text postMessage", () => {
    const turn = { kind: "grounded_reply", hostAction: "show_wordless", renderMode: "message", suggestionId: SUG,
      reviewRequired: true, readOnly: true, processingMs: 2, message: "Your last charge was $20.", choices: [], detectorId: null, evidenceIndexes: [0], reason: null } as any;
    const { request, pendingChoices } = buildSlackPostMessage(IN, turn, SIG, "nonceBB", 1000, 2000);
    expect(request.path).toBe("/chat.postMessage");
    expect((request.body as any).channel).toBe("C1");
    expect((request.body as any).text).toContain("$20");
    expect(pendingChoices).toBeNull();
  });

  it("maps clarification_choices to a Block Kit actions block with the full label", () => {
    const turn = { kind: "clarification_choices", hostAction: "show_wordless", renderMode: "choices", suggestionId: SUG,
      reviewRequired: true, readOnly: true, processingMs: 2, message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
      choices: [
        { id: "c1", label: "A duplicate charge", reply: "I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
        { id: "c2", label: "x", reply: "", detectorId: null, evidenceIndexes: [] },
      ] } as any;
    const { request, pendingChoices } = buildSlackPostMessage(IN, turn, SIG, "nonceBB", 1000, 2000);
    const blocks = (request.body as any).blocks;
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[1].text.text).toBe(SLACK_SHOW_CHOICES_LABEL);
    expect(actions.elements[0].value.startsWith("wl2.")).toBe(true);
    expect(pendingChoices?.choices).toHaveLength(2);
  });
});
