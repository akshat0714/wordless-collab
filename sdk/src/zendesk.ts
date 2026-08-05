import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  WordlessSdkError,
  type WordlessEvidence,
  type WordlessJsonValue,
  type WordlessSupportChatTurn,
  type WordlessSupportChatbot,
  type WordlessSupportChoice,
} from "./server.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SHOW_CHOICES_TEXT_PATTERN = /^(?:i\s+)?(?:do not|don't|dont)\s+know\s+what\s+to\s+say[.!?]?$/iu;
const HUMAN_ROLE_SOURCE = String.raw`(?:(?:actual\s+)?human(?:\s+(?:agent|representative|being|assistance))?|real\s+person|live\s+(?:person|agent|representative|operator)|support\s+(?:person|agent|representative|manager)|customer\s+(?:care|service|support)(?:\s+(?:agent|representative|manager|operator|team))?|service\s+rep|team\s+member|member\s+of\s+(?:(?:the|your)\s+)?(?:staff|team)|staff(?:\s+member)?|advisor|associate|employee|specialist|agent|representative|operator|supervisor|manager|someone(?:\s+else)?|somebody(?:\s+else)?|person)`;
const HUMAN_ACTION_TARGET_SOURCE = String.raw`(?:${HUMAN_ROLE_SOURCE}|support(?:\s+team)?)`;
const HUMAN_ROLE_WITH_ARTICLE_SOURCE = String.raw`(?:(?:an?|the|your)\s+)?${HUMAN_ROLE_SOURCE}`;
const HUMAN_ACTION_TARGET_WITH_ARTICLE_SOURCE = String.raw`(?:(?:an?|the|your)\s+)?${HUMAN_ACTION_TARGET_SOURCE}`;
const HUMAN_ROLE_SUFFIX_SOURCE = String.raw`(?=$|\s+(?:please|now|anyway|asap|urgently|to|for|from|on|about|regarding|with|because|help)\b|\s+who\s+(?:can|will)\s+help\b)`;
const HUMAN_ONLY_PATTERN = new RegExp(
  String.raw`^(?:please\s+)?${HUMAN_ROLE_WITH_ARTICLE_SOURCE}(?:\s+please)?$`,
  "iu",
);
const HUMAN_ACTION_PATTERN = new RegExp(
  String.raw`(?:^|\b(?:(?:please\s+)|(?:can|could|would|will|may)\s+(?:i|you)\s+|(?:i\s+)?(?:want|need|prefer)\s+to\s+|i\s+would\s+like\s+to\s+|i['’]d\s+like\s+to\s+))(?:please\s+)?(?:(?:talk|speak|chat)\s+(?:to|with)|let\s+me\s+(?:talk|speak|chat)\s+(?:to|with)|(?:connect|transfer)(?:\s+me)?\s+(?:to|with)|(?:be|get)\s+(?:connected|transferred)\s+(?:to|with)|put\s+me\s+through\s+to|(?:reach|contact)|escalate(?:\s+(?:me|this|the\s+(?:chat|conversation|case|issue)))?(?:\s+to)?|hand(?:\s+(?:me|this|the\s+(?:chat|conversation|case|issue)))?\s+off(?:\s+to)?|get\s+me)\s+${HUMAN_ACTION_TARGET_WITH_ARTICLE_SOURCE}${HUMAN_ROLE_SUFFIX_SOURCE}`,
  "iu",
);
const HUMAN_WANT_PATTERN = new RegExp(
  String.raw`\b(?:(?:i\s+)?(?:really\s+)?(?:need|want|prefer)|i\s+would\s+(?:like|prefer)|i['’]d\s+(?:like|prefer)|(?:can|could|may)\s+i\s+(?:get|have))\s+(?:to\s+)?${HUMAN_ROLE_WITH_ARTICLE_SOURCE}${HUMAN_ROLE_SUFFIX_SOURCE}`,
  "iu",
);
const HUMAN_QUERY_PATTERN = new RegExp(
  String.raw`^(?:please\s+)?(?:is\s+there|do\s+you\s+have|can\s+i\s+(?:get|have))\s+${HUMAN_ROLE_WITH_ARTICLE_SOURCE}(?:\s+(?:i|we)\s+can\s+(?:talk|speak|chat)\s+(?:to|with))?${HUMAN_ROLE_SUFFIX_SOURCE}`,
  "iu",
);
const HUMAN_PREFERENCE_PATTERN = new RegExp(
  String.raw`^(?:please\s+)?${HUMAN_ROLE_WITH_ARTICLE_SOURCE}\s+(?:would|might)\s+be\s+(?:better|best|helpful|easier)$`,
  "iu",
);
const HUMAN_ROLELESS_OBJECT_SOURCE = String.raw`(?:me|this|(?:this|the)\s+(?:chat|conversation|case|issue))`;
const HUMAN_ROLELESS_ACTION_SOURCE = String.raw`(?:(?:connect|forward|route|transfer)\s+${HUMAN_ROLELESS_OBJECT_SOURCE}|put\s+${HUMAN_ROLELESS_OBJECT_SOURCE}\s+through|hand\s+${HUMAN_ROLELESS_OBJECT_SOURCE}\s+off|escalate(?:\s+${HUMAN_ROLELESS_OBJECT_SOURCE})?)`;
const HUMAN_ROLELESS_HANDOFF_PATTERN = new RegExp(
  String.raw`^(?:please\s+)?(?:${HUMAN_ROLELESS_ACTION_SOURCE}|(?:can|could|may|would|will)\s+(?:i\s+(?:(?:get|be)\s+(?:connected|transferred)|be\s+put\s+through)|(?:you\s+)?(?:please\s+)?${HUMAN_ROLELESS_ACTION_SOURCE})|i\s+(?:need|want|would\s+like)\s+(?:(?:(?:you\s+)?to\s+)?${HUMAN_ROLELESS_ACTION_SOURCE}|to\s+be\s+(?:connected|transferred))|i\s+(?:need|want|would\s+like)\s+(?:this|the\s+(?:chat|conversation|case|issue))\s+escalated)(?:\s+(?:please|now|right\s+now|asap|anyway))?$`,
  "iu",
);
const HUMAN_DIRECT_ROUTE_PATTERN = new RegExp(
  String.raw`^(?:please\s+)?(?:forward|pass|route)\s+me\s+(?:to|with)\s+${HUMAN_ACTION_TARGET_WITH_ARTICLE_SOURCE}${HUMAN_ROLE_SUFFIX_SOURCE}`,
  "iu",
);
const HUMAN_COLLOQUIAL_HANDOFF_PATTERN = new RegExp(
  String.raw`^(?:please\s+)?(?:(?:bring|loop)\s+in\s+${HUMAN_ACTION_TARGET_WITH_ARTICLE_SOURCE}|get\s+${HUMAN_ROLE_WITH_ARTICLE_SOURCE}\s+involved|(?:can|could|may|would|will)\s+(?:i|you)\s+(?:please\s+)?(?:pass\s+me\s+on|bring\s+in\s+${HUMAN_ACTION_TARGET_WITH_ARTICLE_SOURCE})|i\s+(?:need|want|would\s+like)\s+to\s+be\s+put\s+through)(?:\s+(?:please|now|asap))?$`,
  "iu",
);
const HUMAN_PASSIVE_HANDOFF_PATTERN = /^(?:(?:can|could|may|would|will)\s+(?:this|(?:this|the)\s+(?:chat|conversation|case|issue))\s+be\s+(?:escalated|transferred|handed\s+off)|i\s+(?:need|want|would\s+like)\s+(?:this|(?:this|the)\s+(?:chat|conversation|case|issue))\s+(?:escalated|transferred|handed\s+off))$/iu;
const HUMAN_RETRACTION_PATTERN = /^(?:(?:actually\s+)?(?:never\s*mind(?:\s+(?:that|actually))?|cancel\s+(?:that|it)|do\s+not|don['’]?t)|(?:please\s+)?(?:cancel(?:\s+(?:it|that))?|do\s+not|don['’]?t)|actually\s+no(?:\s+thanks)?|(?:i(?:['’]?ve|\s+have)?\s+)?changed\s+my\s+mind(?:\s+about\s+(?:that|it))?|(?:i\s+)?take\s+that\s+back|scratch\s+that|forget\s+(?:it|that)|cancel\s+(?:(?:the|my)\s+)?request|not\s+anymore|no\s+thank\s+you|no\s+thanks|stop|(?:i['’]?d|i\s+would)?\s*rather\s+not|(?:i\s+)?(?:do\s+not\s+consent|don['’]?t\s+consent|decline(?:\s+the\s+handoff)?|opt\s+out)|(?:actually\s+)?(?:do\s+not|don['’]?t|never)\s+(?:connect|escalate|forward|hand|pass|route|transfer)(?:\s+me)?(?:\s+(?:to|with))?|wait\s+no|on\s+second\s+thought\s+no|(?:i['’]?d|i\s+would)\s+rather\s+(?:stay|continue)\s+with\s+(?:the\s+)?(?:bot|chatbot|robot)|(?:i\s+)?(?:remain|stay)\s+with\s+(?:the\s+)?(?:bot|chatbot|robot)|(?:please\s+)?keep\s+(?:(?:talking\s+to\s+)|(?:me\s+(?:with|on)\s+)|(?:me\s+using\s+))?(?:the\s+)?(?:bot|chatbot|robot)|(?:no\s+)?(?:actually\s+)?keep\s+(?:(?:me\s+(?:with|on)\s+)|(?:me\s+using\s+))?(?:the\s+)?(?:bot|chatbot|robot))$/iu;
const HUMAN_INABILITY_PATTERN = new RegExp(
  String.raw`^(?:why\s+)?(?:(?:(?:can(?:not|['’]?t)|could(?:not|n['’]?t))\s+i)|(?:i\s+(?:can(?:not|['’]?t)|could(?:not|n['’]?t))))\s+(?:(?:talk|speak|chat)\s+(?:to|with)|(?:get\s+through|connect|reach|contact)(?:\s+(?:me\s+)?(?:to|with))?)\s+${HUMAN_ACTION_TARGET_WITH_ARTICLE_SOURCE}${HUMAN_ROLE_SUFFIX_SOURCE}`,
  "iu",
);
const NEGATED_HUMAN_REQUEST_PATTERN = /\b(?:(?:do\s+not|don['’]?t|never)\s+(?:want|need|prefer|talk|speak|chat|connect|transfer|escalate|reach|contact|put|hand|get|have|be)|(?:(?:do|would|can|could|will)\s+not|wouldn['’]?t|can['’]?t|couldn['’]?t|won['’]?t)\s+(?:want|need|prefer|talk|speak|chat|connect|transfer|escalate|reach|contact|put|hand|get|have|be))\b/iu;
const REPORTED_HUMAN_REQUEST_PATTERN = /\b(?:(?:never|did\s+not|didn['’]?t)\s+(?:say|said|ask|asked)|(?:am|i['’]?m)\s+not\s+(?:asking|requesting))\b/iu;
const HISTORICAL_HUMAN_REQUEST_PATTERN = /\b(?:formerly|previously|used\s+to)\s+(?:[a-z]+\s+){0,3}(?:want|need|prefer|ask|asked|request|requested|talk|speak|chat|connect|transfer|escalate|reach|contact|get|have)\b/iu;
const HISTORICAL_REPORTED_HUMAN_PATTERN = new RegExp(
  String.raw`^(?:(?:a\s+(?:minute|moment)\s+ago|this\s+morning|two\s+days\s+ago)\s+(?:i\s+)?(?:said|asked|requested|mentioned)\b|i\s+(?:said|told|asked|mentioned)\b[^.!?\n]{0,32}\b(?:yesterday|last\s+(?:week|month|year))\b)[^.!?\n]{0,96}\b${HUMAN_ROLE_SOURCE}\b`,
  "iu",
);
const EARLIER_REPORTED_HUMAN_PATTERN = new RegExp(
  String.raw`^(?:earlier|before|previously|yesterday|last\s+(?:week|month|year))\b[^.!?\n]{0,48}\b(?:said|asked|requested|told|wrote|mentioned)\b[^.!?\n]{0,48}\b${HUMAN_ROLE_SOURCE}\b`,
  "iu",
);
const META_REPORTED_HUMAN_PATTERN = new RegExp(
  String.raw`^(?:(?:(?:(?:my|the)\s+)?(?:customer|user|agent|bot|friend)|he|she|they)\b[^.!?\n]{0,48}\b(?:said|says|told|wrote|writes|asked|requested|mentioned)\b|(?:my|the|this)\s+(?:previous\s+)?(?:chat|email|message|text|note|transcript)\s+(?:said|says|reads|contains|mentions)\b|(?:for\s+example[\s,:—–-]+)?say\b|repeat\s+after\s+me\b)[^.!?\n]{0,96}\b${HUMAN_ROLE_SOURCE}\b`,
  "iu",
);
const REPORTED_HUMAN_REQUEST_ACROSS_BOUNDARY_PATTERN = new RegExp(
  String.raw`\b(?:never|did\s+not|didn['’]?t)\s+(?:(?:actually|really)\s+)*(?:say|said|sed|sy|ask|asked|tell|told)\b[^.!?\n]{0,96}?\b(?:need|want|prefer|ask|request|talk|speak|chat|connect|transfer|get|have)?\s*(?:an?\s+|the\s+|your\s+)?${HUMAN_ROLE_SOURCE}\b`,
  "iu",
);
const HUMAN_MENTION_QUESTION_PATTERN = new RegExp(
  String.raw`^(?:(?:why|when)\s+(?:do|does|did|should|will|would)\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:need|want|prefer)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|how\s+(?:do|does|did|would|will|can|could)\s+(?:i|you|we|they|he|she)\s+[^.!?\n]{0,64}\b(?:if\s+)?(?:need|want|prefer)\b[^.!?\n]{0,48}\b${HUMAN_ROLE_SOURCE}\b|(?:do|does|did|should)\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:(?:need|want|prefer)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|(?:ask|say|tell|request)\b[^.!?\n]{0,48}\b${HUMAN_ROLE_SOURCE}\b)|(?:do|does|did|is|was|would|could)\s+(?:this|that|it|the\s+(?:bot|chatbot|message))\s+(?:mean|say|saying|suggest|imply)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|(?:am|are|is|was|were)\s+(?:i|you|we|they|he|she|the\s+(?:bot|chatbot))\s+(?:asking|saying|requesting)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|who\s+(?:asked|said|says|told)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|what\s+if\s+(?:i|you|we|they|he|she)\s+[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|if\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:need|want|prefer)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b[\s,;:—–-]*(?:what|how|would|will|does|do|can)\b|would\s+${HUMAN_ROLE_WITH_ARTICLE_SOURCE}\s+(?:help|be\s+(?:better|helpful))\b)[\s?]*$`,
  "iu",
);
const HUMAN_META_QUESTION_PATTERN = new RegExp(
  String.raw`^(?:(?:would|could)\s+(?:i|you|we|they|he|she)\s+(?:need|want|prefer)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|do\s+you\s+think\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|(?:do\s+(?:customers?|users?)|why\s+would\s+(?:customers?|users?))\s+(?:need|want|prefer)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|(?:does|is)\s+(?:(?:my|the|this)\s+)?(?:chat|message)\s+(?:mean|saying|suggesting)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b|are\s+you\s+(?:suggesting\b|telling\s+me\s+to\s+(?:ask|request)\b)[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b)[\s?]*$`,
  "iu",
);
const HUMAN_THIRD_PARTY_QUESTION_PATTERN = new RegExp(
  String.raw`^(?:do|does|did|is|are|should|why\s+(?:do|does|did|would))\b[^.!?\n]{0,48}\b(?:customers?|users?)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b[\s?]*$`,
  "iu",
);
const HUMAN_CONDITIONAL_MENTION_PATTERN = new RegExp(
  String.raw`^if\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:need|want|prefer)\b[^.!?\n]{0,64}\b${HUMAN_ROLE_SOURCE}\b\s*$`,
  "iu",
);
const HUMAN_NON_SUPPORT_SERVICE_PATTERN = new RegExp(
  String.raw`\b(?:need|want|prefer|get|have)\s+(?:an?\s+|the\s+)?(?:human|person|someone|somebody|agent|representative|staff(?:\s+member)?)\s+to\s+(?:(?:bring|carry|collect|deliver|drive|drop|pick\s+up|ship|sign\s+for)\b|take\s+(?:an?\s+|my\s+|the\s+|this\s+|your\s+)?(?:item|order|package|parcel|return)\b)`,
  "iu",
);
const HUMAN_NON_SUPPORT_CONTEXT_PATTERN = new RegExp(
  String.raw`\b${HUMAN_ROLE_WITH_ARTICLE_SOURCE}\s+(?:(?:for\s+(?:(?:a|the|my|home|package|grocery)\s+)*(?:band|delivery|novel|pickup|shipping)(?:\s+tomorrow)?\s*$)|(?:to\s+(?:(?:help|assist)(?:\s+(?:me|us))?(?:\s+(?:in|with))?\s+(?:carry|carrying|deliver|move)|fix\s+(?:(?:a|my|the)\s+)?(?:car|vehicle)|send\s+(?:(?:a|my|the|this)\s+)?(?:item|order|package|parcel)|call\s+(?:(?:a|my|the)\s+)?courier)\b)|(?:with\s+(?:an?\s+)?(?:(?:delivery\s+)?van|(?:pickup\s+)?truck|car)\b))`,
  "iu",
);
const HUMAN_REFUSAL_CONTEXT_PATTERN = new RegExp(
  String.raw`\b(?:because\s+(?:(?:i\s+)?(?:refuse|decline|opt\s+out|do\s+not\s+consent|don['’]?t\s+consent|stay\s+with\s+(?:the\s+)?(?:bot|chatbot|robot))|(?:i['’]?d|i\s+would)\s+rather\s+(?:stay|continue)\s+with\s+(?:the\s+)?(?:bot|chatbot|robot))|nor\s+(?:(?:do\s+)?i\s+)?(?:want|need|prefer|request)\s+(?:one|${HUMAN_ROLE_SOURCE}))\b`,
  "iu",
);
const HUMAN_SUPPORTED_PURPOSE_TOKENS = new Set([
  "address", "answer", "approve", "assist", "call", "cancel", "change", "check",
  "clarify", "close", "connect", "contact", "dispute", "exchange", "explain", "fix",
  "email", "guide", "handle", "help", "investigate", "look", "refund", "replace", "reset", "resolve",
  "review", "speak", "talk", "transfer", "unlock", "update", "verify",
]);
const HUMAN_UNSUPPORTED_PURPOSE_TOKENS = new Set([
  "bring", "carry", "collect", "deliver", "drive", "drop", "install", "pick", "receive", "ship",
]);
const HUMAN_CURRENT_REVERSAL_PATTERN = /^(?:(?:but\s+)?i\s+am\s+now|now\s+i\s+am)$/iu;
const HUMAN_ANAPHORIC_HANDOFF_PATTERN = /^(?:please\s+)?(?:(?:connect|forward|pass|route|transfer)(?:\s+me)?\s+(?:to|with)|put\s+me\s+through\s+to)\s+one(?:\s+(?:please|now|asap))?$/iu;
const FUZZY_ROLELESS_HANDOFF_PATTERN = /^(?:please\s+|plese\s+|pls\s+|plz\s+)?(?:(?:conect|connect|forward|route|tranfer|transfer|transfr|trasnfer)\s+me|put\s+me\s+(?:through|thru))(?:\s+(?:asap|now|please|plese|pls|plz))?$/iu;
const HUMAN_CLAUSE_SEPARATOR = /[.!?;,:—–\n]+|\s+-\s+|\s+\/\s+|\b(?:but|however|instead)\b|\band\s+(?=(?:(?:just\s+)?(?:i|please|plese|pls|plz|can|could|would|will|may|want|wnat|need|prefer|let|connect|conect|transfer|trasnfer|talk|tak|speak|spk|chat|send|give|ask|request)|(?:just\s+)?(?:an?|the)\s+(?:human|person|agent|manager|supervisor))\b)/iu;
const FUZZY_HUMAN_ROLE_TOKENS = new Set([
  "human", "humans", "hmn", "humna", "humn", "humen", "huamn", "humon", "uman",
  "person", "persons", "peerson", "persn", "prson", "perosn", "persno",
  "advisor", "advisors", "advser", "associate", "associates", "employee", "employees", "specialist", "specialists", "speclist",
  "agent", "agents", "agen", "agnet", "agnt", "agant",
  "representative", "representatives", "represenative", "represntative", "representitive", "rep",
  "operator", "operators", "opertor", "opreator",
  "supervisor", "supervisors", "superviser", "supervsor",
  "manager", "managers", "maneger", "manger", "managr", "mangr", "mgr",
  "someone", "somebody", "somone", "someon", "sombody",
  "staff",
]);
const FUZZY_HUMAN_CUE_TOKENS = new Set([
  "please", "plese", "pls", "plz",
  "need", "ned", "want", "wnat", "wnt", "prefer",
  "talk", "tak", "tlk", "speak", "spk", "speek", "chat",
  "connect", "conect", "connet", "transfer", "transfr", "trasnfer", "tranfer",
  "escalate", "escelate", "contact", "contct", "reach",
  "get", "let", "put", "send", "give", "have", "call", "help", "hlp", "take",
  "ask", "asking", "request", "requesting",
  "can", "could", "would", "will", "may",
]);
const FUZZY_HUMAN_FILLERS = new Set([
  "a", "actual", "am", "an", "another", "be", "different", "for", "from", "i", "im", "live", "me", "of", "real",
  "support", "the", "this", "through", "to", "with", "you", "your",
]);
const FUZZY_HUMAN_POLITE_TOKENS = new Set([
  "anyway", "asap", "now", "please", "plese", "pls", "plz", "urgently",
]);
const FUZZY_HUMAN_NEGATION_TOKENS = new Set([
  "cannot", "cant", "couldnt", "didnt", "dnt", "dont", "never", "no", "not",
  "shouldnt", "wasnt", "werent", "wont", "wouldnt",
]);
const FUZZY_HUMAN_REPORTING_TOKENS = new Set([
  "ask", "asked", "asking", "request", "requested", "requesting", "said", "say", "sed", "sy",
]);
const MAX_WEBHOOK_EVENTS = 100;
const MAX_TEXT_LENGTH = 4_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CHOICE_TTL_MS = 30 * 60 * 1_000;

export const ZENDESK_MAX_CONTROL_DURATION_MS = 24 * 60 * 60 * 1_000;

export const ZENDESK_SHOW_CHOICES_LABEL = "I don't know what to say";
export const ZENDESK_SHOW_CHOICES_PAYLOAD = "wordless:show_choices:v1";
export const ZENDESK_HUMAN_LABEL = "Talk to a person";
export const ZENDESK_HUMAN_PAYLOAD = "wordless:human:v1";

export class ZendeskIntegrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "ZendeskIntegrationError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
        writable: true,
      });
    }
  }
}

export class ZendeskWebhookValidationError extends ZendeskIntegrationError {
  constructor(message: string) {
    super(message);
    this.name = "ZendeskWebhookValidationError";
  }
}

export class ZendeskApiError extends ZendeskIntegrationError {
  readonly status: number;

  constructor(status: number) {
    super(`Zendesk Conversations API returned HTTP ${status}.`);
    this.name = "ZendeskApiError";
    this.status = status;
  }
}

export interface ZendeskInboundMessage {
  readonly appId: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventCreatedAt: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly receivedAt: string;
  readonly userId: string;
  readonly sourceType: string;
  readonly sourceIntegrationId: string | null;
  /** `conversation.activeSwitchboardIntegration.id`: the Switchboard entry id. */
  readonly activeSwitchboardIntegrationId: string | null;
  /** `conversation.activeSwitchboardIntegration.integrationId`: the underlying integration id. */
  readonly activeIntegrationId: string | null;
  readonly contentType: string;
  readonly text: string | null;
  readonly payload: string | null;
}

export interface ZendeskAuthenticatedAccount {
  /** The resolver must set this only after authenticating the Zendesk user/account link. */
  readonly authenticated: true;
  /** Stable company-side account identifier, not a display name or email address. */
  readonly customerId: string;
  /** Timezone-aware instant when this evidence snapshot was read. */
  readonly observedAt: string;
  /** Point-in-time, read-only evidence loaded from the company's systems. */
  readonly evidence: readonly WordlessEvidence[];
  readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
}

export interface ZendeskPendingChoice {
  readonly payload: string;
  readonly id: string;
  readonly label: string;
  readonly reply: string;
  readonly detectorId: string | null;
  readonly evidenceIndexes: readonly number[];
  /** `skip` is used for neutral navigation choices that are not detector feedback. */
  readonly feedback: "confirmed" | "none" | "skip";
}

export interface ZendeskPendingChoiceSet {
  readonly appId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly suggestionId: string;
  readonly sourceMessageId: string;
  /** Random per-source-message value embedded in and bound to every choice payload. */
  readonly sourceMessageNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly choices: readonly ZendeskPendingChoice[];
}

export interface ZendeskResolvedChoice {
  readonly appId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly suggestionId: string;
  readonly sourceMessageId: string;
  readonly sourceMessageNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** The first selection event id, or the same id again for an idempotent retry. */
  readonly selectionEventId: string;
  readonly choiceId: string;
  readonly detectorId: string | null;
  readonly reply: string;
  readonly feedback: "confirmed" | "none" | "skip";
}

/**
 * Production integrations should implement this with a tenant-isolated durable store.
 * `resolve` must bind a payload to the same app, conversation, and user that received it.
 * It must atomically consume a fresh payload for `selectionEventId`, return the same
 * result for a retry of that event id, and return null when a different event id replays
 * the consumed payload. It must also reject an unconsumed payload after `expiresAt`.
 */
export interface ZendeskChoiceStore {
  save(value: ZendeskPendingChoiceSet): Promise<void>;
  resolve(input: {
    readonly appId: string;
    readonly conversationId: string;
    readonly userId: string;
    readonly payload: string;
    readonly selectionEventId: string;
    readonly selectionReceivedAt: string;
    readonly sourceMessageNonce: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }): Promise<ZendeskResolvedChoice | null>;
}

export interface ZendeskReplyAction {
  readonly type: "reply";
  readonly text: string;
  readonly payload: string;
}

export interface ZendeskTextMessageBody {
  readonly author: { readonly type: "business" };
  /** Flat, non-secret reconciliation metadata (maximum 4 KB when serialized). */
  readonly metadata?: ZendeskMessageMetadata;
  readonly content: {
    readonly type: "text";
    readonly text: string;
    /** Keep free typing available while choices are visible. */
    readonly blockChatInput: false;
    readonly actions?: readonly ZendeskReplyAction[];
  };
}

export type ZendeskMessageMetadataValue = string | number | boolean;
export type ZendeskMessageMetadata = Readonly<Record<string, ZendeskMessageMetadataValue>>;

export interface ZendeskPassControlBody {
  readonly switchboardIntegration: string;
  readonly metadata?: ZendeskSwitchboardMetadata;
}

export type ZendeskSwitchboardMetadataValue = string | number | boolean;
export type ZendeskSwitchboardMetadata = Readonly<
  Record<string, ZendeskSwitchboardMetadataValue>
>;

export interface ZendeskReleaseControlBody {
  readonly metadata?: ZendeskSwitchboardMetadata;
}

export interface ZendeskApiRequest<TBody> {
  readonly method: "POST";
  readonly path: string;
  readonly body: TBody;
}

export type ZendeskHandoffReason =
  | "account_not_authenticated"
  | "choice_selected"
  | "evidence_unavailable"
  | "human_requested"
  | "message_too_long"
  | "unsupported_content"
  | "wordless_unavailable"
  | "wordless_yielded";

interface ZendeskResultBase {
  readonly incoming: ZendeskInboundMessage;
  /** Durable Zendesk event id. Claim it before executing the returned API request. */
  readonly deduplicationKey: string;
}

export interface ZendeskPostMessageResult extends ZendeskResultBase {
  readonly kind: "post_message";
  readonly request: ZendeskApiRequest<ZendeskTextMessageBody>;
  readonly handoff: null;
  readonly wordless: {
    readonly suggestionId: string;
    readonly outcome: WordlessSupportChatTurn["kind"];
    readonly reviewRequired: true;
    readonly readOnly: true;
    readonly evidenceIndexes: readonly number[];
  };
  readonly pendingChoices: ZendeskPendingChoiceSet | null;
}

export interface ZendeskPassControlResult extends ZendeskResultBase {
  readonly kind: "pass_control";
  readonly request: ZendeskApiRequest<ZendeskPassControlBody>;
  readonly handoff: {
    readonly target: "next" | "human";
    readonly reason: ZendeskHandoffReason;
    readonly firstMessageId: string;
    readonly suggestionId: string | null;
    readonly confirmedChoice: ZendeskResolvedChoice | null;
  };
  readonly wordless: null;
  readonly pendingChoices: null;
}

export interface ZendeskIgnoredResult {
  readonly kind: "ignored";
  readonly reason:
    | "business_authored"
    | "inactive_integration"
    | "unsupported_event";
  readonly eventId: string | null;
}

export type ZendeskMessagingResult =
  | ZendeskPostMessageResult
  | ZendeskPassControlResult
  | ZendeskIgnoredResult;

export interface ZendeskMessagingAdapterOptions {
  readonly chatbot: WordlessSupportChatbot;
  readonly expectedAppId: string;
  readonly expectedWebhookId: string;
  /** `activeSwitchboardIntegration.id`, not its underlying `integrationId`. */
  readonly switchboardIntegrationId: string;
  /** Optional defense-in-depth check against `activeSwitchboardIntegration.integrationId`. */
  readonly underlyingIntegrationId?: string;
  /** Direct Switchboard entry for Agent Workspace. Human requests bypass the normal bot. */
  readonly humanSwitchboardIntegrationId?: string;
  /** Separate 32+ byte secret used to authenticate quick-reply payloads. */
  readonly choiceSigningSecret: string;
  readonly resolveAuthenticatedAccount: (
    input: ZendeskInboundMessage,
  ) => Promise<ZendeskAuthenticatedAccount | null>;
  /** Convert resolver outages into an immediate safe pass to the next integration. Defaults to throw. */
  readonly accountResolutionFailureMode?: "throw" | "pass_control";
  /** Called only when account resolution is converted into a safe pass. */
  readonly onAccountResolutionError?: (
    error: unknown,
    input: ZendeskInboundMessage,
  ) => void;
  /** Feedback is best-effort; failures reported here never block the customer handoff. */
  readonly onFeedbackError?: (
    error: unknown,
    input: ZendeskInboundMessage,
  ) => void;
  /** Required one-time durable store; an in-memory store is not safe across workers. */
  readonly choiceStore: ZendeskChoiceStore;
  /** Choice lifetime. Defaults to 30 minutes and may not exceed 24 hours. */
  readonly choiceTtlMs?: number;
  /** Testable clock; production should omit this. */
  readonly now?: () => Date;
  /** Called when a Wordless SDK/network error is converted into a safe handoff. */
  readonly onWordlessError?: (
    error: WordlessSdkError,
    input: ZendeskInboundMessage,
  ) => void;
}

export interface ZendeskMessagingAdapter {
  processWebhook(value: unknown): Promise<readonly ZendeskMessagingResult[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new ZendeskWebhookValidationError(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value)
  ) {
    throw new ZendeskWebhookValidationError(`${label} is invalid.`);
  }
  return value;
}

function optionalString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

interface ParsedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly eventCreatedAt: string;
  readonly conversationId: string | null;
  readonly inbound: ZendeskInboundMessage | null;
  readonly activeSwitchboardIntegrationId: string | null;
  readonly activeIntegrationId: string | null;
  readonly authorType: string | null;
}

function parseEvent(
  value: unknown,
  appId: string,
  webhookId: string,
): ParsedEvent {
  if (!isRecord(value)) {
    throw new ZendeskWebhookValidationError("Zendesk webhook event must be an object.");
  }
  const eventId = identifier(value.id, "Zendesk event id");
  const type = typeof value.type === "string" ? value.type : "";
  const eventCreatedAt = timestamp(value.createdAt, "Zendesk event createdAt");
  if (type !== "conversation:message") {
    let conversationId: string | null = null;
    let activeSwitchboardIntegrationId: string | null = null;
    let activeIntegrationId: string | null = null;
    if (
      type === "conversation:create" ||
      type === "conversation:referral" ||
      type === "switchboard:passControl" ||
      type === "switchboard:releaseControl"
    ) {
      if (!isRecord(value.payload) || !isRecord(value.payload.conversation)) {
        throw new ZendeskWebhookValidationError("Zendesk lifecycle event is incomplete.");
      }
      conversationId = identifier(
        value.payload.conversation.id,
        "Zendesk lifecycle conversation id",
      );
      const active = value.payload.conversation.activeSwitchboardIntegration;
      if (active !== undefined && active !== null) {
        if (!isRecord(active)) {
          throw new ZendeskWebhookValidationError("Zendesk lifecycle active integration is invalid.");
        }
        activeSwitchboardIntegrationId = identifier(
          active.id,
          "Zendesk lifecycle active Switchboard integration id",
        );
        activeIntegrationId = identifier(
          active.integrationId,
          "Zendesk lifecycle active integration id",
        );
      }
    }
    return {
      eventId,
      type,
      eventCreatedAt,
      conversationId,
      inbound: null,
      activeSwitchboardIntegrationId,
      activeIntegrationId,
      authorType: null,
    };
  }
  if (!isRecord(value.payload)) {
    throw new ZendeskWebhookValidationError("Zendesk message event payload is invalid.");
  }
  const conversation = value.payload.conversation;
  const message = value.payload.message;
  if (!isRecord(conversation) || !isRecord(message)) {
    throw new ZendeskWebhookValidationError("Zendesk message event is incomplete.");
  }
  const conversationId = identifier(conversation.id, "Zendesk conversation id");
  let activeSwitchboardIntegrationId: string | null = null;
  let activeIntegrationId: string | null = null;
  if (isRecord(conversation.activeSwitchboardIntegration)) {
    activeSwitchboardIntegrationId = optionalString(
      conversation.activeSwitchboardIntegration.id,
      128,
    );
    activeIntegrationId = optionalString(
      conversation.activeSwitchboardIntegration.integrationId,
      128,
    );
  }
  if (!isRecord(message.author)) {
    throw new ZendeskWebhookValidationError("Zendesk message author is invalid.");
  }
  const authorType = optionalString(message.author.type, 64);
  if (authorType !== "user") {
    return {
      eventId,
      type,
      eventCreatedAt,
      conversationId,
      inbound: null,
      activeSwitchboardIntegrationId,
      activeIntegrationId,
      authorType,
    };
  }
  const userId = identifier(message.author.userId, "Zendesk user id");
  const messageId = identifier(message.id, "Zendesk message id");
  const receivedAt = timestamp(message.received, "Zendesk message received");
  if (!isRecord(message.content) || typeof message.content.type !== "string") {
    throw new ZendeskWebhookValidationError("Zendesk message content is invalid.");
  }
  const contentType = message.content.type;
  const text = optionalString(message.content.text, 100_000);
  const payload = optionalString(message.content.payload, 1_024);
  const source = isRecord(message.source) ? message.source : {};
  const sourceType = optionalString(source.type, 64) ?? "unknown";
  const sourceIntegrationId = optionalString(source.integrationId, 128);
  return {
    eventId,
    type,
    eventCreatedAt,
    conversationId,
    activeSwitchboardIntegrationId,
    activeIntegrationId,
    authorType,
    inbound: {
      appId,
      webhookId,
      eventId,
      eventCreatedAt,
      conversationId,
      messageId,
      receivedAt,
      userId,
      sourceType,
      sourceIntegrationId,
      activeSwitchboardIntegrationId,
      activeIntegrationId,
      contentType,
      text,
      payload,
    },
  };
}

function parseEnvelope(
  value: unknown,
  expectedAppId: string,
  expectedWebhookId: string,
): readonly ParsedEvent[] {
  if (!isRecord(value) || !isRecord(value.app) || !isRecord(value.webhook)) {
    throw new ZendeskWebhookValidationError("Zendesk webhook envelope is invalid.");
  }
  const appId = identifier(value.app.id, "Zendesk app id");
  const webhookId = identifier(value.webhook.id, "Zendesk webhook id");
  if (value.webhook.version !== "v2") {
    throw new ZendeskWebhookValidationError("Only Zendesk webhook version v2 is supported.");
  }
  if (appId !== expectedAppId || webhookId !== expectedWebhookId) {
    throw new ZendeskWebhookValidationError(
      "Zendesk webhook does not belong to the configured installation.",
    );
  }
  if (!Array.isArray(value.events) || value.events.length > MAX_WEBHOOK_EVENTS) {
    throw new ZendeskWebhookValidationError(
      `Zendesk webhook events must contain at most ${MAX_WEBHOOK_EVENTS} items.`,
    );
  }
  return value.events.map((event) => parseEvent(event, appId, webhookId));
}

export interface ZendeskWebhookPreflightOptions {
  readonly expectedAppId: string;
  readonly expectedWebhookId: string;
  /** `activeSwitchboardIntegration.id`. */
  readonly switchboardIntegrationId: string;
  /** Optional defense-in-depth match for the underlying integration id. */
  readonly underlyingIntegrationId?: string;
  /** Maximum accepted event timestamp lead. Defaults to five minutes. */
  readonly maxFutureSkewMs?: number;
  /** Testable clock; production should omit this. */
  readonly now?: () => Date;
}

export interface ZendeskWebhookPreflightEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventCreatedAt: string;
  readonly conversationId: string | null;
  readonly customerActivity: boolean;
  readonly configuredIntegrationActive: boolean;
}

