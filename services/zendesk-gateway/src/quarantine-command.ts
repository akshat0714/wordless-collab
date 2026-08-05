const INSTALLATION = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type QuarantineCommand =
  | { readonly command: "list"; readonly installationId?: string; readonly conversationId?: string }
  | {
      readonly command: "resolve";
      readonly installationId: string;
      readonly conversationId: string;
      readonly outboxId: string;
      readonly resolution: "delivered" | "retry";
    };

function fail(message: string): never {
  throw new Error(message);
}

function argumentsMap(values: readonly string[]): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--") || value.startsWith("--")) {
      fail("Arguments must be provided as --name value pairs.");
    }
    if (output.has(name)) fail(`Duplicate argument: ${name}.`);
    output.set(name, value);
  }
  return output;
}

function optional(map: ReadonlyMap<string, string>, name: string, pattern: RegExp): string | undefined {
  const value = map.get(name);
  if (value !== undefined && !pattern.test(value)) fail(`${name} is invalid.`);
  return value;
}

function required(map: ReadonlyMap<string, string>, name: string, pattern: RegExp): string {
  return optional(map, name, pattern) ?? fail(`${name} is required.`);
}

export function parseQuarantineCommand(values: readonly string[]): QuarantineCommand {
  const [command, ...rawArguments] = values;
  if (command !== "list" && command !== "resolve") {
    fail("Usage: quarantine list [--installation ID] [--conversation ID] | quarantine resolve --installation ID --conversation ID --outbox UUID --resolution delivered|retry --confirmation TOKEN");
  }
  const args = argumentsMap(rawArguments);
  const allowed = command === "list"
    ? new Set(["--installation", "--conversation"])
    : new Set(["--installation", "--conversation", "--outbox", "--resolution", "--confirmation"]);
  for (const name of args.keys()) if (!allowed.has(name)) fail(`Unknown argument: ${name}.`);
  if (command === "list") {
    const installationId = optional(args, "--installation", INSTALLATION);
    const conversationId = optional(args, "--conversation", IDENTIFIER);
    return {
      command,
      ...(installationId === undefined ? {} : { installationId }),
      ...(conversationId === undefined ? {} : { conversationId }),
    };
  }
  const installationId = required(args, "--installation", INSTALLATION);
  const conversationId = required(args, "--conversation", IDENTIFIER);
  const outboxId = required(args, "--outbox", UUID);
  const resolution = required(args, "--resolution", /^(?:delivered|retry)$/u) as "delivered" | "retry";
  const expectedConfirmation = resolution === "delivered"
    ? "verified-delivered"
    : "verified-absent-safe-to-retry";
  if (args.get("--confirmation") !== expectedConfirmation) {
    fail(`--confirmation must be ${expectedConfirmation}.`);
  }
  return { command, installationId, conversationId, outboxId, resolution };
}
