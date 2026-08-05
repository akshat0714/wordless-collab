import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayServer } from "../src/app.js";
import { MemoryLogger } from "../src/logger.js";
import type { GatewayRuntime } from "../src/runtime.js";
import { MemorySecretStore } from "../src/secrets.js";
import { MemoryGatewayStore } from "../src/store.js";
import { installation, testConfig } from "./helpers.js";

const servers: ReturnType<typeof createGatewayServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    if (server.listening) await once(server, "close");
  }));
});

async function start() {
  const store = new MemoryGatewayStore();
  const process = vi.fn(() => new Promise<never>(() => undefined));
  const runtime = {
    process,
    validateSecrets: vi.fn(async () => undefined),
  } as unknown as GatewayRuntime;
  const server = createGatewayServer({
    config: testConfig(),
    store,
    runtime,
    secrets: new MemorySecretStore({ ZENDESK_WEBHOOK_SECRET: "w".repeat(40) }),
    logger: new MemoryLogger(),
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { store, process, origin: `http://127.0.0.1:${port}` };
}

describe("gateway HTTP ingress", () => {
  it("durably accepts and acknowledges without waiting for inference", async () => {
    const { store, process, origin } = await start();
    const response = await fetch(`${origin}/v1/webhooks/zendesk/${installation.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "w".repeat(40) },
      body: JSON.stringify({ any: "bounded payload" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(process).not.toHaveBeenCalled();
    await expect(store.claimInbox(1, 1_000, 3)).resolves.toHaveLength(1);
  });

  it("exposes standard liveness and readiness routes", async () => {
    const { origin } = await start();
    await expect(fetch(`${origin}/health/live`).then((response) => response.status)).resolves.toBe(200);
    await expect(fetch(`${origin}/health/ready`).then((response) => response.status)).resolves.toBe(200);
  });

  it("does not advertise readiness when the store schema probe fails", async () => {
    const { store, origin } = await start();
    vi.spyOn(store, "ping").mockRejectedValue(new Error("schema mismatch"));
    await expect(fetch(`${origin}/health/live`).then((response) => response.status)).resolves.toBe(200);
    await expect(fetch(`${origin}/health/ready`).then((response) => response.status)).resolves.toBe(503);
  });

  it("rejects an altered body reusing the same delivery id", async () => {
    const { origin } = await start();
    const headers = {
      "content-type": "application/json",
      "x-api-key": "w".repeat(40),
      "x-wordless-delivery-id": "delivery-123456789",
    };
    expect((await fetch(`${origin}/v1/webhooks/zendesk/${installation.id}`, { method: "POST", headers, body: '{"a":1}' })).status).toBe(202);
    expect((await fetch(`${origin}/v1/webhooks/zendesk/${installation.id}`, { method: "POST", headers, body: '{"a":2}' })).status).toBe(409);
  });

  it("rejects an unauthenticated oversized body before reading or persisting it", async () => {
    const { store, origin } = await start();
    const response = await fetch(`${origin}/v1/webhooks/zendesk/${installation.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(300_000) }),
    });
    expect(response.status).toBe(401);
    await expect(store.claimInbox(1, 1_000, 3)).resolves.toHaveLength(0);
  });
});