/**
 * Strict, read-only webhook validation for durable hosts before they claim an event.
 * This is backed by the same parser used by `createZendeskMessagingAdapter` and never
 * calls the account resolver, Wordless, or Zendesk.
 */
export function preflightZendeskWebhook(
  value: unknown,
  options: ZendeskWebhookPreflightOptions,
): readonly ZendeskWebhookPreflightEvent[] {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk preflight options must be an object.");
  }
  identifier(options.expectedAppId, "Expected Zendesk app id");
  identifier(options.expectedWebhookId, "Expected Zendesk webhook id");
  identifier(options.switchboardIntegrationId, "Zendesk switchboard integration id");
  if (options.underlyingIntegrationId !== undefined) {
    identifier(options.underlyingIntegrationId, "Zendesk underlying integration id");
  }
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60 * 1_000;
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 || maxFutureSkewMs > 24 * 60 * 60 * 1_000) {
    throw new ZendeskIntegrationError("maxFutureSkewMs must be between zero and 24 hours.");
  }
  const now = options.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ZendeskIntegrationError("Zendesk preflight now returned an invalid date.");
  }
  const events = parseEnvelope(value, options.expectedAppId, options.expectedWebhookId);
  return Object.freeze(events.map((event): ZendeskWebhookPreflightEvent => {
    if (Date.parse(event.eventCreatedAt) > now.getTime() + maxFutureSkewMs) {
      throw new ZendeskWebhookValidationError("Zendesk event createdAt is too far in the future.");
    }
    const configuredIntegrationActive =
      event.activeSwitchboardIntegrationId === options.switchboardIntegrationId &&
      (options.underlyingIntegrationId === undefined ||
        event.activeIntegrationId === options.underlyingIntegrationId);
    return Object.freeze({
      eventId: event.eventId,
      eventType: event.type,
      eventCreatedAt: event.eventCreatedAt,
      conversationId: event.conversationId,
      customerActivity: event.type === "conversation:message" && event.authorType === "user" && event.inbound !== null,
      configuredIntegrationActive,
    });
  }));
}

