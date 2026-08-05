export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly request_id?: string;
  readonly installation_id?: string;
  readonly operation_kind?: string;
  readonly product_mode?: string;
  readonly count?: number;
  readonly duration_ms?: number;
  readonly attempt?: number;
  readonly error_code?: string;
  readonly status?: number;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

export class JsonLogger implements Logger {
  constructor(private readonly sink: Pick<Console, "log"> = console) {}

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.sink.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    }));
  }
}

export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: LogLevel; event: string; fields: LogFields }> = [];

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.entries.push({ level, event, fields });
  }
}

export function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  return error.name.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase().slice(0, 80);
}
