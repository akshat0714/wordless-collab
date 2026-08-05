import { expect, it } from "vitest";

import { parseQuarantineCommand } from "../src/quarantine-command.js";

const outboxId = "123e4567-e89b-42d3-a456-426614174000";

it("requires evidence-specific operator confirmation before reconciliation", () => {
  const base = [
    "resolve", "--installation", "acme", "--conversation", "conversation-1",
    "--outbox", outboxId, "--resolution", "retry",
  ];
  expect(() => parseQuarantineCommand(base)).toThrow(/verified-absent-safe-to-retry/u);
  expect(parseQuarantineCommand([...base, "--confirmation", "verified-absent-safe-to-retry"]))
    .toEqual({
      command: "resolve",
      installationId: "acme",
      conversationId: "conversation-1",
      outboxId,
      resolution: "retry",
    });
});

it("lists only by validated tenant and conversation identifiers", () => {
  expect(parseQuarantineCommand(["list", "--installation", "acme", "--conversation", "conversation-1"]))
    .toEqual({ command: "list", installationId: "acme", conversationId: "conversation-1" });
  expect(() => parseQuarantineCommand(["list", "--conversation", "bad/value"]))
    .toThrow(/--conversation is invalid/u);
});