function apiPath(appId: string, conversationId: string, suffix: string): string {
  return `/sc/v2/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(
    conversationId,
  )}/${suffix}`;
}

function validateFlatMetadata(
  value: ZendeskSwitchboardMetadata | ZendeskMessageMetadata | undefined,
  label: string,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new ZendeskIntegrationError(`${label} must be an object.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      /[\r\n]/u.test(key) ||
      (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new ZendeskIntegrationError(
        `${label} must contain only flat strings, finite numbers, or booleans.`,
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4_096) {
    throw new ZendeskIntegrationError(`${label} exceeds 4 KB.`);
  }
}

export type ZendeskPassControlDestination =
  | {
      readonly mode: "next";
      /** Required because app-scoped `next` calls can advance more than once on retry. */
      readonly credentialScope: "integration";
    }
  | {
      readonly mode: "integration";
      readonly switchboardIntegrationId: string;
      readonly credentialScope: "app" | "integration";
    };

export interface ZendeskPassControlRequestOptions {
  readonly appId: string;
  readonly conversationId: string;
  readonly destination: ZendeskPassControlDestination;
  readonly metadata?: ZendeskSwitchboardMetadata;
}

/** Build an idempotence-safe Switchboard pass-control request. */
export function createZendeskPassControlRequest(
  options: ZendeskPassControlRequestOptions,
): ZendeskApiRequest<ZendeskPassControlBody> {
  if (!isRecord(options) || !isRecord(options.destination)) {
    throw new ZendeskIntegrationError("Zendesk pass-control options are invalid.");
  }
  identifier(options.appId, "Zendesk app id");
  identifier(options.conversationId, "Zendesk conversation id");
  validateFlatMetadata(options.metadata, "Zendesk Switchboard metadata");
  let switchboardIntegration: string;
  if (options.destination.mode === "next") {
    if (options.destination.credentialScope !== "integration") {
      throw new ZendeskIntegrationError(
        'Only integration-scoped credentials may use the "next" Switchboard target.',
      );
    }
    switchboardIntegration = "next";
  } else if (options.destination.mode === "integration") {
    if (
      options.destination.credentialScope !== "app" &&
      options.destination.credentialScope !== "integration"
    ) {
      throw new ZendeskIntegrationError("Zendesk credential scope is invalid.");
    }
    switchboardIntegration = identifier(
      options.destination.switchboardIntegrationId,
      "Zendesk target Switchboard integration id",
    );
    if (switchboardIntegration === "next") {
      throw new ZendeskIntegrationError(
        'Use destination mode "next" with integration-scoped credentials for the next target.',
      );
    }
  } else {
    throw new ZendeskIntegrationError("Zendesk pass-control destination is invalid.");
  }
  return Object.freeze({
    method: "POST" as const,
    path: apiPath(options.appId, options.conversationId, "passControl"),
    body: Object.freeze({
      switchboardIntegration,
      ...(options.metadata === undefined
        ? {}
        : { metadata: Object.freeze({ ...options.metadata }) }),
    }),
  });
}

export interface ZendeskReleaseControlRequestOptions {
  readonly appId: string;
  readonly conversationId: string;
  readonly metadata?: ZendeskSwitchboardMetadata;
}

export interface ZendeskControlReleasePlanOptions
  extends ZendeskReleaseControlRequestOptions {
  /** Instant when this integration acquired control. */
  readonly acquiredAt: string;
  /** May be shorter, but never longer, than Zendesk's 24-hour maximum. */
  readonly releaseAfterMs?: number;
}

export interface ZendeskControlReleasePlan {
  readonly acquiredAt: string;
  /** Persist a job that executes the request no later than this instant. */
  readonly releaseNoLaterThan: string;
  readonly request: ZendeskApiRequest<ZendeskReleaseControlBody>;
}

/** Release control when the interaction is resolved, or before the 24-hour maximum. */
export function createZendeskReleaseControlRequest(
  options: ZendeskReleaseControlRequestOptions,
): ZendeskApiRequest<ZendeskReleaseControlBody> {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk release-control options are invalid.");
  }
  identifier(options.appId, "Zendesk app id");
  identifier(options.conversationId, "Zendesk conversation id");
  validateFlatMetadata(options.metadata, "Zendesk Switchboard metadata");
  return Object.freeze({
    method: "POST" as const,
    path: apiPath(options.appId, options.conversationId, "releaseControl"),
    body: Object.freeze(options.metadata === undefined
      ? {}
      : { metadata: Object.freeze({ ...options.metadata }) }),
  });
}

/** Create the durable deadline and exact request for a control lease. */
export function createZendeskControlReleasePlan(
  options: ZendeskControlReleasePlanOptions,
): ZendeskControlReleasePlan {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk control release plan is invalid.");
  }
  const acquiredAtMs = typeof options.acquiredAt === "string"
    ? Date.parse(options.acquiredAt)
    : Number.NaN;
  if (
    !Number.isFinite(acquiredAtMs) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(options.acquiredAt)
  ) {
    throw new ZendeskIntegrationError("Zendesk control acquiredAt is invalid.");
  }
  const releaseAfterMs = options.releaseAfterMs ?? ZENDESK_MAX_CONTROL_DURATION_MS;
  if (
    !Number.isSafeInteger(releaseAfterMs) ||
    releaseAfterMs < 60_000 ||
    releaseAfterMs > ZENDESK_MAX_CONTROL_DURATION_MS
  ) {
    throw new ZendeskIntegrationError(
      "Zendesk releaseAfterMs must be between one minute and 24 hours.",
    );
  }
  return Object.freeze({
    acquiredAt: new Date(acquiredAtMs).toISOString(),
    releaseNoLaterThan: new Date(acquiredAtMs + releaseAfterMs).toISOString(),
    request: createZendeskReleaseControlRequest(options),
  });
}

function passControl(
  incoming: ZendeskInboundMessage,
  reason: ZendeskHandoffReason,
  suggestionId: string | null = null,
  confirmedChoice: ZendeskResolvedChoice | null = null,
  humanSwitchboardIntegrationId: string | null = null,
): ZendeskPassControlResult {
  const humanTarget = reason === "human_requested" && humanSwitchboardIntegrationId !== null;
  return Object.freeze({
    kind: "pass_control" as const,
    incoming,
    deduplicationKey: incoming.eventId,
    request: createZendeskPassControlRequest({
      appId: incoming.appId,
      conversationId: incoming.conversationId,
      destination: humanTarget
        ? {
            mode: "integration" as const,
            switchboardIntegrationId: humanSwitchboardIntegrationId,
            credentialScope: "integration" as const,
          }
        : { mode: "next" as const, credentialScope: "integration" as const },
      metadata: {
        first_message_id: incoming.messageId,
        handoff_reason: reason,
      },
    }),
    handoff: Object.freeze({
      target: humanTarget ? "human" as const : "next" as const,
      reason,
      firstMessageId: incoming.messageId,
      suggestionId,
      confirmedChoice,
    }),
    wordless: null,
    pendingChoices: null,
  });
}

function choiceFeedback(
  turn: WordlessSupportChatTurn,
  choice: WordlessSupportChoice,
): "confirmed" | "none" | "skip" {
  if (choice.detectorId !== null) return "confirmed";
  return turn.kind === "clarification_choices" ? "none" : "skip";
}

function pendingChoiceSet(
  incoming: ZendeskInboundMessage,
  turn: WordlessSupportChatTurn,
  signingSecret: string,
  issued: Date,
  choiceTtlMs: number,
): ZendeskPendingChoiceSet | null {
  if (turn.renderMode !== "choices" || turn.choices.length === 0) return null;
  const issuedAtSeconds = Math.floor(issued.getTime() / 1_000);
  const expiresAtSeconds = issuedAtSeconds + Math.ceil(choiceTtlMs / 1_000);
  const issuedAt = new Date(issuedAtSeconds * 1_000).toISOString();
  const expiresAt = new Date(expiresAtSeconds * 1_000).toISOString();
  const sourceMessageNonce = randomBytes(12).toString("base64url");
  return Object.freeze({
    appId: incoming.appId,
    conversationId: incoming.conversationId,
    userId: incoming.userId,
    suggestionId: turn.suggestionId,
    sourceMessageId: incoming.messageId,
    sourceMessageNonce,
    issuedAt,
    expiresAt,
    choices: Object.freeze(turn.choices.map((choice) => {
      const feedback = choiceFeedback(turn, choice);
      return Object.freeze({
        payload: createSignedChoicePayload(
          incoming,
          turn.suggestionId,
          choice.id,
          choice.detectorId,
          feedback,
          issuedAtSeconds,
          expiresAtSeconds,
          sourceMessageNonce,
          signingSecret,
        ),
        id: choice.id,
        label: choice.label,
        reply: choice.reply,
        detectorId: choice.detectorId,
        evidenceIndexes: choice.evidenceIndexes,
        feedback,
      });
    })),
  });
}

function choiceFeedbackCode(
  detectorId: string | null,
  feedback: "confirmed" | "none" | "skip",
): string {
  if (feedback === "confirmed" && detectorId !== null) return `c_${detectorId}`;
  if (feedback === "none" && detectorId === null) return "none";
  if (feedback === "skip" && detectorId === null) return "skip";
  throw new ZendeskIntegrationError("Wordless choice feedback metadata is inconsistent.");
}

function choiceSignature(
  incoming: Pick<ZendeskInboundMessage, "appId" | "conversationId" | "userId">,
  core: string,
  signingSecret: string,
): string {
  return createHmac("sha256", Buffer.from(signingSecret, "utf8"))
    .update(`${incoming.appId}\n${incoming.conversationId}\n${incoming.userId}\n${core}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function createSignedChoicePayload(
  incoming: ZendeskInboundMessage,
  suggestionId: string,
  choiceId: string,
  detectorId: string | null,
  feedback: "confirmed" | "none" | "skip",
  issuedAtSeconds: number,
  expiresAtSeconds: number,
  sourceMessageNonce: string,
  signingSecret: string,
): string {
  const code = choiceFeedbackCode(detectorId, feedback);
  const core = `wl2.${suggestionId}.${choiceId}.${code}.${issuedAtSeconds.toString(36)}.${expiresAtSeconds.toString(36)}.${sourceMessageNonce}`;
  return `${core}.${choiceSignature(incoming, core, signingSecret)}`;
}

function postMessage(
  incoming: ZendeskInboundMessage,
  turn: WordlessSupportChatTurn,
  pendingChoices: ZendeskPendingChoiceSet | null,
): ZendeskPostMessageResult {
  if (turn.message === null) {
    throw new ZendeskIntegrationError("A visible Wordless turn must contain a message.");
  }
  const actions = pendingChoices?.choices.map((choice): ZendeskReplyAction => Object.freeze({
    type: "reply",
    text: choice.label,
    payload: choice.payload,
  }));
  const text = actions === undefined
    ? turn.message
    : `${turn.message}\n\nChoose an option, or type your own message.`;
  return Object.freeze({
    kind: "post_message" as const,
    incoming,
    deduplicationKey: incoming.eventId,
    request: Object.freeze({
      method: "POST" as const,
      path: apiPath(incoming.appId, incoming.conversationId, "messages"),
      body: Object.freeze({
        author: Object.freeze({ type: "business" as const }),
        metadata: Object.freeze({ wordless_delivery_key: incoming.eventId }),
        content: Object.freeze({
          type: "text" as const,
          text,
          blockChatInput: false as const,
          ...(actions === undefined ? {} : { actions: Object.freeze(actions) }),
        }),
      }),
    }),
    handoff: null,
    wordless: Object.freeze({
      suggestionId: turn.suggestionId,
      outcome: turn.kind,
      reviewRequired: true as const,
      readOnly: true as const,
      evidenceIndexes: turn.evidenceIndexes,
    }),
    pendingChoices,
  });
}

function validateAccount(
  value: ZendeskAuthenticatedAccount,
  incoming: ZendeskInboundMessage,
): void {
  const observedAt = typeof value.observedAt === "string"
    ? Date.parse(value.observedAt)
    : Number.NaN;
  if (
    !isRecord(value) ||
    value.authenticated !== true ||
    typeof value.customerId !== "string" ||
    value.customerId.length === 0 ||
    value.customerId.length > 512 ||
    value.customerId !== value.customerId.trim() ||
    !Array.isArray(value.evidence) ||
    !Number.isFinite(observedAt) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value.observedAt) ||
    observedAt < Date.parse(incoming.receivedAt)
  ) {
    throw new ZendeskIntegrationError("Authenticated account resolver returned invalid data.");
  }
}

function showChoicesRequested(incoming: ZendeskInboundMessage): boolean {
  const text = incoming.text?.trim() ?? "";
  return (
    incoming.payload === ZENDESK_SHOW_CHOICES_PAYLOAD ||
    text.length === 0 ||
    SHOW_CHOICES_TEXT_PATTERN.test(text)
  );
}

function humanRequestTokens(clause: string): string[] {
  return clause
    .toLowerCase()
    .replace(/['’]/gu, "")
    .split(/[^a-z]+/u)
    .filter((token) => token.length > 0);
}

function purposeIsSupported(tokens: readonly string[], verbIndex: number): boolean {
  const verb = tokens[verbIndex] ?? "";
  const objects = tokens.slice(verbIndex + 1).filter((token) =>
    !["a", "an", "my", "the", "this", "your"].includes(token),
  );
  if (HUMAN_SUPPORTED_PURPOSE_TOKENS.has(verb)) return true;
  if (verb === "take") return objects[0] === "over";
  if (verb === "return") return ["call", "email", "message"].includes(objects[0] ?? "");
  if (verb === "open") return ["case", "request", "ticket"].includes(objects[0] ?? "");
  if (["accept", "send"].includes(verb)) {
    return !objects.some((token) => ["delivery", "item", "order", "package", "parcel"].includes(token));
  }
  return !HUMAN_UNSUPPORTED_PURPOSE_TOKENS.has(verb);
}

function humanRoleHasUnsupportedPurpose(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let roleIndex = 0; roleIndex < tokens.length - 2; roleIndex += 1) {
    if (!FUZZY_HUMAN_ROLE_TOKENS.has(tokens[roleIndex]!) || tokens[roleIndex + 1] !== "to") continue;
    if (!purposeIsSupported(tokens, roleIndex + 2)) return true;
  }
  return false;
}

function humanRoleTrailingIsSafe(trailing: readonly string[]): boolean {
  if (trailing.length === 0 || trailing.every((token) => FUZZY_HUMAN_POLITE_TOKENS.has(token))) {
    return true;
  }
  let firstMeaningful = 0;
  while (FUZZY_HUMAN_POLITE_TOKENS.has(trailing[firstMeaningful] ?? "")) firstMeaningful += 1;
  const core = trailing.slice(firstMeaningful);
  if (core.length === 0) return true;
  if (core.length === 1 && ["me", "us"].includes(core[0]!)) return true;
  if (core.length === 1 && core[0] === "involved") return true;
  if (core[0] === "step" && core[1] === "in") {
    return core.slice(2).every((token) => FUZZY_HUMAN_POLITE_TOKENS.has(token));
  }
  if (core[0] === "get" && ["help", "hlp"].includes(core[1] ?? "")) {
    return core.slice(2).every((token) => ["me", "us"].includes(token) || FUZZY_HUMAN_POLITE_TOKENS.has(token));
  }
  if (
    core[0] === "to" &&
    ["bring", "carry", "deliver", "drive", "drop", "ship"].includes(core[1] ?? "")
  ) {
    return false;
  }
  if (core[0] === "to") return purposeIsSupported(core, 1);
  if (["about", "because", "for", "from", "on", "regarding", "with"].includes(core[0]!)) {
    return true;
  }
  if (["help", "hlp"].includes(core[0]!) && (core.length === 1 || ["me", "us"].includes(core[1] ?? ""))) {
    return core.slice(core.length === 1 ? 1 : 2).every((token) => FUZZY_HUMAN_POLITE_TOKENS.has(token));
  }
  if (["call", "contact"].includes(core[0]!) && ["me", "us"].includes(core[1] ?? "")) {
    return core.slice(2).every((token) => FUZZY_HUMAN_POLITE_TOKENS.has(token));
  }
  if (
    core[0] === "who" &&
    ["can", "could", "will", "would"].includes(core[1] ?? "") &&
    core[2] === "help"
  ) {
    return core.slice(3).every((token) =>
      ["me", "us"].includes(token) || FUZZY_HUMAN_POLITE_TOKENS.has(token),
    );
  }
  if (
    ["i", "we"].includes(core[0]!) &&
    ["can", "could"].includes(core[1] ?? "") &&
    ["chat", "speak", "talk"].includes(core[2] ?? "") &&
    ["to", "with"].includes(core[3] ?? "")
  ) {
    return core.slice(4).every((token) => FUZZY_HUMAN_POLITE_TOKENS.has(token));
  }
  if (
    ["can", "could", "should", "will", "would"].includes(core[0]!) &&
    (
      core[1] === "help" ||
      core[1] === "handle" ||
      ["conect", "connect", "forward", "pass", "route", "send", "tranfer", "transfer"].includes(core[1] ?? "") ||
      (core[1] === "take" && core[2] === "over")
    )
  ) {
    return true;
  }
  if (core[0] === "take" && core[1] === "over") return true;
  if (
    ["need", "ned"].includes(core[0]!) &&
    ["help", "hlp"].includes(core[1] ?? "") &&
    core.slice(2).every((token) => ["me", "us"].includes(token) || FUZZY_HUMAN_POLITE_TOKENS.has(token))
  ) {
    return true;
  }
  if (
    ["help", "hlp", "need", "ned", "speak", "spk", "tak", "talk", "tlk", "want", "wnat", "wnt"].includes(core[0]!) &&
    core.slice(1).every((token) => FUZZY_HUMAN_POLITE_TOKENS.has(token))
  ) {
    return true;
  }
  if (
    ["ask", "conect", "connect", "forward", "get", "give", "pass", "route", "send", "tranfer", "transfer"].includes(core[0]!) &&
    core.slice(1).every((token) => token === "me" || FUZZY_HUMAN_POLITE_TOKENS.has(token))
  ) {
    return true;
  }
  return (
    ["might", "would"].includes(core[0]!) &&
    core[1] === "be" &&
    ["best", "better", "easier", "helpful"].includes(core[2] ?? "") &&
    core.slice(3).every((token) => FUZZY_HUMAN_POLITE_TOKENS.has(token))
  );
}

function fuzzyHumanRequestIsNegated(tokens: readonly string[], roleIndex: number): boolean {
  for (let index = 0; index < roleIndex; index += 1) {
    if (!FUZZY_HUMAN_NEGATION_TOKENS.has(tokens[index]!)) continue;
    const scope = tokens.slice(index + 1, roleIndex);
    if (
      scope.length === 0 ||
      scope.some((token) => FUZZY_HUMAN_CUE_TOKENS.has(token)) ||
      scope.some((token) => FUZZY_HUMAN_REPORTING_TOKENS.has(token))
    ) {
      return true;
    }
  }
  return false;
}

function fuzzyHumanClauseIsNegated(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  return tokens.some((token, roleIndex) =>
    FUZZY_HUMAN_ROLE_TOKENS.has(token) && fuzzyHumanRequestIsNegated(tokens, roleIndex),
  );
}

function fuzzyHumanRequested(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  if (tokens.length === 0 || tokens.length > 18) return false;
  for (let roleIndex = 0; roleIndex < tokens.length; roleIndex += 1) {
    if (!FUZZY_HUMAN_ROLE_TOKENS.has(tokens[roleIndex]!)) continue;
    if (fuzzyHumanRequestIsNegated(tokens, roleIndex)) continue;
    const trailing = tokens.slice(roleIndex + 1);
    if (!humanRoleTrailingIsSafe(trailing)) continue;
    if (tokens.length === 1) return true;
    const leading = tokens.slice(0, roleIndex);
    if (leading.every((token) =>
      ["a", "actual", "an", "another", "just", "live", "me", "real", "the", "your"].includes(token) || FUZZY_HUMAN_POLITE_TOKENS.has(token),
    )) return true;
    for (let cueIndex = 0; cueIndex < roleIndex; cueIndex += 1) {
      if (!FUZZY_HUMAN_CUE_TOKENS.has(tokens[cueIndex]!)) continue;
      const fillers = tokens.slice(cueIndex + 1, roleIndex);
      if (fillers.every((token) =>
        FUZZY_HUMAN_FILLERS.has(token) || FUZZY_HUMAN_POLITE_TOKENS.has(token),
      )) return true;
    }
  }
  return false;
}

function fuzzyHumanInabilityRequested(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let roleIndex = 0; roleIndex < tokens.length; roleIndex += 1) {
    if (!FUZZY_HUMAN_ROLE_TOKENS.has(tokens[roleIndex]!)) continue;
    if (!humanRoleTrailingIsSafe(tokens.slice(roleIndex + 1))) continue;
    for (let negativeIndex = 0; negativeIndex < roleIndex; negativeIndex += 1) {
      if (!["cannot", "cant", "couldnt", "doesnt", "wont"].includes(tokens[negativeIndex]!)) continue;
      const scope = tokens.slice(negativeIndex + 1, roleIndex);
      const requesterContext = tokens.slice(0, negativeIndex + 2);
      const hasFirstPerson = negativeIndex === 0 ||
        requesterContext.includes("i") ||
        requesterContext.some((token) => ["bot", "chatbot", "it", "robot", "this", "you"].includes(token));
      const hasConnectionAction = scope.some((token) =>
        ["chat", "conect", "connect", "contact", "get", "reach", "speak", "spk", "tak", "talk", "tlk"].includes(token),
      );
      if (hasFirstPerson && hasConnectionAction) return true;
    }
  }
  return false;
}

function cueIsExplicitlyNegated(tokens: readonly string[], cueIndex: number): boolean {
  const preceding = tokens.slice(Math.max(0, cueIndex - 3), cueIndex);
  return preceding.some((token) => FUZZY_HUMAN_NEGATION_TOKENS.has(token));
}

function explicitlyPrefersBotOrRefusesHuman(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let targetIndex = 0; targetIndex < tokens.length; targetIndex += 1) {
    const target = tokens[targetIndex]!;
    if (["bot", "bots", "chatbot", "chatbots", "robot"].includes(target)) {
      for (let cueIndex = Math.max(0, targetIndex - 5); cueIndex < targetIndex; cueIndex += 1) {
        if (!["choose", "keep", "like", "need", "prefer", "use", "want"].includes(tokens[cueIndex]!)) continue;
        if (!tokens.slice(cueIndex + 1, targetIndex).every((token) =>
          ["a", "an", "only", "really", "the", "this"].includes(token),
        )) continue;
        if (!cueIsExplicitlyNegated(tokens, cueIndex)) return true;
      }
      continue;
    }
    if (target !== "one" && !FUZZY_HUMAN_ROLE_TOKENS.has(target)) continue;
    for (let cueIndex = Math.max(0, targetIndex - 5); cueIndex < targetIndex; cueIndex += 1) {
      if (!["ask", "asking", "have", "need", "prefer", "request", "requesting", "want"].includes(tokens[cueIndex]!)) continue;
      if (cueIsExplicitlyNegated(tokens, cueIndex)) return true;
    }
  }
  return false;
}

