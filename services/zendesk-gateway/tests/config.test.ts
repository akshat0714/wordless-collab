import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig, loadDatabaseUrl } from "../src/config.js";
import { installationJson } from "./helpers.js";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    WORDLESS_BASE_URL: "https://api.wordless.example",
    INSTALLATIONS_JSON: installationJson(),
    ...overrides,
  };
}

describe("configuration", () => {
  it("uses the promised port and product mode defaults", () => {
    const config = loadConfig(env());
    expect(config.port).toBe(8080);
    expect(config.productMode).toBe("customer_clarify");
  });

  it("permits HTTP only for explicitly allowed private service hosts", () => {
    expect(loadConfig(env({ WORDLESS_BASE_URL: "http://wordless-api:8001", WORDLESS_ALLOW_PRIVATE_HTTP: "true" })).wordlessBaseUrl)
      .toBe("http://wordless-api:8001");
    expect(() => loadConfig(env({ WORDLESS_BASE_URL: "http://wordless-api:8001" }))).toThrow(ConfigurationError);
    expect(() => loadConfig(env({ WORDLESS_BASE_URL: "http://fc-example.com", WORDLESS_ALLOW_PRIVATE_HTTP: "true" }))).toThrow(ConfigurationError);
    expect(() => loadConfig(env({ WORDLESS_BASE_URL: "http://8.8.8.8", WORDLESS_ALLOW_PRIVATE_HTTP: "true" }))).toThrow(ConfigurationError);
  });

  it("independently protects the resolver URL", () => {
    const base = {
      EVIDENCE_RESOLVER_MODE: "http",
      EVIDENCE_RESOLVER_SECRET_REF: "EVIDENCE_RESOLVER_HMAC_SECRET",
    };
    expect(loadConfig(env({ ...base, EVIDENCE_RESOLVER_URL: "http://evidence-resolver/v1/resolve", EVIDENCE_RESOLVER_ALLOW_PRIVATE_HTTP: "true" })).evidenceResolver.mode).toBe("http");
    expect(() => loadConfig(env({ ...base, EVIDENCE_RESOLVER_URL: "not a url" }))).toThrow(ConfigurationError);
    expect(() => loadConfig(env({ ...base, EVIDENCE_RESOLVER_URL: "http://fd-example.com/v1", EVIDENCE_RESOLVER_ALLOW_PRIVATE_HTTP: "true" }))).toThrow(ConfigurationError);
    expect(() => loadConfig(env({ ...base, EVIDENCE_RESOLVER_URL: "https://user:pass@example.com/v1" }))).toThrow(ConfigurationError);
  });

  it("requires an explicit production product mode", () => {
    const production = env({
      NODE_ENV: "production",
      GATEWAY_STORE: "postgres",
      DATABASE_URL: "postgres://db/gateway",
      OUTBOX_DELIVERY_MODE: "zendesk",
      EVIDENCE_RESOLVER_MODE: "http",
      EVIDENCE_RESOLVER_URL: "https://resolver.example/v1/evidence",
      EVIDENCE_RESOLVER_SECRET_REF: "EVIDENCE_RESOLVER_HMAC_SECRET",
    });
    expect(() => loadConfig(production)).toThrow(/PRODUCT_MODE/u);
    expect(loadConfig({ ...production, PRODUCT_MODE: "customer_clarify" }).environment).toBe("production");
    expect(() => loadConfig({ ...production, PRODUCT_MODE: "customer_clarify", SUPPORTED_LOCALE_PREFIXES: "es,fr" }))
      .toThrow(/SUPPORTED_LOCALE_PREFIXES=en/u);
    expect(() => loadConfig({ ...production, PRODUCT_MODE: "customer_clarify", REQUIRE_KNOWN_LOCALE: "false" }))
      .toThrow(/REQUIRE_KNOWN_LOCALE=true/u);
  });

  it("reserves a release retry margin below Zendesk's 24-hour control maximum", () => {
    expect(() => loadConfig(env({ CHOICE_TTL_HOURS: "24" }))).toThrow(/1 to 23/u);
    expect(loadConfig(env({ CHOICE_TTL_HOURS: "23" })).choiceTtlHours).toBe(23);
  });

  it("loads DATABASE_URL from a bounded absolute file and rejects ambiguity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordless-config-"));
    const file = join(directory, "database-url");
    await writeFile(file, "postgres://db/gateway\n", "utf8");
    expect(loadDatabaseUrl({ DATABASE_URL_FILE: file })).toBe("postgres://db/gateway");
    expect(() => loadDatabaseUrl({ DATABASE_URL: "postgres://one", DATABASE_URL_FILE: file })).toThrow(ConfigurationError);
  });
});
