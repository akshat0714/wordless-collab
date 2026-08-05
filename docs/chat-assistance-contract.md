# Chat assistance contract

Wordless augments an existing customer-support chatbot. It does not replace the
host's knowledge base, ticket workflow, retrieval system, or action layer.

`POST /v1/chat/assist` accepts one customer message and a bounded snapshot of
typed customer-system evidence. The endpoint uses the same tenant-scoped Bearer
credential, exact-body HMAC signature, idempotency key, request limits, PII
redaction, and ephemeral embedding boundary as `POST /v1/suggestions`.

The host follows `integration.host_action` before rendering anything:

- `show_wordless` means render the specified `choices` or `message` after the
  host's required review step.
- `continue_host_bot` means ignore the empty Wordless message and let the
  company's existing chatbot handle the original customer turn.

Wordless can currently support four confirmed evidence cases:

- two successful matching charges recorded within one hour;
- a shipment marked late, delayed, overdue, missing, or lost;
- a delivered SKU that differs from the ordered SKU;
- an account recorded as locked after at least three failed attempts.

Each detected case returns up to two short evidence-backed options plus
**Something else**. It never presents a detector as a confirmed customer
intent. The first option remains the response's primary `detector_id` and
`evidence`; every supported choice also carries its own detector and evidence.
The selected option can be recorded through the existing `links.feedback`
endpoint using the returned `suggestion_id` and the choice's `detector_id`.

`assistance_mode: "show_choices"` is an explicit composition preference. It
allows an empty message and ranks confirmed state hypotheses without semantic
message evidence. The response marks that path as
`selection_basis: "explicit_evidence_choices"`. This setting neither diagnoses
nor stores a disability label. When no evidence-backed problem is available,
Wordless returns three unbacked navigation choices whose selections belong to
the host chatbot, not detector feedback.

In `auto` mode, Wordless also recognizes a conservative low-composition path.
It compares the redacted message with each short concept prototype separately
and may try a bounded, detector-local spelling repair for retrieval only. For
example, `mney twcie`, `pakg no com`, `thing box difrent`, and `cant in acount`
can retrieve the matching concept when current evidence independently supports
it. When that repaired match is strong and clearly separated from the other
available concepts, Wordless preserves the message-ranked winner and reports
`selection_basis: "evidence_and_message"`.

Every non-contextual `auto` candidate must also clear a 0.40 concept-cosine
support floor independently of the tenant's aggregate ranking threshold. This
second gate prevents recency and evidence strength from pushing a semantically
unrelated adverse fact over the operating threshold. The cosine is a guardrail,
not a probability.

A separate character-noise gate routes genuinely unresolved text such as
`asdf qqq`, while vague anaphora such as `need it agin` can ask the same context
path for help. Only those unresolved high-noise or deliberately vague turns are
ranked from evidence alone and report
`selection_basis: "contextual_evidence_choices"`. The user sees nonjudgmental
copy such as “You don’t need the exact words.” A repair is never shown as the
customer's text, persisted as their words, or used to create an unsupported
detector match. Durable completion events distinguish repaired-message ranking
from contextual evidence-only ranking.

Clear unrelated text still abstains to `continue_host_bot`. Greetings, receipt
requests, and store-hours questions do not become an adverse account
interpretation merely because adverse state exists. A high-noise fallback is a
review-required question, never an asserted interpretation or automatic action.

An integration may supply up to three recent, already-authorized customer turns
in `metadata.wordless_recent_customer_messages`. Those strings cross the same
mandatory redaction boundary and are bounded to 500 characters each before
concept retrieval. This allows a short continuation such as “it” to use recent
conversation context without changing the v1 request shape.

A `grounded_reply` is limited to a directly entailed current fact, such as a
shipment recorded as delivered/in transit, one completed charge, a matching
fulfilled item, or active account access. Relevance checks use narrow support
terms; an unrelated or unsupported message returns `continue_host_bot` instead
of a fabricated answer.

## Boundaries

- The API is read-only with respect to customer systems. It does not refund,
  unlock, replace, cancel, modify, or send anything.
- Every visible Wordless result has `review_required: true`; the integrating
  company owns the review and final send.
- The four detectors and healthy-state templates are not a general support
  knowledge base. Unsupported intents intentionally continue to the host bot;
  Zendesk or another host remains responsible for its FAQ, ticket, and action
  workflows.
- Scores are ranking values, not probabilities. Production tenants must set a
  threshold evaluated on their own labeled traffic.
- SQLite is a single-node controlled-pilot store. Multi-instance deployment
  still requires an appropriate tenant-isolated transactional backend.
- English copy is the only shipped language in this version. Localization and
  accessibility testing with intended users are required before broader use.