function botRoutesToHuman(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let botIndex = 0; botIndex < tokens.length; botIndex += 1) {
    if (!["bot", "bots", "chatbot", "chatbots", "robot"].includes(tokens[botIndex]!)) continue;
    for (let routeIndex = botIndex + 1; routeIndex < tokens.length; routeIndex += 1) {
      if (!["conect", "connect", "forward", "pass", "route", "tranfer", "transfer"].includes(tokens[routeIndex]!)) {
        continue;
      }
      const negativeBeforeBot = tokens.slice(0, botIndex).some((token) =>
        FUZZY_HUMAN_NEGATION_TOKENS.has(token),
      );
      const contrastAfterBot = tokens.slice(botIndex + 1, routeIndex).some((token) =>
        ["and", "but", "instead"].includes(token),
      );
      if ((negativeBeforeBot && !contrastAfterBot) || cueIsExplicitlyNegated(tokens, routeIndex)) {
        continue;
      }
      for (let roleIndex = routeIndex + 1; roleIndex < tokens.length; roleIndex += 1) {
        if (
          FUZZY_HUMAN_ROLE_TOKENS.has(tokens[roleIndex]!) &&
          humanRoleTrailingIsSafe(tokens.slice(roleIndex + 1))
        ) return true;
      }
    }
  }
  return false;
}

