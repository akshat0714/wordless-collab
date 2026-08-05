import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { EnvironmentSecretStore, SecretUnavailableError } from "../src/secrets.js";

it("loads a secret from ENV or ENV_FILE and fails on ambiguity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wordless-secret-"));
  const file = join(directory, "secret");
  await writeFile(file, "file-secret-value\n", "utf8");
  await expect(new EnvironmentSecretStore({ TOKEN_FILE: file }).get("TOKEN")).resolves.toBe("file-secret-value");
  await expect(new EnvironmentSecretStore({ TOKEN: "env", TOKEN_FILE: file }).get("TOKEN")).rejects.toBeInstanceOf(SecretUnavailableError);
  await expect(new EnvironmentSecretStore({ TOKEN_FILE: "relative" }).get("TOKEN")).rejects.toBeInstanceOf(SecretUnavailableError);
});
