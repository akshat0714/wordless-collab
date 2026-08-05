import type { SupportChatRequest } from "@/lib/support-chat-schema";

type JsonEvidence = Record<string, string | number | null>;

function scenarioEvidence(input: SupportChatRequest): JsonEvidence[] {
  const observedAt = Date.parse(input.observed_at);
  const ago = (minutes: number): string => new Date(observedAt - minutes * 60_000).toISOString();
  const requestSuffix = input.request_id.replaceAll("-", "");

  const duplicateCharge: JsonEvidence[] = [
    {
      type: "charge",
      ref: `charge:${requestSuffix}:a`,
      order_ref: "order:demo:8421",
      occurred_at: ago(6),
      amount: "84.00",
      currency: "USD",
      status: "succeeded",
    },
    {
      type: "charge",
      ref: `charge:${requestSuffix}:b`,
      order_ref: "order:demo:8421",
      occurred_at: ago(1),
      amount: "84.00",
      currency: "USD",
      status: "succeeded",
    },
  ];
  const lateDelivery: JsonEvidence[] = [
    {
      type: "shipment",
      ref: `shipment:${requestSuffix}`,
      order_ref: "order:demo:1934",
      occurred_at: ago(2 * 24 * 60),
      status: "late",
      expected_delivery_at: ago(24 * 60),
    },
  ];
  const wrongItem: JsonEvidence[] = [
    {
      type: "fulfillment",
      ref: `fulfillment:${requestSuffix}`,
      order_ref: "order:demo:5518",
      occurred_at: ago(90),
      ordered_sku: "headphones:black",
      delivered_sku: "headphones:blue",
      status: "wrong_item",
    },
  ];
  const accountLocked: JsonEvidence[] = [
    {
      type: "account_access",
      ref: `access:${requestSuffix}`,
      account_ref: "account:demo:2048",
      occurred_at: ago(2),
      status: "locked",
      failed_attempts: 4,
    },
  ];

  if (input.scenario_id === "full_account") {
    return [...duplicateCharge, ...lateDelivery, ...wrongItem, ...accountLocked];
  }
  if (input.scenario_id === "duplicate_charge") return duplicateCharge;
  if (input.scenario_id === "late_delivery") return lateDelivery;
  if (input.scenario_id === "wrong_item") return wrongItem;
  return accountLocked;
}

export function supportAssistEvidenceCount(
  input: Pick<SupportChatRequest, "scenario_id">,
): number {
  if (input.scenario_id === "full_account") return 5;
  return input.scenario_id === "duplicate_charge" ? 2 : 1;
}

export function buildSupportAssistRequest(input: SupportChatRequest): string {
  const evidence = scenarioEvidence(input);
  if (evidence.length !== supportAssistEvidenceCount(input)) {
    throw new Error("Synthetic scenario evidence count is inconsistent");
  }
  return JSON.stringify({
    schema_version: 1,
    external_event_id: `console-chat:${input.request_id}`,
    observed_at: input.observed_at,
    channel: "chat",
    customer_external_id: `console-demo:${input.conversation_id}`,
    message: {
      sent_at: input.observed_at,
      text: input.message,
    },
    assistance_mode: input.action === "show_choices" ? "show_choices" : "auto",
    evidence,
    source_system: "wordless_console",
    metadata: {
      console_chat_demo: true,
      scenario_id: input.scenario_id,
      synthetic: true,
    },
  });
}