function rejectedBotThenRequestedHuman(text: string): boolean {
  const tokens = humanRequestTokens(text);
  for (let botIndex = 0; botIndex < tokens.length; botIndex += 1) {
    if (!["bot", "bots", "chatbot", "chatbots", "robot"].includes(tokens[botIndex]!)) continue;
    if (!tokens.slice(0, botIndex).some((token) => FUZZY_HUMAN_NEGATION_TOKENS.has(token))) {
      continue;
    }
    const afterBot = tokens.slice(botIndex + 1);
    const hasContrast = ["and", "but", "instead", "just"].includes(afterBot[0] ?? "") ||
      (
        ["i", "we"].includes(afterBot[0] ?? "") &&
        ["get", "need", "prefer", "want"].includes(afterBot[1] ?? "")
      );
    if (hasContrast && fuzzyHumanRequested(afterBot.join(" "))) return true;
  }
  return false;
}

function leadingNoThenRequestedHuman(text: string): boolean {
  const tokens = humanRequestTokens(text);
  return tokens[0] === "no" && tokens[1] === "i" && fuzzyHumanRequested(tokens.slice(1).join(" "));
}

function humanRequested(text: string): boolean {
  const input = text.trim();
  if (
    HUMAN_MENTION_QUESTION_PATTERN.test(input) ||
    HUMAN_META_QUESTION_PATTERN.test(input) ||
    HUMAN_THIRD_PARTY_QUESTION_PATTERN.test(input) ||
    META_REPORTED_HUMAN_PATTERN.test(input)
  ) return false;
  const reportedAcrossBoundary = REPORTED_HUMAN_REQUEST_ACROSS_BOUNDARY_PATTERN.exec(input);
  if (
    reportedAcrossBoundary !== null &&
    /[:,—–]|\s(?:-|\/)\s/u.test(reportedAcrossBoundary[0])
  ) {
    const remainder = input.slice(reportedAcrossBoundary.index + reportedAcrossBoundary[0].length);
    const laterSentence = /^[.!?\n]+\s*(.+)$/u.exec(remainder);
    if (laterSentence !== null) return humanRequested(laterSentence[1]!);
    const laterCommand = /^\s*[;,—–-]+\s*(?:and\s+)?(?:now\s+)?(.+)$/iu.exec(remainder);
    if (laterCommand !== null) return humanRequested(laterCommand[1]!);
    const contrast = /\b(?:but|however|instead)\b/iu.exec(remainder);
    return contrast === null
      ? false
      : humanRequested(remainder.slice(contrast.index + contrast[0].length));
  }
  const clauses = input
    .replace(/\bno\s*[,—–-]\s*(?:thanks|thank\s+you)\b/giu, "no thanks")
    .replace(/\bon\s+second\s+thought\s*[,—–-]\s*no\b/giu, "on second thought no")
    .replace(/\bwait\s*[,—–-]\s*no\b/giu, "wait no")
    .split(HUMAN_CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  let decision: boolean | null = null;
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
      const clause = clauses[clauseIndex]!;
      const hasPriorHumanReference = clauses.slice(0, clauseIndex).some((priorClause) =>
        humanRequestTokens(priorClause).some((token) => FUZZY_HUMAN_ROLE_TOKENS.has(token)),
      );
      if (hasPriorHumanReference && HUMAN_CURRENT_REVERSAL_PATTERN.test(clause)) {
        decision = true;
        continue;
      }
      if (HUMAN_RETRACTION_PATTERN.test(clause)) {
        decision = false;
        continue;
      }
      if (leadingNoThenRequestedHuman(clause)) {
        decision = true;
        continue;
      }
      if (
        HUMAN_MENTION_QUESTION_PATTERN.test(clause) ||
        HUMAN_META_QUESTION_PATTERN.test(clause) ||
        HUMAN_THIRD_PARTY_QUESTION_PATTERN.test(clause) ||
        HUMAN_CONDITIONAL_MENTION_PATTERN.test(clause) ||
        HUMAN_NON_SUPPORT_SERVICE_PATTERN.test(clause) ||
        HUMAN_NON_SUPPORT_CONTEXT_PATTERN.test(clause) ||
        humanRoleHasUnsupportedPurpose(clause) ||
        REPORTED_HUMAN_REQUEST_PATTERN.test(clause) ||
        HISTORICAL_HUMAN_REQUEST_PATTERN.test(clause) ||
        HISTORICAL_REPORTED_HUMAN_PATTERN.test(clause) ||
        EARLIER_REPORTED_HUMAN_PATTERN.test(clause) ||
        META_REPORTED_HUMAN_PATTERN.test(clause) ||
        HUMAN_REFUSAL_CONTEXT_PATTERN.test(clause)
      ) {
        decision = false;
        continue;
      }
      if (botRoutesToHuman(clause)) {
        decision = true;
        continue;
      }
      if (explicitlyPrefersBotOrRefusesHuman(clause)) {
        decision = false;
        continue;
      }
      if (
        HUMAN_INABILITY_PATTERN.test(clause) ||
        fuzzyHumanInabilityRequested(clause) ||
        rejectedBotThenRequestedHuman(clause)
      ) {
        decision = true;
        continue;
      }
      if (
        NEGATED_HUMAN_REQUEST_PATTERN.test(clause) ||
        fuzzyHumanClauseIsNegated(clause)
      ) {
        decision = false;
        continue;
      }
      if (
        HUMAN_ONLY_PATTERN.test(clause) ||
        HUMAN_ACTION_PATTERN.test(clause) ||
        HUMAN_WANT_PATTERN.test(clause) ||
        HUMAN_QUERY_PATTERN.test(clause) ||
        HUMAN_PREFERENCE_PATTERN.test(clause) ||
        HUMAN_ROLELESS_HANDOFF_PATTERN.test(clause) ||
        HUMAN_COLLOQUIAL_HANDOFF_PATTERN.test(clause) ||
        HUMAN_PASSIVE_HANDOFF_PATTERN.test(clause) ||
        HUMAN_DIRECT_ROUTE_PATTERN.test(clause) ||
        HUMAN_ANAPHORIC_HANDOFF_PATTERN.test(clause) ||
        FUZZY_ROLELESS_HANDOFF_PATTERN.test(clause) ||
        fuzzyHumanRequested(clause)
      ) {
        decision = true;
      }
    }
  return decision ?? false;
}

