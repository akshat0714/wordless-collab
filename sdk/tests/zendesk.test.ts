// @vitest-environment node

import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  ZENDESK_HUMAN_PAYLOAD,
  ZENDESK_SHOW_CHOICES_PAYLOAD,
  ZendeskWebhookValidationError,
  createZendeskCompositionHelpMessage,
  createZendeskControlReleasePlan,
  createZendeskConversationsClient,
  createZendeskMessagingAdapter,
  createZendeskPassControlRequest,
  createZendeskReleaseControlRequest,
  preflightZendeskWebhook,
  type ZendeskChoiceStore,
  type ZendeskPendingChoiceSet,
} from "../src/zendesk";
import type {
  WordlessFeedbackResponse,
  WordlessSupportChatTurn,
  WordlessSupportChatbot,
} from "../src/server";

const APP_ID = "app-0123456789";
const WEBHOOK_ID = "webhook-0123456789";
const SWITCHBOARD_ID = "switchboard-integration-1";
const USER_ID = "user-0123456789";
const CONVERSATION_ID = "conversation-0123456789";
const MESSAGE_ID = "message-0123456789";
const EVENT_ID = "event-0123456789";
const SUGGESTION_ID = "sg_0123456789abcdef0123456789abcdef";
const CHOICE_SECRET = "zendesk-choice-signing-secret-at-least-32-bytes";

const EVIDENCE = [
  {
    type: "charge" as const,
    ref: "charge-1",
    occurred_at: "2026-07-30T19:00:00Z",
    order_ref: "order-441",
    amount: "84.00",
    currency: "USD",
    status: "succeeded" as const,
  },
  {
    type: "charge" as const,
    ref: "charge-2",
    occurred_at: "2026-07-30T19:04:00Z",
    order_ref: "order-441",
    amount: "84.00",
    currency: "USD",
    status: "succeeded" as const,
  },
] as const;

const clarification = {
  kind: "clarification_choices",
  hostAction: "show_wordless",
  renderMode: "choices",
  suggestionId: SUGGESTION_ID,
  reviewRequired: true,
  readOnly: true,
  processingMs: 17,
  message: "Which option best matches what you need?",
  choices: [
    {
      id: "duplicate_charge",
      label: "Charged twice",
      reply: "I was charged twice for the same order.",
      detectorId: "duplicate_charge",
      evidenceIndexes: [0, 1],
    },
    {
      id: "something_else",
      label: "Something else",
      reply: "I need help with something else.",
      detectorId: null,
      evidenceIndexes: [],
    },
  ],
  detectorId: "duplicate_charge",
  evidenceIndexes: [0, 1],
  reason: null,
} as const satisfies WordlessSupportChatTurn;

const belowConfidence = {
  kind: "clarifying_fallback",
  hostAction: "continue_host_bot",
  renderMode: "none",
  suggestionId: "sg_11111111111111111111111111111111",
  reviewRequired: true,
  readOnly: true,
  processingMs: 12,
  message: null,
  choices: [],
  detectorId: null,
  evidenceIndexes: [],
  reason: "below_confidence_floor",
} as const satisfies WordlessSupportChatTurn;

const noRelevantEvidence = {
  ...belowConfidence,
  suggestionId: "sg_22222222222222222222222222222222",
  reason: "no_relevant_evidence",
} as const satisfies WordlessSupportChatTurn;

const navigation = {
  kind: "clarifying_fallback",
  hostAction: "show_wordless",
  renderMode: "choices",
  suggestionId: "sg_33333333333333333333333333333333",
  reviewRequired: true,
  readOnly: true,
  processingMs: 9,
  message: "Choose what you need help with.",
  choices: [
    {
      id: "payment_help",
      label: "Billing or charges",
      reply: "I need help with billing or a charge.",
      detectorId: null,
      evidenceIndexes: [],
    },
    {
      id: "delivery_or_item",
      label: "Orders or delivery",
      reply: "I need help with an order or delivery.",
      detectorId: null,
      evidenceIndexes: [],
    },
  ],
  detectorId: null,
  evidenceIndexes: [],
  reason: "insufficient_context",
} as const satisfies WordlessSupportChatTurn;

const feedback: WordlessFeedbackResponse = {
  schema_version: 1,
  feedback_id: "fb_0123456789abcdef0123456789abcdef",
  suggestion_id: SUGGESTION_ID,
  recorded: true,
  outcome: "confirmed",
  selected_detector_id: "duplicate_charge",
  actor: "customer",
  recorded_at: "2026-07-30T20:00:01Z",
};

