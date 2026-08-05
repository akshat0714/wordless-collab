import type { LiveSuggestionInput } from "@/lib/live-suggestion-schema";

export function buildLiveDemoProductRequest(input: LiveSuggestionInput): string {
  const observedAtMs = Date.parse(input.observed_at);
  const occurredAt = (minutesAgo: number): string =>
    new Date(observedAtMs - minutesAgo * 60_000).toISOString();
  return JSON.stringify({
    schema_version: 1,
    external_event_id: `console:${input.request_id}`,
    observed_at: input.observed_at,
    channel: "chat",
    customer_external_id: "console-demo-customer",
    utterance: {
      sent_at: input.observed_at,
      text: input.utterance,
    },
    evidence: [
      {
        type: "charge",
        ref: `charge:${input.request_id}:a`,
        order_ref: "order:console-demo-8421",
        occurred_at: occurredAt(6),
        amount: "84.00",
        currency: "USD",
        status: "succeeded",
      },
      {
        type: "charge",
        ref: `charge:${input.request_id}:b`,
        order_ref: "order:console-demo-8421",
        occurred_at: occurredAt(1),
        amount: "84.00",
        currency: "USD",
        status: "succeeded",
      },
    ],
    source_system: "wordless_console",
    metadata: { console_live_demo: true },
  });
}