function safeMetadata(
  incoming: ZendeskInboundMessage,
  account: ZendeskAuthenticatedAccount,
  assistancePath: "auto" | "explicit_choices" | "unclear_fallback",
): Readonly<Record<string, WordlessJsonValue>> {
  return Object.freeze({
    ...(account.metadata ?? {}),
    zendesk_app_id: incoming.appId,
    zendesk_conversation_id: incoming.conversationId,
    zendesk_event_id: incoming.eventId,
    zendesk_message_id: incoming.messageId,
    zendesk_source_type: incoming.sourceType,
    zendesk_assistance_path: assistancePath,
  });
}

function choiceBelongsToMessage(
  value: ZendeskResolvedChoice,
  input: ZendeskInboundMessage,
): boolean {
  return (
    value.appId === input.appId &&
    value.conversationId === input.conversationId &&
    value.userId === input.userId &&
    value.selectionEventId === input.eventId &&
    /^sg_[0-9a-f]{32}$/u.test(value.suggestionId) &&
    IDENTIFIER_PATTERN.test(value.sourceMessageId) &&
    /^[A-Za-z0-9_-]{16}$/u.test(value.sourceMessageNonce) &&
    Number.isFinite(Date.parse(value.issuedAt)) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.parse(value.issuedAt) &&
    /^[a-z][a-z0-9_]{1,48}$/u.test(value.choiceId) &&
    (value.detectorId === null || /^[a-z][a-z0-9_]{1,48}$/u.test(value.detectorId)) &&
    typeof value.reply === "string" &&
    value.reply.length > 0 &&
    value.reply.length <= 240 &&
    (value.feedback === "confirmed" || value.feedback === "none" || value.feedback === "skip") &&
    (value.feedback !== "confirmed" || value.detectorId !== null) &&
    (value.feedback !== "none" || value.detectorId === null)
  );
}

