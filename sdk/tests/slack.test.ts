// sdk/tests/slack.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSlackPostMessage, createSlackAdapter, parseSlackBlockActions, parseSlackMessageEvent, SLACK_SHOW_CHOICES_LABEL, SlackWebhookValidationError, verifySlackSignature, verifySlackUrlVerification } from "../src/slack.js";
import type { SlackChoiceStore, SlackPendingChoiceSet, SlackResolvedChoice } from "../src/slack.js";
import type { WordlessSupportChatTurn } from "../src/server.js";
import { WordlessSdkError } from "../src/server.js";

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

const SS = "slack-signing-secret-0000000000000000";
const CS = "slack-choice-secret-000000000000000000";
const CLOCK = () => new Date("2023-11-14T22:13:30.000Z");
const TS2 = String(Math.floor(CLOCK().getTime() / 1000));
function sig(body: string) { return "v0=" + createHmac("sha256", SS).update(`v0:${TS2}:${body}`, "utf8").digest("hex"); }

function store(): SlackChoiceStore {
  const sets = new Map<string, SlackPendingChoiceSet>(); const used = new Map<string, SlackResolvedChoice>();
  return {
    async save(s) { for (const c of s.choices) sets.set(`${s.teamId}:${s.channelId}:${s.userId}:${c.payload}`, s); },
    async resolve(i) {
      const key = `${i.teamId}:${i.channelId}:${i.userId}:${i.payload}`; const s = sets.get(key);
      if (!s) return used.get(i.selectionActionTs) ?? null;
      const c = s.choices.find((x) => x.payload === i.payload)!;
      const r: SlackResolvedChoice = { suggestionId: s.suggestionId, choiceId: c.id, detectorId: c.detectorId, reply: c.reply, feedback: c.feedback };
      sets.delete(key); used.set(i.selectionActionTs, r); return r;
    },
  };
}
function chatbot(recorded: unknown[] = []) {
  return { async processMessage() {
      return { kind: "clarification_choices", hostAction: "show_wordless", renderMode: "choices", suggestionId: "sg_" + "e".repeat(32),
        reviewRequired: true, readOnly: true, processingMs: 1, message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
        choices: [ { id: "c1", label: "A duplicate charge", reply: "I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
                   { id: "c2", label: "x", reply: "", detectorId: null, evidenceIndexes: [] } ] } as any; },
    async recordConfirmation(c: unknown) { recorded.push(c); return {} as any; } };
}
const acct = { authenticated: true as const, customerId: "acct_9", observedAt: "2023-11-14T22:13:25.000Z", evidence: [] };
function eventBody(text: string) {
  return JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U1", ts: "1700000000.1", text } });
}

describe("createSlackAdapter", () => {
  it("posts clarification buttons for a supportable message", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const body = eventBody("charged twice");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect(outcome.kind).toBe("result");
    expect((outcome as any).result.kind).toBe("post_message");
  });

  it("handles the url_verification handshake", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect(outcome).toMatchObject({ kind: "url_verification", challenge: "abc" });
  });

  it("resolves a tapped button once and records confirmation", async () => {
    const recorded: unknown[] = []; const shared = store();
    const adapter = createSlackAdapter({ chatbot: chatbot(recorded) as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: shared, now: CLOCK });
    const body = eventBody("charged twice");
    const posted = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    const payload = (posted as any).result.request.body.blocks.find((b: any) => b.type === "actions").elements[0].value as string;
    const interaction = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.test/1", actions: [{ type: "button", action_id: "c1", value: payload, action_ts: "1700000005.5" }] }));
    const result = await adapter.processInteraction(interaction, { signature: sig(interaction), timestamp: TS2 });
    expect(result.kind).toBe("post_message");
    expect(recorded).toHaveLength(1);
    const result2 = await adapter.processInteraction(interaction.replace("1700000005.5", "1700000009.9"), { signature: sig(interaction.replace("1700000005.5", "1700000009.9")), timestamp: TS2 });
    expect(result2).toMatchObject({ kind: "continue", reason: "choice_replayed" });
  });

  it("rejects a bad signature on processEvent and processInteraction", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const body = eventBody("x");
    await expect(adapter.processEvent(body, { signature: "v0=bad", timestamp: TS2 })).rejects.toThrow(SlackWebhookValidationError);
    const interaction = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions" }));
    await expect(adapter.processInteraction(interaction, { signature: "v0=bad", timestamp: TS2 })).rejects.toThrow(SlackWebhookValidationError);
  });

  it("ignores non-user-message events and non-button interactions", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const botBody = JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U1", ts: "1", text: "x", bot_id: "B1" } });
    const outcome = await adapter.processEvent(botBody, { signature: sig(botBody), timestamp: TS2 });
    expect(outcome).toMatchObject({ kind: "ignored" });
    const shortcut = "payload=" + encodeURIComponent(JSON.stringify({ type: "shortcut" }));
    const result = await adapter.processInteraction(shortcut, { signature: sig(shortcut), timestamp: TS2 });
    expect(result).toMatchObject({ kind: "ignored", reason: "not_a_button_action" });
  });

  it("continues when the account is unauthenticated", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => null, choiceStore: store(), now: CLOCK });
    const body = eventBody("charged twice");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect((outcome as any).result).toMatchObject({ kind: "continue", reason: "account_not_authenticated" });
  });

  it("continues safely on a Wordless error", async () => {
    const failing = { processMessage: async () => { throw new WordlessSdkError("boom"); }, recordConfirmation: async () => ({}) } as any;
    const errors: unknown[] = [];
    const adapter = createSlackAdapter({ chatbot: failing, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK, onWordlessError: (e) => errors.push(e) });
    const body = eventBody("charged twice");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect((outcome as any).result).toMatchObject({ kind: "continue", reason: "wordless_unavailable" });
    expect(errors).toHaveLength(1);
  });

  it("continues before mapping when the chatbot hands control back to the host bot", async () => {
    const passing = { processMessage: async () => ({ kind: "no_match", hostAction: "continue_host_bot", renderMode: "message", suggestionId: "sg_" + "f".repeat(32),
      reviewRequired: false, readOnly: true, processingMs: 1, message: null, choices: [], detectorId: null, evidenceIndexes: [], reason: null }), recordConfirmation: async () => ({}) } as any;
    const adapter = createSlackAdapter({ chatbot: passing, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const body = eventBody("something unrelated");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect((outcome as any).result).toMatchObject({ kind: "continue", reason: "continue_host_bot" });
  });

  it("hands off to a human when human handoff is enabled and requested", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK, humanHandoff: { enabled: true } });
    const body = eventBody("connect me to a human");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect((outcome as any).result).toMatchObject({ kind: "handoff", reason: "human_requested" });
  });

  it("does not hand off the same phrasing when human handoff is disabled", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const body = eventBody("connect me to a human");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect((outcome as any).result.kind).not.toBe("handoff");
    expect((outcome as any).result.kind).toBe("post_message");
  });

  it("returns a safe continue and reports the error when the resolver throws under accountResolutionFailureMode: continue", async () => {
    const boom = new Error("resolver exploded");
    const errors: unknown[] = [];
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => { throw boom; }, choiceStore: store(), now: CLOCK,
      accountResolutionFailureMode: "continue", onAccountResolutionError: (error) => errors.push(error) });
    const body = eventBody("charged twice");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect((outcome as any).result).toMatchObject({ kind: "continue", reason: "account_not_authenticated" });
    expect(errors).toEqual([boom]);
  });

  it("propagates the resolver's error out of processEvent by default", async () => {
    const boom = new Error("resolver exploded");
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => { throw boom; }, choiceStore: store(), now: CLOCK });
    const body = eventBody("charged twice");
    await expect(adapter.processEvent(body, { signature: sig(body), timestamp: TS2 })).rejects.toBe(boom);
  });

  it("best-effort reports a recordConfirmation failure without failing the reply", async () => {
    const feedbackErrors: unknown[] = [];
    const boom = new Error("record failed");
    const failingRecord = { ...chatbot(), recordConfirmation: async () => { throw boom; } };
    const shared = store();
    const adapter = createSlackAdapter({ chatbot: failingRecord as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: shared, now: CLOCK, onFeedbackError: (e) => feedbackErrors.push(e) });
    const body = eventBody("charged twice");
    const posted = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    const payload = (posted as any).result.request.body.blocks.find((b: any) => b.type === "actions").elements[0].value as string;
    const interaction = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.test/1", actions: [{ type: "button", action_id: "c1", value: payload, action_ts: "1700000005.5" }] }));
    const result = await adapter.processInteraction(interaction, { signature: sig(interaction), timestamp: TS2 });
    expect(result.kind).toBe("post_message");
    expect(feedbackErrors).toEqual([boom]);
  });

  it("treats an expired signed button payload as a safe continue, without recording confirmation", async () => {
    const recorded: unknown[] = [];
    const shared = store();
    let currentTime = CLOCK();
    const adapter = createSlackAdapter({ chatbot: chatbot(recorded) as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: shared, now: () => currentTime, choiceTtlMs: 60_000 });
    const body = eventBody("charged twice");
    const postedTs = String(Math.floor(currentTime.getTime() / 1000));
    const posted = await adapter.processEvent(body, { signature: sig(body), timestamp: postedTs });
    const payload = (posted as any).result.request.body.blocks.find((b: any) => b.type === "actions").elements[0].value as string;
    currentTime = new Date(currentTime.getTime() + 61_000);
    const laterTs = String(Math.floor(currentTime.getTime() / 1000));
    const interaction = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.test/1", actions: [{ type: "button", action_id: "c1", value: payload, action_ts: "1700000005.5" }] }));
    const laterSig = "v0=" + createHmac("sha256", SS).update(`v0:${laterTs}:${interaction}`, "utf8").digest("hex");
    const result = await adapter.processInteraction(interaction, { signature: laterSig, timestamp: laterTs });
    expect(result).toMatchObject({ kind: "continue", reason: "choice_replayed" });
    expect(recorded).toHaveLength(0);
  });
});
