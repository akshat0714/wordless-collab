import {
  createSupportChatbotAdapter,
  createWordlessClient,
  type WordlessEvidence,
  type WordlessJsonValue,
} from "@wordless/sdk/server";

const wordless = createSupportChatbotAdapter({
  client: createWordlessClient({
    baseUrl: process.env.WORDLESS_BASE_URL ?? "",
    apiKey: process.env.WORDLESS_API_KEY ?? "",
    signingSecret: process.env.WORDLESS_SIGNING_SECRET ?? "",
  }),
  sourceSystem: "company-support-bot",
});

interface HostBody {
  messageId: string;
  customerId: string;
  text: string;
  receivedAt: string;
  showChoices?: boolean;
}

function isHostBody(value: unknown): value is HostBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.messageId === "string" &&
    typeof body.customerId === "string" &&
    typeof body.text === "string" &&
    typeof body.receivedAt === "string" &&
    (body.showChoices === undefined || typeof body.showChoices === "boolean")
  );
}

async function loadEvidenceFromCompanySystems(
  _customerId: string,
): Promise<readonly WordlessEvidence[]> {
  // Read billing, order, shipment, fulfillment, and account state here.
  return [];
}

export async function postSupportMessage(request: Request): Promise<Response> {
  const value: unknown = await request.json();
  if (!isHostBody(value)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const evidence = await loadEvidenceFromCompanySystems(value.customerId);
  const turn = await wordless.processMessage({
    messageId: value.messageId,
    customerId: value.customerId,
    text: value.text,
    sentAt: value.receivedAt,
    evidence,
    metadata: { integration: "standard-http" } satisfies Record<string, WordlessJsonValue>,
    ...(value.showChoices === undefined ? {} : { showChoices: value.showChoices }),
  }, { signal: request.signal });
  return Response.json(turn);
}

export async function postSupportConfirmation(request: Request): Promise<Response> {
  const value = await request.json() as {
    suggestionId?: unknown;
    detectorId?: unknown;
    decisionId?: unknown;
  };
  if (
    typeof value.suggestionId !== "string" ||
    (value.detectorId !== null && typeof value.detectorId !== "string") ||
    typeof value.decisionId !== "string"
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const feedback = await wordless.recordConfirmation({
    suggestionId: value.suggestionId,
    selectedDetectorId: value.detectorId,
    actor: "customer",
    decisionId: value.decisionId,
  }, { signal: request.signal });
  return Response.json(feedback);
}
