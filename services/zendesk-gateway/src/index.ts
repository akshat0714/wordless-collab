import { once } from "node:events";
import type { Server } from "node:http";

import { createGatewayServer } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonLogger, safeErrorCode } from "./logger.js";
import { PostgresGatewayStore } from "./postgres-store.js";
import { createEvidenceResolver } from "./resolver.js";
import { GatewayRuntime } from "./runtime.js";
import { EnvironmentSecretStore } from "./secrets.js";
import { MemoryGatewayStore, type GatewayStore } from "./store.js";
import { GatewayWorker } from "./worker.js";

async function main(): Promise<void> {
  const logger = new JsonLogger();
  let store: GatewayStore | undefined;
  let server: Server | undefined;
  let worker: GatewayWorker | undefined;
  try {
    const config = loadConfig();
    const secrets = new EnvironmentSecretStore();
    store = config.storeDriver === "postgres"
      ? new PostgresGatewayStore(config.databaseUrl as string)
      : new MemoryGatewayStore();
    const resolver = createEvidenceResolver(config, secrets, logger);
    const runtime = new GatewayRuntime(config, secrets, store, resolver, logger);
    await Promise.all([store.ping(), runtime.validateSecrets()]);
    server = createGatewayServer({ config, store, secrets, runtime, logger });
    worker = new GatewayWorker(config, store, runtime, logger);
    server.listen(config.port, config.host);
    await once(server, "listening");
    worker.start();
    logger.log("info", "gateway_started", { product_mode: config.productMode });
    const activeStore = store;
    const activeServer = server;
    const activeWorker = worker;

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.log("info", "gateway_stopping", { error_code: signal.toLowerCase() });
      const serverClosed = new Promise<void>((resolve, reject) => {
        activeServer.close((error) => error === undefined ? resolve() : reject(error));
      });
      activeServer.closeIdleConnections();
      const graceful = Promise.all([serverClosed, activeWorker.stop()]);
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        forceTimer = setTimeout(() => {
          activeServer.closeAllConnections();
          resolve();
        }, config.shutdownGraceMs);
        forceTimer.unref();
      });
      try {
        await Promise.race([graceful, timeout]);
      } finally {
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        await activeStore.close();
      }
      logger.log("info", "gateway_stopped");
    };
    const onSignal = (signal: string): void => {
      void shutdown(signal).catch((error) => {
        logger.log("error", "gateway_stop_failed", { error_code: safeErrorCode(error) });
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  } catch (error) {
    if (server?.listening === true) {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await worker?.stop().catch(() => undefined);
    await store?.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  new JsonLogger().log("error", "gateway_start_failed", { error_code: safeErrorCode(error) });
  process.exitCode = 1;
});
