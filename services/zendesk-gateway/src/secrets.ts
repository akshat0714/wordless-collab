export interface SecretStore {
  get(reference: string): Promise<string>;
}

export class SecretUnavailableError extends Error {
  constructor(readonly reference: string) {
    super("A required secret is unavailable.");
    this.name = "SecretUnavailableError";
  }
}

/**
 * Local/container adapter. Production deployments should inject secrets into
 * the process or replace this boundary with a Vault/KMS-backed implementation.
 * Installation records contain references only, never credential values.
 */
export class EnvironmentSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(reference: string): Promise<string> {
    const value = this.env[reference];
    const file = this.env[`${reference}_FILE`];
    if (value !== undefined && value.length > 0 && file !== undefined && file.length > 0) {
      throw new SecretUnavailableError(reference);
    }
    let resolved = value;
    if (file !== undefined && file.length > 0) {
      if (!isAbsolute(file)) throw new SecretUnavailableError(reference);
      try {
        const bytes = await readFile(file);
        if (bytes.byteLength > 65_536) throw new SecretUnavailableError(reference);
        resolved = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/u, "");
      } catch {
        throw new SecretUnavailableError(reference);
      }
    }
    if (resolved === undefined || resolved.length === 0 || /[\r\n]/u.test(resolved)) {
      throw new SecretUnavailableError(reference);
    }
    return resolved;
  }
}

export class MemorySecretStore implements SecretStore {
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  async get(reference: string): Promise<string> {
    const value = this.values[reference];
    if (value === undefined || value.length === 0) throw new SecretUnavailableError(reference);
    return value;
  }
}
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
