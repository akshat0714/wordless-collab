# Wordless Evidence Sidecar

## The product a company can buy now

Wordless is a read-only assistance layer for a normal customer-support chatbot
or agent UI. The company's backend sends each customer message together with
verified account, billing, order, or access state. Wordless returns an explicit
instruction to show a grounded reply, show short clarification choices, or
continue the company's existing bot unchanged.

The company renders the result inside its existing interface. A person confirms
the interpretation before the company takes any action. Wordless never issues a
refund, changes an order, unlocks an account, sends a customer message, or
updates a ticket.

This makes the live product additive. Companies keep their current chatbot,
knowledge base, escalation rules, and support UI. Wordless takes only the turns
where evidence-first assistance is useful; it does not need to cover every
support topic to create value.

The visible interaction stays intentionally small:

1. The customer sends an unclear or incomplete message.
2. Wordless checks the read-only evidence already available to the company.
3. The existing interface shows a short clarification card.
4. A customer or support agent confirms one option or chooses none.
5. Wordless records only that review outcome for measurement and improvement.

For a normal, well-supported question, Wordless may return a directly entailed
read-only answer. For an unrelated or unsupported message, it returns
`continue_host_bot`, and the company's ordinary workflow proceeds normally.

Every customer also gets a visible **I don’t know what to say** action beside the text
box. It can be used with a fragment or no typed words at all. This is a
universal composition aid: Wordless does not detect, diagnose, score, or store
an aphasia label.

## Concrete live use cases

| Message | Read-only state | Result inside the existing chatbot |
|---|---|---|
| “money one twice” | Two succeeded charges for the same amount/order | Ask the customer to confirm duplicate-charge help or choose something else. |
| “still not come” | Delayed, late, missing, or overdue shipment | Offer a delivery-help clarification before the host starts its resolution flow. |
| “order wrong thing” | Ordered and delivered SKUs differ | Offer wrong-item help, citing the exact request evidence indexes. |
| “can't get in” | Locked/blocked account and failed attempts | Offer account-access help; never unlock the account automatically. |
| “where package” | Current state directly entails a safe status | Return a grounded, read-only message. |
| Notification-settings question | No relevant supported evidence | Continue the existing host chatbot with no competing Wordless message. |
| Customer asks for composition help with empty text | Any state, including no evidence | Offer evidence-backed choices when available, otherwise neutral navigation choices. |

## Why this is different

Most support systems start with the customer's wording and try to retrieve the
nearest intent. Wordless starts with what is verifiably true in the account and
uses the customer's wording to rank only those supported possibilities.

That creates three useful behaviors in one integration:

- **Agent Assist** — show the evidence-backed interpretation beside an agent's
  normal reply composer.
- **Customer Clarify** — show the same choices as buttons inside an existing
  chatbot when the message is ambiguous.
- **Historical Audit** — replay resolved conversations to find where the
  recorded resolution disagreed with the available state.

The live confirmation stream also creates a new labeled dataset:
`account state + difficult wording + human-confirmed intent`. It is produced as
a by-product of normal review, without allowing the model to act autonomously.

## Controlled paid pilot

The current commercial offer should be described as a **single-tenant,
controlled paid pilot**, deployed in a customer-controlled environment or a
dedicated Wordless environment behind the customer's TLS gateway.

Included pilot scope:

- one backend-to-backend API integration;
- one existing agent interface or chatbot surface;
- the framework-neutral `/v1/chat/assist` route, including normal-bot
  continuation and the universal no-words composition path;
- duplicate-charge, late-delivery, wrong-item, and account-lock evidence;
- the `@wordless/sdk/server` client for signed requests and idempotent retries;
- `createSupportChatbotAdapter()` for message processing, host-turn mapping, and
  human confirmation feedback without a vendor-specific dependency;
- the credential-free `@wordless/sdk` confirmation cards for the browser;
- explicit abstention and human confirmation;
- tenant-scoped persistence, event replay, and feedback records;
- an initial historical audit when a compatible export is available.

The pilot should start with shadow or agent-assist mode. Customer-facing
clarification can be enabled after the buyer reviews its own validation sample
and approves a frozen confidence threshold.

## Integration boundary

```text
Customer UI or chatbot
        |
        | any message, composition-help action, or human selection (no Wordless secret)
        v
Company backend or bot orchestrator
        |
        | signed request + read-only evidence
        v
Wordless Evidence Sidecar
        |
        | grounded reply, choices, or continue-host-bot + evidence indexes
        v
Company backend renders the result in its existing UI
```

Wordless service credentials belong only in the company's backend. The API
returns `input_index` for cited evidence so the company can connect a suggestion
to its own in-memory request record without Wordless echoing or persisting the
company's raw identifiers in the response.

## Pilot measurement contract

Every reported rate must include its numerator, denominator, sample size, time
window, and method. Useful pilot measures include:

- **Offer rate:** conversations with at least one returned candidate divided by
  eligible conversations evaluated.
- **Confirmation rate:** offered suggestions confirmed by a person divided by
  offered suggestions receiving a recorded review.
- **None rate:** recorded `none` outcomes divided by offered suggestions
  receiving a recorded review.
- **Abstention rate:** requests returning no candidate divided by eligible
  requests evaluated.
- **Resolution correctness:** disagreements verified by a human reviewer divided
  by replay cases that received human review.

No fixture, benchmark, or unreviewed pilot result should be presented as a
production accuracy or fairness claim.

## Boundaries before a broad production rollout

The current service is a single-process, single-node pilot. A multi-customer or
high-availability rollout additionally requires a managed transactional
database with tenant isolation, distributed idempotency and rate limiting,
durable jobs, authenticated human sessions, managed secrets, centralized
observability, retention and deletion controls, capacity testing, and a
deployment-specific privacy and security review.

Those requirements do not prevent a controlled paid pilot. They define the
scope that must remain explicit in the pilot agreement and architecture.