async function resolveSelectedChoice(
  choiceStore: ZendeskChoiceStore,
  incoming: ZendeskInboundMessage,
  signingSecret: string,
  now: Date,
): Promise<ZendeskResolvedChoice | null> {
  if (
    incoming.payload === null ||
    !incoming.payload.startsWith("wl2.")
  ) {
    return null;
  }
  const parts = incoming.payload.split(".");
  if (parts.length !== 8) return null;
  const [
    version,
    suggestionId,
    choiceId,
    feedbackCode,
    issuedAtCode,
    expiresAtCode,
    sourceMessageNonce,
    providedSignature,
  ] = parts;
  if (
    version !== "wl2" ||
    suggestionId === undefined ||
    choiceId === undefined ||
    feedbackCode === undefined ||
    issuedAtCode === undefined ||
    expiresAtCode === undefined ||
    sourceMessageNonce === undefined ||
    providedSignature === undefined ||
    !/^sg_[0-9a-f]{32}$/u.test(suggestionId) ||
    !/^[a-z][a-z0-9_]{1,48}$/u.test(choiceId) ||
    !/^(?:c_[a-z][a-z0-9_]{1,48}|none|skip)$/u.test(feedbackCode) ||
    !/^[0-9a-z]{1,12}$/u.test(issuedAtCode) ||
    !/^[0-9a-z]{1,12}$/u.test(expiresAtCode) ||
    !/^[A-Za-z0-9_-]{16}$/u.test(sourceMessageNonce)
  ) {
    return null;
  }
  const issuedAtSeconds = Number.parseInt(issuedAtCode, 36);
  const expiresAtSeconds = Number.parseInt(expiresAtCode, 36);
  if (
    !Number.isSafeInteger(issuedAtSeconds) ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= issuedAtSeconds ||
    expiresAtSeconds - issuedAtSeconds > 24 * 60 * 60 ||
    Date.parse(incoming.receivedAt) < issuedAtSeconds * 1_000 ||
    Date.parse(incoming.receivedAt) > expiresAtSeconds * 1_000 ||
    now.getTime() > expiresAtSeconds * 1_000
  ) {
    return null;
  }
  const issuedAt = new Date(issuedAtSeconds * 1_000).toISOString();
  const expiresAt = new Date(expiresAtSeconds * 1_000).toISOString();
  const core = `${version}.${suggestionId}.${choiceId}.${feedbackCode}.${issuedAtCode}.${expiresAtCode}.${sourceMessageNonce}`;
  const expectedSignature = choiceSignature(incoming, core, signingSecret);
  const expectedBytes = Buffer.from(expectedSignature, "ascii");
  const providedBytes = Buffer.from(providedSignature, "ascii");
  if (
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    return null;
  }
  const detectorId = feedbackCode.startsWith("c_") ? feedbackCode.slice(2) : null;
  const feedback = feedbackCode === "none"
    ? "none" as const
    : feedbackCode === "skip"
      ? "skip" as const
      : "confirmed" as const;
  const storedValue = await choiceStore.resolve({
    appId: incoming.appId,
    conversationId: incoming.conversationId,
    userId: incoming.userId,
    payload: incoming.payload,
    selectionEventId: incoming.eventId,
    selectionReceivedAt: incoming.receivedAt,
    sourceMessageNonce,
    issuedAt,
    expiresAt,
  });
  if (storedValue === null) return null;
  if (
    !choiceBelongsToMessage(storedValue, incoming) ||
    storedValue.suggestionId !== suggestionId ||
    storedValue.choiceId !== choiceId ||
    storedValue.detectorId !== detectorId ||
    storedValue.feedback !== feedback ||
    storedValue.sourceMessageNonce !== sourceMessageNonce ||
    storedValue.issuedAt !== issuedAt ||
    storedValue.expiresAt !== expiresAt
  ) {
    throw new ZendeskIntegrationError("Choice store returned a mismatched selection.");
  }
  return storedValue;
}

function validateConfiguration(options: ZendeskMessagingAdapterOptions): void {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk adapter options must be an object.");
  }
  identifier(options.expectedAppId, "Expected Zendesk app id");
  identifier(options.expectedWebhookId, "Expected Zendesk webhook id");
  identifier(options.switchboardIntegrationId, "Zendesk switchboard integration id");
  if (options.underlyingIntegrationId !== undefined) {
    identifier(options.underlyingIntegrationId, "Zendesk underlying integration id");
  }
  if (options.humanSwitchboardIntegrationId !== undefined) {
    identifier(options.humanSwitchboardIntegrationId, "Zendesk human Switchboard integration id");
    if (options.humanSwitchboardIntegrationId === options.switchboardIntegrationId) {
      throw new ZendeskIntegrationError("Zendesk human integration must be different from Wordless.");
    }
  }
  if (
    typeof options.choiceSigningSecret !== "string" ||
    Buffer.byteLength(options.choiceSigningSecret, "utf8") < 32
  ) {
    throw new ZendeskIntegrationError("choiceSigningSecret must contain at least 32 bytes.");
  }
  if (
    !isRecord(options.chatbot) ||
    typeof options.chatbot.processMessage !== "function" ||
    typeof options.chatbot.recordConfirmation !== "function" ||
    typeof options.resolveAuthenticatedAccount !== "function"
  ) {
    throw new ZendeskIntegrationError("Zendesk adapter dependencies are invalid.");
  }
  if (
    !isRecord(options.choiceStore) ||
    typeof options.choiceStore.save !== "function" ||
    typeof options.choiceStore.resolve !== "function"
  ) {
    throw new ZendeskIntegrationError("Zendesk choiceStore is invalid.");
  }
  const choiceTtlMs = options.choiceTtlMs ?? DEFAULT_CHOICE_TTL_MS;
  if (
    !Number.isSafeInteger(choiceTtlMs) ||
    choiceTtlMs < 60_000 ||
    choiceTtlMs > 24 * 60 * 60 * 1_000
  ) {
    throw new ZendeskIntegrationError("choiceTtlMs must be between one minute and 24 hours.");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new ZendeskIntegrationError("Zendesk now must be a function.");
  }
  if (
    options.accountResolutionFailureMode !== undefined &&
    options.accountResolutionFailureMode !== "throw" &&
    options.accountResolutionFailureMode !== "pass_control"
  ) {
    throw new ZendeskIntegrationError("Zendesk account resolution failure mode is invalid.");
  }
  if (options.onAccountResolutionError !== undefined && typeof options.onAccountResolutionError !== "function") {
    throw new ZendeskIntegrationError("Zendesk account resolution error handler must be a function.");
  }
  if (options.onFeedbackError !== undefined && typeof options.onFeedbackError !== "function") {
    throw new ZendeskIntegrationError("Zendesk feedback error handler must be a function.");
  }
}

/**
 * Adapt Sunshine Conversations v2 webhook events to Wordless and return exact
 * Zendesk API operations. The caller remains responsible for authenticating the
 * HTTP request and atomically claiming each result's deduplicationKey.
 */