function webhook(options: {
  text?: string;
  payload?: string;
  authorType?: "user" | "business";
  activeId?: string;
  contentType?: string;
  eventType?: string;
  eventId?: string;
  receivedAt?: string;
  integrationId?: string;
  userId?: string;
  conversationId?: string;
  messageId?: string;
} = {}): unknown {
  const authorType = options.authorType ?? "user";
  return {
    app: { id: APP_ID },
    webhook: { id: WEBHOOK_ID, version: "v2" },
    events: [
      {
        id: options.eventId ?? EVENT_ID,
        type: options.eventType ?? "conversation:message",
        createdAt: "2026-07-30T20:00:00Z",
        payload: {
          conversation: {
            id: options.conversationId ?? CONVERSATION_ID,
            activeSwitchboardIntegration: {
              id: options.activeId ?? SWITCHBOARD_ID,
              integrationId: options.integrationId ?? "underlying-integration-1",
              integrationType: "custom",
            },
          },
          message: {
            id: options.messageId ?? MESSAGE_ID,
            received: options.receivedAt ?? "2026-07-30T20:00:00Z",
            author: {
              type: authorType,
              ...(authorType === "user" ? { userId: options.userId ?? USER_ID } : {}),
            },
            content: {
              type: options.contentType ?? "text",
              ...(options.text === undefined ? { text: "money one twice" } : { text: options.text }),
              ...(options.payload === undefined ? {} : { payload: options.payload }),
            },
            source: { type: "web", integrationId: "web-channel-1" },
          },
        },
      },
    ],
  };
}

function choiceStore(): ZendeskChoiceStore {
  const choices = new Map<string, {
    set: ZendeskPendingChoiceSet;
    choice: ZendeskPendingChoiceSet["choices"][number];
    selectionEventId: string | null;
  }>();
  return {
    async save(set) {
      for (const choice of set.choices) {
        choices.set(choice.payload, { set, choice, selectionEventId: null });
      }
    },
    async resolve(input) {
      const stored = choices.get(input.payload);
      if (stored === undefined) return null;
      if (Date.parse(input.selectionReceivedAt) > Date.parse(stored.set.expiresAt)) return null;
      if (
        stored.selectionEventId !== null &&
        stored.selectionEventId !== input.selectionEventId
      ) return null;
      stored.selectionEventId = input.selectionEventId;
      return {
        appId: stored.set.appId,
        conversationId: stored.set.conversationId,
        userId: stored.set.userId,
        suggestionId: stored.set.suggestionId,
        sourceMessageId: stored.set.sourceMessageId,
        sourceMessageNonce: stored.set.sourceMessageNonce,
        issuedAt: stored.set.issuedAt,
        expiresAt: stored.set.expiresAt,
        selectionEventId: input.selectionEventId,
        choiceId: stored.choice.id,
        detectorId: stored.choice.detectorId,
        reply: stored.choice.reply,
        feedback: stored.choice.feedback,
      };
    },
  };
}

function harness(...turns: readonly WordlessSupportChatTurn[]) {
  let currentNow = Date.parse("2026-07-30T20:00:01Z");
  const processMessage = vi.fn();
  for (const turn of turns) processMessage.mockResolvedValueOnce(turn);
  const recordConfirmation = vi.fn().mockResolvedValue(feedback);
  const onFeedbackError = vi.fn();
  const chatbot = { processMessage, recordConfirmation } as unknown as WordlessSupportChatbot;
  const resolveAuthenticatedAccount = vi.fn().mockImplementation(
    async (incoming: { readonly receivedAt: string }) => ({
      authenticated: true as const,
      customerId: "company-customer-17",
      observedAt: new Date(Math.max(currentNow, Date.parse(incoming.receivedAt))).toISOString(),
      evidence: EVIDENCE,
      metadata: { plan: "gold" },
    }),
  );
  const adapter = createZendeskMessagingAdapter({
    chatbot,
    expectedAppId: APP_ID,
    expectedWebhookId: WEBHOOK_ID,
    switchboardIntegrationId: SWITCHBOARD_ID,
    humanSwitchboardIntegrationId: "human-agent-switchboard",
    choiceSigningSecret: CHOICE_SECRET,
    choiceStore: choiceStore(),
    now: () => new Date(currentNow),
    resolveAuthenticatedAccount,
    accountResolutionFailureMode: "pass_control",
    onFeedbackError,
  });
  return {
    adapter,
    processMessage,
    recordConfirmation,
    onFeedbackError,
    resolveAuthenticatedAccount,
    setNow(value: string) { currentNow = Date.parse(value); },
  };
}

