# Wordless support chatbot

Wordless is a normal customer-support chatbot with an evidence-first
communication aid built into the conversation. It does not require a customer
to write a complete sentence, and it does not diagnose or label anyone.

The aid is designed for word-finding and composition barriers that people with
aphasia may experience, while remaining a universal option for anyone who
wants shorter choices. It is an accessibility interaction pattern, not a
clinical test, diagnosis, or treatment.

The buyer keeps its existing chatbot, knowledge base, escalation rules, and
customer-system actions. Wordless runs before the normal bot response:

1. The buyer's backend receives a customer message and reads current account
   state.
2. Wordless checks whether that state supports a small number of likely needs.
3. If it does, the chat shows short confirmation choices. If it does not, the
   buyer's normal chatbot continues unchanged.
4. The customer confirms a choice, selects none, or asks for a person.
5. The buyer's bot continues its normal support workflow. Wordless itself never
   refunds, edits an order, unlocks an account, or sends an unreviewed action.

## Actual pilot use cases

| Use case | A short customer message can be | Required current evidence | Chat behavior |
|---|---|---|---|
| Duplicate charge | “money twice” | Two successful charges for the same amount and order within one hour | Ask whether the customer means the duplicate charge, cite the two records, then offer the buyer's billing-review flow after confirmation. |
| Late delivery | “still not come” | A shipment is late, delayed, missing, lost, or past its expected date without delivery | Ask whether the customer means the overdue delivery, then continue to the buyer's tracking or shipping-support flow. |
| Wrong item | “wrong thing in box” | The delivered SKU differs from the ordered SKU, or fulfillment is explicitly marked wrong | Ask whether the wrong item arrived, then continue to the buyer's exchange or agent flow. |
| Account locked | “cannot get in” | The account is locked or blocked after at least three failed attempts | Ask whether sign-in is blocked, then continue to the buyer's verified recovery flow. |

The concept retriever also handles bounded severe-typo forms such as `mney
twcie`, `pakg no com`, `thing box difrent`, and `cant in acount`. It embeds each
short intent prototype separately and adds a detector-local repaired query only
when spelling similarity is unambiguous. Current account evidence remains the
gate: wording alone never creates a case.

These cases are evidence-backed because the buyer supplies the relevant state at
the time of the message. A message by itself never creates a detector match.

## Normal chatbot behavior

Ordinary questions still belong to the buyer's normal bot. Greetings, receipt
requests, return-policy questions, store hours, and human-agent requests should
continue through the buyer's existing retrieval, workflow, or handoff logic.

For those messages, Wordless returns an explicit `continue_host_bot` directive
instead of fabricating an answer. The local demo includes a small deterministic
FAQ layer only to make the complete conversation visible; a company replaces
that layer with its existing bot.

## Low-composition support

Every chat surface can expose a universal **I don’t know what to say** action,
mapped to the API's `show_choices` mode. It is available to everyone and carries
no disability label. A customer may use it with an empty message when producing
words is difficult.

In that mode Wordless derives evidence-backed choices only from confirmed
detectors and current evidence. The response records
`explicit_evidence_choices` as its selection basis so it cannot be confused
with a semantically ranked answer. If no detector is supported, it shows three
neutral navigation choices with no detector ID or evidence claim.

A severe typo that resolves strongly and unambiguously keeps its message-ranked
concept first and reports `evidence_and_message`. Evidence-only ranking is
entered automatically only for unresolved high-noise text such as `asdf qqq`
or a vague phrase such as “help” or `need it agin`. That path is separately
auditable as `contextual_evidence_choices`; clear unrelated messages continue
to the normal bot. Both evidence-only paths can show the two highest-ranked
supported options plus **Something else**, never more than three choices total.

For ordinary `auto` messages, a candidate must independently reach 0.40 concept
cosine as well as the tenant's total-score threshold. This prevents strong,
recent account evidence from hijacking clear unrelated requests such as a
receipt, mailing address, store hours, or ordering another product.

The interface follows these rules:

- choices use short concrete labels and native buttons;
- no more than three choices appear;
- **None of these** and a human-support path remain available;
- the user never has to repeat information already present in account state;
- focus, status announcements, contrast, target size, and reduced motion remain
  accessible;
- the product never infers or stores an aphasia diagnosis.

## Integration contract

The company calls `POST /v1/chat/assist` from its backend with one arbitrary
message, a channel, current typed evidence, and `assistance_mode` set to `auto`
or `show_choices`.

For a continuing conversation, the backend may also place the three most recent
customer turns in `metadata.wordless_recent_customer_messages`. This is useful
for Zendesk Messaging webhooks: map read-only ticket/user state into the typed
evidence array, copy only recent public customer comments into that metadata
field, call Wordless server-to-server, and follow `integration.host_action`.
Wordless credentials never belong in a Zendesk browser widget.

The response has one of three outcomes:

- `clarification_choices` — render 2–3 choices with one or two
  evidence-backed options and one safe alternative;
- `grounded_reply` — render a read-only statement directly supported by current
  state;
- `clarifying_fallback` — render a bounded clarification only when useful.

The nested integration directive is decisive:

- `show_wordless` means render the returned choices or message;
- `continue_host_bot` means call the company's existing chatbot normally.

The private `@wordless/sdk/server` package handles signatures, idempotency,
timeouts, bounded responses, strict runtime validation, and host-turn mapping.
The returned prompt and choices are plain data that a host can render with
React, Vue, Angular, native web components, a mobile shell, or its own UI;
Wordless does not require a framework.

“Works with any integration” means the protocol and UI helpers are
vendor-neutral. Each buyer must still map its billing, shipment, fulfillment,
and account-access records into the documented evidence contract. Wordless does
not claim an automatic connector to every customer system.

## Commercial boundary

The current offer is a controlled, single-tenant paid pilot for one existing
chatbot and one or more of the four evidence-backed use cases. The buyer starts
in shadow or agent-assist mode, evaluates its own confirmation and abstention
sample, and approves a versioned threshold before enabling customer-facing
clarification.

A broader production rollout still requires managed multi-node persistence,
distributed rate limits and idempotency, authenticated human sessions, managed
secrets, centralized observability, retention and deletion controls, capacity
testing, and a deployment-specific privacy and security review.
