import type { SupportScenarioId } from "@/lib/support-chat-schema";

export type SupportScenario = {
  id: SupportScenarioId;
  label: string;
  shortLabel: string;
  starter: string;
  context: string;
  confirmedReply: string;
};

export const supportScenarios: readonly SupportScenario[] = [
  {
    id: "full_account",
    label: "Open account context",
    shortLabel: "All evidence",
    starter: "",
    context: "Charges, delivery, item, and sign-in signals are all available",
    confirmedReply:
      "The selected meaning is supported by synthetic records. This demo made no account change. A host chatbot could now continue its normal workflow.",
  },
  {
    id: "duplicate_charge",
    label: "Charged twice",
    shortLabel: "Billing",
    starter: "Money went out two times. Same order.",
    context: "Two $84 charges for one order",
    confirmedReply:
      "The synthetic records show two successful $84 charges for the same order. This demo made no refund or account change. A host chatbot could now offer billing review.",
  },
  {
    id: "late_delivery",
    label: "Delivery is late",
    shortLabel: "Delivery",
    starter: "Package not here. It should be here.",
    context: "One order is past its delivery date",
    confirmedReply:
      "The synthetic shipment status is late, and its expected delivery date has passed. This demo made no order change. A host chatbot could now offer delivery support.",
  },
  {
    id: "wrong_item",
    label: "Wrong item arrived",
    shortLabel: "An item",
    starter: "The thing in the box is not what I picked.",
    context: "The delivered item differs from the order",
    confirmedReply:
      "The synthetic records show that the delivered item does not match the order. This demo created no return or replacement. A host chatbot could now offer return options.",
  },
  {
    id: "account_locked",
    label: "Cannot sign in",
    shortLabel: "Signing in",
    starter: "Can't get in. It stops me.",
    context: "The account status is locked",
    confirmedReply:
      "The synthetic record shows a locked account after four failed sign-in attempts. This demo did not unlock or change the account. A host chatbot could now offer recovery steps.",
  },
] as const;

export function supportScenario(id: SupportScenarioId): SupportScenario {
  const scenario = supportScenarios.find((item) => item.id === id);
  if (!scenario) throw new Error("Unknown support scenario");
  return scenario;
}

const confirmedReplies: Readonly<Record<string, string>> = {
  duplicate_charge: supportScenario("duplicate_charge").confirmedReply,
  late_delivery: supportScenario("late_delivery").confirmedReply,
  wrong_item: supportScenario("wrong_item").confirmedReply,
  account_lock: supportScenario("account_locked").confirmedReply,
};

export function supportConfirmationReply(detectorId: string): string {
  return confirmedReplies[detectorId] ?? supportScenario("full_account").confirmedReply;
}

export const noneOfTheseReply =
  "That’s okay. Is this about billing, delivery, an item, or signing in? You can also ask for a person.";

export function navigationReply(choiceId: string): string {
  if (choiceId === "payment_help") {
    return "Okay. Is the payment missing, duplicated, or declined? You can also ask for a person.";
  }
  if (choiceId === "delivery_or_item") {
    return "Okay. Is the delivery late, or is there a problem with the item?";
  }
  if (choiceId === "account_access") {
    return "Okay. Are you locked out, or do you need to change your password?";
  }
  return noneOfTheseReply;
}
