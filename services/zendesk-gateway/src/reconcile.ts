import { loadDatabaseUrl } from "./config.js";
import { PostgresGatewayStore } from "./postgres-store.js";
import { parseQuarantineCommand } from "./quarantine-command.js";

async function main(): Promise<void> {
  const command = parseQuarantineCommand(process.argv.slice(2));
  if (command.command === "list") {
    const store = new PostgresGatewayStore(loadDatabaseUrl(process.env, true) as string);
    try {
      const values = await store.listQuarantines({
        ...(command.installationId === undefined ? {} : { installationId: command.installationId }),
        ...(command.conversationId === undefined ? {} : { conversationId: command.conversationId }),
      });
      process.stdout.write(`${JSON.stringify({ quarantines: values }, null, 2)}\n`);
    } finally {
      await store.close();
    }
    return;
  }
  const store = new PostgresGatewayStore(loadDatabaseUrl(process.env, true) as string);
  try {
    await store.reconcileQuarantine(command);
    process.stdout.write(`${JSON.stringify({ status: "reconciled", resolution: command.resolution, outboxId: command.outboxId })}\n`);
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Quarantine command failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