export function createZendeskMessagingAdapter(
  options: ZendeskMessagingAdapterOptions,
): ZendeskMessagingAdapter {
  validateConfiguration(options);
  const choiceTtlMs = options.choiceTtlMs ?? DEFAULT_CHOICE_TTL_MS;
  const now = (): Date => {
    const value = options.now?.() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ZendeskIntegrationError("Zendesk now returned an invalid date.");
    }
    return value;
  };

  async function processIncoming(
    incoming: ZendeskInboundMessage,
  ): Promise<ZendeskMessagingResult> {
    if (incoming.payload === ZENDESK_HUMAN_PAYLOAD) {
      return passControl(
        incoming,
        "human_requested",
        null,
        null,
        options.humanSwitchboardIntegrationId ?? null,
      );
    }
    if (incoming.contentType !== "text" || incoming.text === null) {
      return passControl(incoming, "unsupported_content");
    }
    if (humanRequested(incoming.text.trim())) {
      return passControl(
        incoming,
        "human_requested",
        null,
        null,
        options.humanSwitchboardIntegrationId ?? null,
      );
    }
    let account: ZendeskAuthenticatedAccount | null;
    try {
      account = await options.resolveAuthenticatedAccount(incoming);
    } catch (error) {
      if (options.accountResolutionFailureMode !== "pass_control") throw error;
      options.onAccountResolutionError?.(error, incoming);
      return passControl(incoming, "evidence_unavailable");
    }
    if (account === null) return passControl(incoming, "account_not_authenticated");
    validateAccount(account, incoming);
    const selectedChoice = await resolveSelectedChoice(
      options.choiceStore,
      incoming,
      options.choiceSigningSecret,
      now(),
    );
    if (selectedChoice !== null) {
      if (selectedChoice.feedback !== "skip") {
        try {
          const recording = options.chatbot.recordConfirmation({
            suggestionId: selectedChoice.suggestionId,
            selectedDetectorId: selectedChoice.detectorId,
            actor: "customer",
            decisionId: incoming.eventId,
          });
          void recording.catch((error: unknown) => options.onFeedbackError?.(error, incoming));
        } catch (error) {
          options.onFeedbackError?.(error, incoming);
        }
      }
      return passControl(
        incoming,
        "choice_selected",
        selectedChoice.suggestionId,
        selectedChoice,
      );
    }
    const explicitChoices = showChoicesRequested(incoming);
    const text = explicitChoices ? "" : incoming.text.trim();
    if (Array.from(text).length > MAX_TEXT_LENGTH) {
      return passControl(incoming, "message_too_long");
    }

    let turn: WordlessSupportChatTurn;
    try {
      turn = await options.chatbot.processMessage({
        messageId: incoming.messageId,
        customerId: account.customerId,
        text,
        sentAt: incoming.receivedAt,
        observedAt: account.observedAt,
        channel: "chat",
        evidence: account.evidence,
        metadata: safeMetadata(
          incoming,
          account,
          explicitChoices ? "explicit_choices" : "auto",
        ),
        ...(explicitChoices ? { showChoices: true } : {}),
      });

      // A low-confidence fragment is retried as an evidence-only composition aid.
      // Unrelated ordinary messages (`no_relevant_evidence`) still yield to the host bot.
      if (
        !explicitChoices &&
        turn.hostAction === "continue_host_bot" &&
        (turn.reason === "below_confidence_floor" || turn.reason === "insufficient_context")
      ) {
        turn = await options.chatbot.processMessage({
          messageId: `${incoming.messageId}:choices`,
          customerId: account.customerId,
          text: "",
          sentAt: incoming.receivedAt,
          observedAt: account.observedAt,
          channel: "chat",
          evidence: account.evidence,
          metadata: safeMetadata(incoming, account, "unclear_fallback"),
          showChoices: true,
        });
      }
    } catch (error) {
      if (!(error instanceof WordlessSdkError)) throw error;
      options.onWordlessError?.(error, incoming);
      return passControl(incoming, "wordless_unavailable");
    }

    if (turn.hostAction === "continue_host_bot") {
      return passControl(incoming, "wordless_yielded", turn.suggestionId);
    }
    const pending = pendingChoiceSet(
      incoming,
      turn,
      options.choiceSigningSecret,
      now(),
      choiceTtlMs,
    );
    if (pending !== null) {
      await options.choiceStore.save(pending);
    }
    return postMessage(incoming, turn, pending);
  }

  return Object.freeze({
    async processWebhook(value: unknown): Promise<readonly ZendeskMessagingResult[]> {
      const events = parseEnvelope(value, options.expectedAppId, options.expectedWebhookId);
      const results: ZendeskMessagingResult[] = [];
      for (const event of events) {
        if (event.type !== "conversation:message") {
          results.push(Object.freeze({
            kind: "ignored" as const,
            reason: "unsupported_event" as const,
            eventId: event.eventId,
          }));
          continue;
        }
        if (event.authorType !== "user" || event.inbound === null) {
          results.push(Object.freeze({
            kind: "ignored" as const,
            reason: "business_authored" as const,
            eventId: event.eventId,
          }));
          continue;
        }
        if (
          event.activeSwitchboardIntegrationId !== options.switchboardIntegrationId ||
          (options.underlyingIntegrationId !== undefined &&
            event.activeIntegrationId !== options.underlyingIntegrationId)
        ) {
          results.push(Object.freeze({
            kind: "ignored" as const,
            reason: "inactive_integration" as const,
            eventId: event.eventId,
          }));
          continue;
        }
        results.push(await processIncoming(event.inbound));
      }
      return Object.freeze(results);
    },
  });
}

/** A native Zendesk reply action that leaves free typing available. */
export function createZendeskCompositionHelpMessage(): ZendeskTextMessageBody {
  return Object.freeze({
    author: Object.freeze({ type: "business" as const }),
    content: Object.freeze({
      type: "text" as const,
      text: "Type anything you can. If finding the words is hard, choose this option.",
      blockChatInput: false as const,
      actions: Object.freeze([
        Object.freeze({
          type: "reply" as const,
          text: ZENDESK_SHOW_CHOICES_LABEL,
          payload: ZENDESK_SHOW_CHOICES_PAYLOAD,
        }),
        Object.freeze({
          type: "reply" as const,
          text: ZENDESK_HUMAN_LABEL,
          payload: ZENDESK_HUMAN_PAYLOAD,
        }),
      ]),
    }),
  });
}

export type ZendeskConversationsAuthentication =
  | {
      readonly type: "basic";
      readonly keyId: string;
      readonly keySecret: string;
      /** Set this when known so unsafe app-scoped `passControl("next")` can be rejected. */
      readonly scope?: "app" | "integration";
    }
  | {
      readonly type: "bearer";
      readonly token: string;
      /** Marketplace OAuth bearer tokens are integration-scoped. */
      readonly scope?: "app" | "integration";
      readonly marketplace?: {
        readonly name: string;
        readonly organizationId: string;
        readonly botId: string;
      };
    };

export interface ZendeskConversationsClientOptions {
  readonly subdomain: string;
  readonly authentication: ZendeskConversationsAuthentication;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ZendeskConversationsClient {
  execute(
    request: ZendeskApiRequest<
      ZendeskTextMessageBody | ZendeskPassControlBody | ZendeskReleaseControlBody
    >,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

function authenticationHeaders(
  authentication: ZendeskConversationsAuthentication,
): Readonly<Record<string, string>> {
  if (!isRecord(authentication) || (authentication.type !== "basic" && authentication.type !== "bearer")) {
    throw new ZendeskIntegrationError("Zendesk authentication is invalid.");
  }
  if (authentication.type === "basic") {
    if (
      typeof authentication.keyId !== "string" ||
      typeof authentication.keySecret !== "string" ||
      authentication.keyId.length === 0 ||
      authentication.keySecret.length === 0 ||
      /[\r\n]/u.test(authentication.keyId) ||
      /[\r\n]/u.test(authentication.keySecret)
    ) {
      throw new ZendeskIntegrationError("Zendesk basic credentials are invalid.");
    }
    if (
      authentication.scope !== undefined &&
      authentication.scope !== "app" &&
      authentication.scope !== "integration"
    ) {
      throw new ZendeskIntegrationError("Zendesk credential scope is invalid.");
    }
    return {
      authorization: `Basic ${Buffer.from(
        `${authentication.keyId}:${authentication.keySecret}`,
        "utf8",
      ).toString("base64")}`,
    };
  }
  if (
    typeof authentication.token !== "string" ||
    authentication.token.length === 0 ||
    /[\r\n]/u.test(authentication.token)
  ) {
    throw new ZendeskIntegrationError("Zendesk bearer token is invalid.");
  }
  if (
    authentication.scope !== undefined &&
    authentication.scope !== "app" &&
    authentication.scope !== "integration"
  ) {
    throw new ZendeskIntegrationError("Zendesk credential scope is invalid.");
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${authentication.token}`,
  };
  if (authentication.marketplace !== undefined) {
    const fields = authentication.marketplace;
    if (
      typeof fields.name !== "string" ||
      typeof fields.organizationId !== "string" ||
      typeof fields.botId !== "string" ||
      fields.name.length === 0 ||
      fields.organizationId.length === 0 ||
      fields.botId.length === 0 ||
      /[\r\n]/u.test(`${fields.name}${fields.organizationId}${fields.botId}`)
    ) {
      throw new ZendeskIntegrationError("Zendesk Marketplace headers are invalid.");
    }
    headers["x-zendesk-marketplace-name"] = fields.name;
    headers["x-zendesk-marketplace-organization-id"] = fields.organizationId;
    headers["x-zendesk-marketplace-bot-id"] = fields.botId;
  }
  return headers;
}

/** Minimal server-only client for executing the adapter's exact v2 API requests. */
export function createZendeskConversationsClient(
  options: ZendeskConversationsClientOptions,
): ZendeskConversationsClient {
  if (!isRecord(options) || !SUBDOMAIN_PATTERN.test(options.subdomain)) {
    throw new ZendeskIntegrationError("Zendesk subdomain is invalid.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ZendeskIntegrationError("A fetch implementation is required.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new ZendeskIntegrationError("Zendesk timeoutMs must be between 100 and 60000.");
  }
  const authHeaders = authenticationHeaders(options.authentication);
  const marketplace = options.authentication.type === "bearer"
    ? options.authentication.marketplace
    : undefined;
  const credentialScope = marketplace !== undefined
    ? "integration" as const
    : options.authentication.scope;
  if (
    marketplace !== undefined &&
    options.authentication.scope === "app"
  ) {
    throw new ZendeskIntegrationError(
      "Zendesk Marketplace OAuth credentials are integration-scoped, not app-scoped.",
    );
  }
  const origin = `https://${options.subdomain}.zendesk.com`;

  return Object.freeze({
    async execute(
      request: ZendeskApiRequest<
        ZendeskTextMessageBody | ZendeskPassControlBody | ZendeskReleaseControlBody
      >,
      executeOptions?: { readonly signal?: AbortSignal },
    ): Promise<void> {
      if (
        !isRecord(request) ||
        request.method !== "POST" ||
        typeof request.path !== "string" ||
        !/^\/sc\/v2\/apps\/[A-Za-z0-9._%:-]+\/conversations\/[A-Za-z0-9._%:-]+\/(?:messages|passControl|releaseControl)$/u.test(
          request.path,
        )
      ) {
        throw new ZendeskIntegrationError("Zendesk API request is invalid.");
      }
      if (request.path.endsWith("/messages")) {
        if (!isRecord(request.body)) {
          throw new ZendeskIntegrationError("Zendesk message body is invalid.");
        }
        validateFlatMetadata(
          request.body.metadata as ZendeskMessageMetadata | undefined,
          "Zendesk message metadata",
        );
      }
      if (request.path.endsWith("/passControl")) {
        if (
          !isRecord(request.body) ||
          typeof request.body.switchboardIntegration !== "string" ||
          (request.body.switchboardIntegration !== "next" &&
            !IDENTIFIER_PATTERN.test(request.body.switchboardIntegration))
        ) {
          throw new ZendeskIntegrationError("Zendesk pass-control body is invalid.");
        }
        validateFlatMetadata(
          request.body.metadata as ZendeskSwitchboardMetadata | undefined,
          "Zendesk Switchboard metadata",
        );
      }
      if (request.path.endsWith("/releaseControl")) {
        if (!isRecord(request.body)) {
          throw new ZendeskIntegrationError("Zendesk release-control body is invalid.");
        }
        validateFlatMetadata(
          request.body.metadata as ZendeskSwitchboardMetadata | undefined,
          "Zendesk Switchboard metadata",
        );
      }
      if (
        request.path.endsWith("/passControl") &&
        isRecord(request.body) &&
        request.body.switchboardIntegration === "next" &&
        credentialScope !== "integration"
      ) {
        throw new ZendeskIntegrationError(
          'The "next" Switchboard target requires an explicitly integration-scoped credential; app or unknown scope is not safely idempotent.',
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = (): void => controller.abort();
      executeOptions?.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetchImplementation(`${origin}${request.path}`, {
          method: "POST",
          redirect: "error",
          headers: {
            ...authHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(request.body),
          signal: controller.signal,
        });
        if (!response.ok) throw new ZendeskApiError(response.status);
      } catch (error) {
        if (error instanceof ZendeskApiError) throw error;
        throw new ZendeskIntegrationError("Zendesk Conversations API request failed.", {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
        executeOptions?.signal?.removeEventListener("abort", abort);
      }
    },
  });
}