describe("Zendesk Messaging adapter", () => {
  it("sends an unclear customer message and authenticated evidence through Wordless", async () => {
    const { adapter, processMessage } = harness(clarification);

    const [result] = await adapter.processWebhook(webhook({ text: "money one twice" }));

    expect(processMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: MESSAGE_ID,
      customerId: "company-customer-17",
      text: "money one twice",
      channel: "chat",
      evidence: EVIDENCE,
      metadata: expect.objectContaining({
        zendesk_conversation_id: CONVERSATION_ID,
        zendesk_assistance_path: "auto",
      }),
    }));
    expect(result).toMatchObject({
      kind: "post_message",
      deduplicationKey: EVENT_ID,
      handoff: null,
      request: {
        path: `/sc/v2/apps/${APP_ID}/conversations/${CONVERSATION_ID}/messages`,
        body: {
          author: { type: "business" },
          metadata: { wordless_delivery_key: EVENT_ID },
          content: {
            type: "text",
            blockChatInput: false,
            actions: [
              { type: "reply", text: "Charged twice", payload: expect.stringMatching(/^wl2\./u) },
              { type: "reply", text: "Something else", payload: expect.stringMatching(/^wl2\./u) },
            ],
          },
        },
      },
      pendingChoices: {
        suggestionId: SUGGESTION_ID,
        sourceMessageNonce: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
        issuedAt: "2026-07-30T20:00:01.000Z",
        expiresAt: "2026-07-30T20:30:01.000Z",
        choices: [
          { detectorId: "duplicate_charge", feedback: "confirmed" },
          { detectorId: null, feedback: "none" },
        ],
      },
    });
  });

  it("retries a below-confidence fragment as evidence-only show choices", async () => {
    const { adapter, processMessage } = harness(belowConfidence, navigation);

    const [result] = await adapter.processWebhook(webhook({ text: "thing was uh no same" }));

    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(processMessage.mock.calls[0]?.[0]).toMatchObject({
      text: "thing was uh no same",
      metadata: { zendesk_assistance_path: "auto" },
    });
    expect(processMessage.mock.calls[1]?.[0]).toMatchObject({
      messageId: `${MESSAGE_ID}:choices`,
      text: "",
      showChoices: true,
      metadata: { zendesk_assistance_path: "unclear_fallback" },
    });
    expect(result).toMatchObject({ kind: "post_message" });
  });

  it("routes an unrelated ordinary message to the next host bot", async () => {
    const { adapter, processMessage } = harness(noRelevantEvidence);

    const [result] = await adapter.processWebhook(
      webhook({ text: "How do I change notification settings?" }),
    );

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "pass_control",
      request: {
        path: `/sc/v2/apps/${APP_ID}/conversations/${CONVERSATION_ID}/passControl`,
        body: {
          switchboardIntegration: "next",
          metadata: { first_message_id: MESSAGE_ID },
        },
      },
      handoff: { target: "next", reason: "wordless_yielded" },
    });
  });

  it("passes an explicit request for a human directly to Agent Workspace without resolving evidence", async () => {
    const setup = harness(clarification);

    const [result] = await setup.adapter.processWebhook(
      webhook({ text: "Please connect me to a real person" }),
    );

    expect(result).toMatchObject({
      kind: "pass_control",
      handoff: { reason: "human_requested", target: "human" },
      request: {
        body: {
          switchboardIntegration: "human-agent-switchboard",
          metadata: { handoff_reason: "human_requested" },
        },
      },
    });
    expect(setup.resolveAuthenticatedAccount).not.toHaveBeenCalled();
    expect(setup.processMessage).not.toHaveBeenCalled();
  });

  it("recognizes common explicit human requests without resolving evidence", async () => {
    const messages = [
      "I need a support person.",
      "I would like a support agent.",
      "Can I be connected to a representative?",
      "Could you put me through to a live agent?",
      "Can I speak to an operator?",
      "Please escalate this to a supervisor.",
      "Can I speak with someone?",
      "I need a manager",
      "Please let me talk to a real person",
      "Let me talk to a person",
      "Can I speak to your supervisor?",
      "Is there a human I can talk to?",
      "A real person would be better",
      "Can I talk to support?",
      "plese humna",
      "need humen",
      "tak to persn",
      "want agnet",
      "manger plese",
      "represntative please",
      "plz humna",
      "humn pls",
      "humna plz",
      "persn pls",
      "agent pls",
      "spk to human",
      "I'm asking for a manager",
      "I am requesting a supervisor",
      "Send me to a person",
      "Give me a human",
      "Please have a human call me",
      "Can someone help me?",
      "Can I talk to somebody?",
      "A human should take over",
      "Can someone please help me?",
      "a live human",
      "human help",
      "I need help from a human",
      "Can I speak to a different agent?",
      "I don't want a bot, just a human",
      "I don't want a bot and just want a human",
      "uman pls",
      "mgr pls",
      "need mangr",
      "hlp human",
      "Can't I speak to a human?",
      "Why can't I talk to a person?",
      "I can't get through to a person",
      "No I want a human",
      "I do not want a bot I want a human",
      "Can I not talk to the bot and get a human?",
      "Can I speak to another agent?",
      "Can I talk to customer support?",
      "Talk to a team member",
      "Actual human please",
      "A human being please",
      "Human assistance please",
      "Please escalate this",
      "Hand me off",
      "Let the human take over",
      "human hlp",
      "humna hlp",
      "persn hlp",
      "wnt humna",
      "I used to want a bot. Now I need a human",
      "I never asked for an agent. Please connect me to a person now",
      "Do I need a human? Actually connect me to a manager",
      "I need someone to deliver my order, but now connect me to an agent",
      "Transfer me",
      "Put me through",
      "Can I be transferred?",
      "human need",
      "humna need",
      "persn talk",
      "agent want",
      "manger need",
      "I don't want a bot and want a human",
      "I don't want to keep talking to a bot—connect me to a person",
      "I don't want a bot: connect me to a human",
      "I don't want a bot - connect me to a human",
      "I don't want a bot / connect me to a human",
      "I need a human because the bot is broken",
      "I want the bot to connect me to a person",
      "The bot can't connect me to a human",
      "I never said: I want a human. Connect me to a manager now",
      "Can you transfer me?",
      "I want to be transferred",
      "Pass me to a person",
      "Route me to an agent",
      "Forward me to support",
      "Can I speak to a member of your team?",
      "Can I speak to the customer service team?",
      "Can I speak to someone else?",
      "human connect",
      "humna transfer",
      "persn connect me",
      "I want a human. No, not the bot.",
      "Human please. No, don't keep the bot.",
      "Can you please transfer me?",
      "Could you put me through?",
      "Can you hand me off?",
      "Could you escalate this?",
      "I want you to transfer me",
      "I need to be transferred now.",
      "Please connect me now.",
      "Please transfer me right now.",
      "Connect me to a manager anyway.",
      "Can I speak to an advisor?",
      "Can I speak to a specialist?",
      "Can I speak to a member of staff?",
      "I need a human to guide me.",
      "I want an agent to email me.",
      "I need a person to verify my account.",
      "I need someone to open a ticket.",
      "Why can't you connect me to a human?",
      "This won't let me talk to a human.",
      "human send me",
      "person need help",
      "agen pls",
      "I never said: I want a human; now connect me to a manager.",
      "I never said: I want a human, please connect me to a manager now.",
      "I never said: I want a human, and now connect me to a manager.",
      "I need someone to send me the form.",
      "I would like you to put me through.",
      "Can I get transferred?",
      "Could I be put through?",
      "Could you forward me?",
      "Can you route me?",
      "Can I talk to a customer care agent?",
      "Can I talk to an agent on your team?",
      "Can I speak to a person from support?",
      "I need an agent to schedule an appointment.",
      "I need a human to authorize this.",
      "I need someone to walk me through this.",
      "I need a person to complete the refund.",
      "I need an agent to escalate this.",
      "I need someone to resend the email.",
      "I need someone to add a note.",
      "advser pls",
      "hmn pls",
      "transfr me",
      "put me thru",
      "I never said I wanted a human. Connect me to one now.",
      "I wasn't asking for a human before, but I am now.",
      "I need to escalate this",
      "Can you hand this chat off?",
      "Would you escalate the chat?",
      "Could you transfer this chat?",
      "I need you to put me through",
      "I want you to hand me off",
      "I would like you to escalate this",
      "I want this escalated",
      "person get",
      "agent give",
      "manager ask",
      "human can connect",
      "humon pls",
      "peerson pls",
      "maneger pls",
      "represenative pls",
      "opertor pls",
      "person get me",
      "send human me",
      "me human help",
      "I want to be put through.",
      "Can somebody step in?",
      "Please get someone involved.",
      "Bring in a person.",
      "Can I speak to an associate?",
      "Can I talk to an employee?",
      "speclist plz",
      "agent step in",
      "I never said: I want a human — now connect me to a manager.",
      "Could you pass me on?",
      "Can you bring in a human?",
      "Please loop in an agent.",
      "I need this handed off.",
      "I want the chat transferred.",
      "Can I talk to a service rep?",
      "Could this be escalated?",
      "I need this conversation escalated",
      "person get help",
    ];

    for (const text of messages) {
      const setup = harness(clarification);
      const [result] = await setup.adapter.processWebhook(webhook({ text }));
      expect(result, text).toMatchObject({
        kind: "pass_control",
        handoff: { reason: "human_requested", target: "human" },
      });
      expect(setup.resolveAuthenticatedAccount).not.toHaveBeenCalled();
      expect(setup.processMessage).not.toHaveBeenCalled();
    }
  });

  it("does not turn negated or delivery-context person words into a handoff", async () => {
    const messages = [
      "I do not want to talk to a person.",
      "Do not transfer me to an agent.",
      "I need to update the delivery person instructions.",
      "I need customer service hours.",
      "I never said I want a human",
      "I didn’t say I want a human",
      "I’m not asking for an agent",
      "Please contact the person who delivered it",
      "I need the person who delivered my package",
      "dont conect me humna",
      "dont trasnfer humna",
      "dnt transfer human",
      "never sed want human",
      "didnt sy want humna",
      "task manager",
      "contract manager",
      "please be humane",
      "manage please",
      "I want to manage",
      "I no longer want a human",
      "I used to want a human",
      "I don't think I need a human",
      "I don't really want a human",
      "I did not tell you I want a human",
      "Do I need a human?",
      "Why do I need a human?",
      "Do you want a person?",
      "If I want a human, what happens?",
      "I used to really want a human",
      "I never said: I want a human",
      "I never said, I want a human",
      "I never said - I want a human",
      "I never said / I want a human",
      "I need someone to deliver my order",
      "I want a person to bring my package",
      "Why would I want a human?",
      "Did I ask for a human?",
      "Who said I want a human?",
      "Do I still want a human?",
      "I cannot talk to a human because I prefer the bot",
      "I can't reach a human because I don't want one",
      "Don't let the bot transfer me to an agent",
      "I don't want the chatbot to transfer me to an agent",
      "No bot should transfer me to a human",
      "I need someone to pick up my return",
      "I need someone to collect my return",
      "I need a person to sign for my package",
      "I want an agent to take my parcel",
      "Connect me to a human. Actually, do not transfer me.",
      "I want a human—wait, no",
      "Talk to a person—no, keep the bot",
      "Human please, actually never mind",
      "I can't reach a person; don't transfer me",
      "Did I say I want a human?",
      "Are you saying I need a human?",
      "Am I asking for a manager?",
      "Should I ask for a human?",
      "Would a human help?",
      "When do I need a human?",
      "What if I need a human?",
      "I used to desperately want a human",
      "Earlier I said I want a human",
      "I cannot talk to a human because I only use the bot",
      "I can't speak to a human because I refuse",
      "I can't reach a person and I am not asking for one",
      "I need someone to receive my package",
      "I need a person to accept the delivery",
      "somebody to return the parcel",
      "a person to install the item",
      "I want a human. Actually don't.",
      "I want a human. No thanks.",
      "Connect me to a human. I changed my mind.",
      "Human please—scratch that",
      "Talk to a person. Forget it.",
      "Transfer me. Stop.",
      "Connect me to a human. Actually keep me with the bot",
      "How do I know if I need a human?",
      "Does this mean I need a human?",
      "Is the bot saying I need a human?",
      "Did I tell you I want a human?",
      "Yesterday I said I need a human",
      "Earlier I told you I need a human",
      "The customer wrote I want a human.",
      "My message says connect me to a human.",
      "Repeat after me: connect me to a person.",
      "I can't talk to a human because I don't consent",
      "I can't reach a person, nor do I want one",
      "I need someone for delivery",
      "I need someone to help deliver my order",
      "I need a person to assist with carrying the package",
      "I want someone with a van",
      "I want a human. Actually no.",
      "I want a human. I changed my mind about that.",
      "Connect me to a human. Cancel the request.",
      "Talk to a person. I would rather stay with the bot.",
      "A human? No thank you.",
      "Connect me to a human. I've changed my mind.",
      "Human please—I take that back",
      "Connect me to a person. Forget that.",
      "Would I need a human?",
      "Could I need a human?",
      "Do you think I need a human?",
      "My friend said I need a human.",
      "The email says connect me to a human.",
      "Last week I said I need a human.",
      "Do customers need a human?",
      "Why would customers want a human?",
      "Does my message mean I need a human?",
      "Are you suggesting I need a human?",
      "Are you telling me to ask for a human?",
      "She said I need a human",
      "Last month I said I need a human",
      "Yesterday I mentioned I need a human",
      "I can't talk to a human because I decline.",
      "I can't talk to a human, and I would rather not.",
      "I can't speak to a person because I stay with the bot",
      "I can't talk to a human because I opt out",
      "I can't talk to a human. I do not consent.",
      "I need someone for a home delivery.",
      "I need someone for package delivery.",
      "I need a person with a pickup truck.",
      "I need someone to fix my car",
      "I need someone to help carry my order",
      "Human please. Please cancel.",
      "Transfer me. Never mind that.",
      "I want a human. Keep talking to the bot.",
      "The customer told me to ask for a human.",
      "For example, say I want a human.",
      "I said yesterday that I need a human.",
      "I need an agent for shipping.",
      "I want someone to call the courier",
      "Human please—no, thanks",
      "A minute ago I said I need a human",
      "I can't reach a person, nor want one",
      "I need someone for delivery tomorrow",
      "I need a human. I'd rather not.",
      "I want a human. Nevermind.",
      "I need a human. Please don't.",
      "Should customers get a human?",
      "My chat says I need a human.",
      "A moment ago I said I need a human.",
      "I told you last week I need a human.",
      "I can't talk to a human. Please keep me with the bot.",
      "I need someone for grocery delivery.",
      "I need an agent for my novel.",
      "I need a manager for my band.",
      "Human please—never mind actually",
      "Human please—cancel it",
      "Human please—not anymore",
      "Human please—actually no thanks",
      "Human please—I’d rather stay with the bot",
      "Human please—remain with the chatbot",
      "Human please—on second thought, no.",
      "Connect me to a human. Please cancel it.",
      "Does a customer need a human?",
      "Is the customer saying they need a human?",
      "My previous message said I need a human",
      "This morning I said I need a human",
      "Is my message suggesting I need a human?",
      "Did the customer say they want a human?",
      "Why does the customer need a human?",
      "Two days ago I said I need a human",
      "I can't reach a person because I’d rather stay with the bot",
      "I can't talk to a human; please don't.",
      "I can't reach a person. I decline the handoff.",
      "I need someone with a car",
      "I need someone to help me deliver my order",
      "I need a person to assist in carrying the package",
      "I need someone with a delivery van",
      "I need someone to help move my package",
    ];

    for (const text of messages) {
      const setup = harness(noRelevantEvidence);
      const [result] = await setup.adapter.processWebhook(webhook({ text }));
      expect(result, text).not.toMatchObject({
        kind: "pass_control",
        handoff: { reason: "human_requested", target: "human" },
      });
      expect(setup.resolveAuthenticatedAccount).toHaveBeenCalledTimes(1);
    }
  });

  it("routes the native human quick-reply payload before text or evidence handling", async () => {
    const setup = harness(clarification);
    const [result] = await setup.adapter.processWebhook(webhook({
      text: "Help",
      payload: ZENDESK_HUMAN_PAYLOAD,
    }));

    expect(result).toMatchObject({
      kind: "pass_control",
      handoff: { reason: "human_requested", target: "human" },
    });
    expect(setup.resolveAuthenticatedAccount).not.toHaveBeenCalled();
    expect(setup.processMessage).not.toHaveBeenCalled();
  });

  it("maps the composition-help button to an empty show-choices request", async () => {
    const { adapter, processMessage } = harness(navigation);

    await adapter.processWebhook(webhook({
      text: "I don't know what to say",
      payload: ZENDESK_SHOW_CHOICES_PAYLOAD,
    }));

    expect(processMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "",
      showChoices: true,
      metadata: expect.objectContaining({ zendesk_assistance_path: "explicit_choices" }),
    }));
  });

  it("records a server-signed quick reply and passes control to the next bot", async () => {
    const setup = harness(clarification);
    const [first] = await setup.adapter.processWebhook(webhook());
    if (first?.kind !== "post_message") throw new Error("Expected choices.");
    const selectedPayload = first.pendingChoices?.choices[0]?.payload;
    if (selectedPayload === undefined) throw new Error("Expected a signed choice payload.");

    const [selected] = await setup.adapter.processWebhook(webhook({
      text: "Charged twice",
      payload: selectedPayload,
      messageId: "message-selection-1",
      eventId: "event-selection-1",
      receivedAt: "2026-07-30T20:00:02Z",
    }));

    expect(setup.recordConfirmation).toHaveBeenCalledWith({
      suggestionId: SUGGESTION_ID,
      selectedDetectorId: "duplicate_charge",
      actor: "customer",
      decisionId: "event-selection-1",
    });
    expect(selected).toMatchObject({
      kind: "pass_control",
      handoff: {
        reason: "choice_selected",
        confirmedChoice: {
          choiceId: "duplicate_charge",
          detectorId: "duplicate_charge",
          feedback: "confirmed",
        },
      },
    });
  });

  it("passes a signed choice onward even when best-effort feedback is unavailable", async () => {
    const setup = harness(clarification);
    const [first] = await setup.adapter.processWebhook(webhook());
    if (first?.kind !== "post_message") throw new Error("Expected choices.");
    const selectedPayload = first.pendingChoices?.choices[0]?.payload;
    if (selectedPayload === undefined) throw new Error("Expected a signed choice payload.");
    setup.recordConfirmation.mockRejectedValueOnce(new Error("feedback API unavailable"));

    const [selected] = await setup.adapter.processWebhook(webhook({
      text: "Charged twice",
      payload: selectedPayload,
      messageId: "message-selection-feedback-outage",
      eventId: "event-selection-feedback-outage",
      receivedAt: "2026-07-30T20:00:02Z",
    }));

    expect(selected).toMatchObject({
      kind: "pass_control",
      handoff: { reason: "choice_selected" },
    });
    expect(setup.onFeedbackError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "feedback API unavailable" }),
      expect.objectContaining({ eventId: "event-selection-feedback-outage" }),
    );
  });

  it("does not wait for a hung best-effort feedback request before passing control", async () => {
    const setup = harness(clarification);
    const [first] = await setup.adapter.processWebhook(webhook());
    if (first?.kind !== "post_message") throw new Error("Expected choices.");
    const selectedPayload = first.pendingChoices?.choices[0]?.payload;
    if (selectedPayload === undefined) throw new Error("Expected a signed choice payload.");
    setup.recordConfirmation.mockImplementationOnce(() => new Promise<never>(() => undefined));

    const selected = await Promise.race([
      setup.adapter.processWebhook(webhook({
        text: "Charged twice",
        payload: selectedPayload,
        messageId: "message-selection-feedback-hung",
        eventId: "event-selection-feedback-hung",
        receivedAt: "2026-07-30T20:00:02Z",
      })),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("handoff blocked on feedback")), 100)),
    ]);
    expect(selected[0]).toMatchObject({ kind: "pass_control", handoff: { reason: "choice_selected" } });
  });

  it("does not accept a signed choice in a different conversation", async () => {
    const setup = harness(clarification, noRelevantEvidence);
    const [first] = await setup.adapter.processWebhook(webhook());
    if (first?.kind !== "post_message") throw new Error("Expected choices.");
    const selectedPayload = first.pendingChoices?.choices[0]?.payload;
    if (selectedPayload === undefined) throw new Error("Expected a signed choice payload.");

    await setup.adapter.processWebhook(webhook({
      text: "Charged twice",
      payload: selectedPayload,
      conversationId: "another-conversation",
      eventId: "event-selection-2",
      receivedAt: "2026-07-30T20:00:02Z",
    }));

    expect(setup.recordConfirmation).not.toHaveBeenCalled();
    expect(setup.processMessage).toHaveBeenCalledTimes(2);
  });

  it("allows a same-event choice retry but rejects replay from a new event", async () => {
    const setup = harness(clarification, noRelevantEvidence);
    const [first] = await setup.adapter.processWebhook(webhook());
    if (first?.kind !== "post_message") throw new Error("Expected choices.");
    const selectedPayload = first.pendingChoices?.choices[0]?.payload;
    if (selectedPayload === undefined) throw new Error("Expected a signed choice payload.");
    const selection = webhook({
      text: "Charged twice",
      payload: selectedPayload,
      messageId: "message-selection-2",
      eventId: "event-selection-2",
      receivedAt: "2026-07-30T20:00:02Z",
    });

    await expect(setup.adapter.processWebhook(selection)).resolves.toEqual([
      expect.objectContaining({ kind: "pass_control", handoff: expect.objectContaining({
        reason: "choice_selected",
      }) }),
    ]);
    await expect(setup.adapter.processWebhook(selection)).resolves.toEqual([
      expect.objectContaining({ kind: "pass_control", handoff: expect.objectContaining({
        reason: "choice_selected",
      }) }),
    ]);
    const [replay] = await setup.adapter.processWebhook(webhook({
      text: "Charged twice",
      payload: selectedPayload,
      messageId: "message-selection-3",
      eventId: "event-selection-3",
      receivedAt: "2026-07-30T20:00:03Z",
    }));

    expect(replay).toMatchObject({
      kind: "pass_control",
      handoff: { reason: "wordless_yielded" },
    });
    expect(setup.recordConfirmation).toHaveBeenCalledTimes(2);
    expect(setup.recordConfirmation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      decisionId: "event-selection-2",
    }));
    expect(setup.recordConfirmation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      decisionId: "event-selection-2",
    }));
  });

  it("rejects an unconsumed choice after its signed expiry", async () => {
    const setup = harness(clarification, noRelevantEvidence);
    const [first] = await setup.adapter.processWebhook(webhook());
    if (first?.kind !== "post_message") throw new Error("Expected choices.");
    const selectedPayload = first.pendingChoices?.choices[0]?.payload;
    if (selectedPayload === undefined) throw new Error("Expected a signed choice payload.");
    setup.setNow("2026-07-30T20:31:00Z");

    const [result] = await setup.adapter.processWebhook(webhook({
      text: "Charged twice",
      payload: selectedPayload,
      messageId: "message-expired-choice",
      eventId: "event-expired-choice",
      receivedAt: "2026-07-30T20:31:00Z",
    }));

    expect(result).toMatchObject({
      kind: "pass_control",
      handoff: { reason: "wordless_yielded", confirmedChoice: null },
    });
    expect(setup.recordConfirmation).not.toHaveBeenCalled();
  });

  it("ignores business-authored messages and messages when another integration is active", async () => {
    const setup = harness(clarification);

    await expect(setup.adapter.processWebhook(webhook({ authorType: "business" }))).resolves.toEqual([
      expect.objectContaining({ kind: "ignored", reason: "business_authored" }),
    ]);
    await expect(setup.adapter.processWebhook(webhook({ activeId: "another-bot" }))).resolves.toEqual([
      expect.objectContaining({ kind: "ignored", reason: "inactive_integration" }),
    ]);
    expect(setup.processMessage).not.toHaveBeenCalled();
  });

  it("passes unsupported content and unauthenticated users onward without inference", async () => {
    const setup = harness(clarification);
    const [unsupported] = await setup.adapter.processWebhook(webhook({
      contentType: "file",
    }));
    expect(unsupported).toMatchObject({
      kind: "pass_control",
      handoff: { reason: "unsupported_content" },
    });

    setup.resolveAuthenticatedAccount.mockResolvedValueOnce(null);
    const [unauthenticated] = await setup.adapter.processWebhook(webhook());
    expect(unauthenticated).toMatchObject({
      kind: "pass_control",
      handoff: { reason: "account_not_authenticated" },
    });
    expect(setup.processMessage).not.toHaveBeenCalled();
  });

  it("passes resolver outages onward without inference or customer-visible disclosure", async () => {
    const setup = harness(clarification);
    setup.resolveAuthenticatedAccount.mockRejectedValueOnce(new Error("private resolver detail"));
    const [result] = await setup.adapter.processWebhook(webhook());
    expect(result).toMatchObject({
      kind: "pass_control",
      handoff: { target: "next", reason: "evidence_unavailable" },
      request: { body: { metadata: { handoff_reason: "evidence_unavailable" } } },
    });
    expect(setup.processMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private resolver detail");
  });

  it("rejects envelopes from an unexpected installation", async () => {
    const setup = harness(clarification);
    const value = webhook() as { app: { id: string } };
    value.app.id = "different-app";

    await expect(setup.adapter.processWebhook(value)).rejects.toBeInstanceOf(
      ZendeskWebhookValidationError,
    );
  });

  it("strictly preflights the same message schema without side effects and rejects future timestamps", () => {
    const value = webhook({ text: "money one twice", integrationId: "underlying-integration-1" });
    expect(preflightZendeskWebhook(value, {
      expectedAppId: APP_ID,
      expectedWebhookId: WEBHOOK_ID,
      switchboardIntegrationId: SWITCHBOARD_ID,
      underlyingIntegrationId: "underlying-integration-1",
      maxFutureSkewMs: 5_000,
      now: () => new Date("2026-07-30T20:00:01Z"),
    })).toEqual([{
      eventId: EVENT_ID,
      eventType: "conversation:message",
      eventCreatedAt: "2026-07-30T20:00:00Z",
      conversationId: CONVERSATION_ID,
      customerActivity: true,
      configuredIntegrationActive: true,
    }]);

    const future = webhook() as { events: Array<{ createdAt: string }> };
    future.events[0]!.createdAt = "2026-07-30T20:01:00Z";
    expect(() => preflightZendeskWebhook(future, {
      expectedAppId: APP_ID,
      expectedWebhookId: WEBHOOK_ID,
      switchboardIntegrationId: SWITCHBOARD_ID,
      maxFutureSkewMs: 5_000,
      now: () => new Date("2026-07-30T20:00:01Z"),
    })).toThrow(/too far in the future/u);
  });
});

describe("Zendesk native message and API helpers", () => {
  it("creates a composition-help action without blocking free typing", () => {
    expect(createZendeskCompositionHelpMessage()).toEqual({
      author: { type: "business" },
      content: {
        type: "text",
        text: "Type anything you can. If finding the words is hard, choose this option.",
        blockChatInput: false,
        actions: [
          {
            type: "reply",
            text: "I don't know what to say",
            payload: ZENDESK_SHOW_CHOICES_PAYLOAD,
          },
          {
            type: "reply",
            text: "Talk to a person",
            payload: "wordless:human:v1",
          },
        ],
      },
    });
  });

  it("executes an exact v2 request with server-side Basic authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const client = createZendeskConversationsClient({
      subdomain: "acme",
      authentication: { type: "basic", keyId: "key-id", keySecret: "key-secret" },
      fetch: fetchMock,
    });

    await client.execute({
      method: "POST",
      path: `/sc/v2/apps/${APP_ID}/conversations/${CONVERSATION_ID}/messages`,
      body: createZendeskCompositionHelpMessage(),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://acme.zendesk.com/sc/v2/apps/${APP_ID}/conversations/${CONVERSATION_ID}/messages`,
    );
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("key-id:key-secret", "utf8").toString("base64")}`,
    );
  });

  it("adds the required Marketplace headers for an OAuth bot token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = createZendeskConversationsClient({
      subdomain: "acme",
      authentication: {
        type: "bearer",
        token: "installation-oauth-token",
        marketplace: { name: "Wordless", organizationId: "org-1", botId: "bot-1" },
      },
      fetch: fetchMock,
    });
    await client.execute({
      method: "POST",
      path: `/sc/v2/apps/${APP_ID}/conversations/${CONVERSATION_ID}/passControl`,
      body: {
        switchboardIntegration: "next",
        metadata: { first_message_id: MESSAGE_ID },
      },
    });

    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer installation-oauth-token");
    expect(headers.get("x-zendesk-marketplace-name")).toBe("Wordless");
    expect(headers.get("x-zendesk-marketplace-organization-id")).toBe("org-1");
    expect(headers.get("x-zendesk-marketplace-bot-id")).toBe("bot-1");
  });

  it("fails closed for next with unknown or app credential scope", async () => {
    const request = createZendeskPassControlRequest({
      appId: APP_ID,
      conversationId: CONVERSATION_ID,
      destination: { mode: "next", credentialScope: "integration" },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const unknownScope = createZendeskConversationsClient({
      subdomain: "acme",
      authentication: { type: "basic", keyId: "key-id", keySecret: "key-secret" },
      fetch: fetchMock,
    });
    const appScope = createZendeskConversationsClient({
      subdomain: "acme",
      authentication: {
        type: "basic",
        keyId: "key-id",
        keySecret: "key-secret",
        scope: "app",
      },
      fetch: fetchMock,
    });

    await expect(unknownScope.execute(request)).rejects.toThrow(/explicitly integration-scoped/u);
    await expect(appScope.execute(request)).rejects.toThrow(/explicitly integration-scoped/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports explicit app-scoped pass targets and release-control deadlines", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = createZendeskConversationsClient({
      subdomain: "acme",
      authentication: {
        type: "basic",
        keyId: "key-id",
        keySecret: "key-secret",
        scope: "app",
      },
      fetch: fetchMock,
    });
    const directPass = createZendeskPassControlRequest({
      appId: APP_ID,
      conversationId: CONVERSATION_ID,
      destination: {
        mode: "integration",
        credentialScope: "app",
        switchboardIntegrationId: "human-agent-switchboard",
      },
      metadata: { reason: "human_requested" },
    });
    await client.execute(directPass);

    const plan = createZendeskControlReleasePlan({
      appId: APP_ID,
      conversationId: CONVERSATION_ID,
      acquiredAt: "2026-07-30T20:00:00Z",
      releaseAfterMs: 60 * 60 * 1_000,
      metadata: { reason: "control_timeout" },
    });
    expect(plan.releaseNoLaterThan).toBe("2026-07-30T21:00:00.000Z");
    expect(plan.request).toEqual(createZendeskReleaseControlRequest({
      appId: APP_ID,
      conversationId: CONVERSATION_ID,
      metadata: { reason: "control_timeout" },
    }));
    await client.execute(plan.request);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://acme.zendesk.com/sc/v2/apps/${APP_ID}/conversations/${CONVERSATION_ID}/passControl`,
      `https://acme.zendesk.com/sc/v2/apps/${APP_ID}/conversations/${CONVERSATION_ID}/releaseControl`,
    ]);
  });

  it("requires a durable choice store", () => {
    const { choiceStore: _choiceStore, ...unsafe } = {
      chatbot: {
        processMessage: vi.fn(),
        recordConfirmation: vi.fn(),
      } as unknown as WordlessSupportChatbot,
      expectedAppId: APP_ID,
      expectedWebhookId: WEBHOOK_ID,
      switchboardIntegrationId: SWITCHBOARD_ID,
      choiceSigningSecret: CHOICE_SECRET,
      choiceStore: undefined,
      resolveAuthenticatedAccount: vi.fn(),
    };
    expect(() => createZendeskMessagingAdapter(
      unsafe as unknown as Parameters<typeof createZendeskMessagingAdapter>[0],
    )).toThrow(/choiceStore is invalid/u);
  });
});
