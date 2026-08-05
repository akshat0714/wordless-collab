export type FixtureStageId =
  | "preflight"
  | "benchmark"
  | "model"
  | "redaction"
  | "calibration"
  | "replay"
  | "report"
  | "artifacts";

export type FixtureRunMetrics = {
  analyzed: number;
  agreementAt1: number;
  agreementAt3: number;
  abstained: number;
  disagreements: number;
};

export type FixtureRunEvent =
  | {
      type: "run_started";
      startedAt: string;
      elapsedMs: number;
    }
  | {
      type: "stage_started";
      stageId: FixtureStageId;
      label: string;
      detail: string;
      elapsedMs: number;
    }
  | {
      type: "stage_completed";
      stageId: FixtureStageId;
      detail: string;
      elapsedMs: number;
      durationMs: number;
    }
  | {
      type: "process_output";
      stream: "stdout" | "stderr";
      text: string;
      elapsedMs: number;
    }
  | {
      type: "heartbeat";
      elapsedMs: number;
    }
  | {
      type: "run_completed";
      elapsedMs: number;
      artifacts: {
        reportUrl: string;
        jsonPath: string;
        htmlPath: string;
      };
      metrics: FixtureRunMetrics;
    }
  | {
      type: "run_failed";
      elapsedMs: number;
      message: string;
      detail: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isElapsed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStageId(value: unknown): value is FixtureStageId {
  return (
    value === "preflight" ||
    value === "benchmark" ||
    value === "model" ||
    value === "redaction" ||
    value === "calibration" ||
    value === "replay" ||
    value === "report" ||
    value === "artifacts"
  );
}

export function isFixtureRunEvent(value: unknown): value is FixtureRunEvent {
  if (!isRecord(value) || !isElapsed(value.elapsedMs)) return false;
  if (value.type === "run_started") {
    return typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt));
  }
  if (value.type === "heartbeat") return true;
  if (value.type === "stage_started") {
    return (
      isStageId(value.stageId) &&
      typeof value.label === "string" &&
      typeof value.detail === "string"
    );
  }
  if (value.type === "stage_completed") {
    return (
      isStageId(value.stageId) &&
      typeof value.detail === "string" &&
      isElapsed(value.durationMs)
    );
  }
  if (value.type === "process_output") {
    return (
      (value.stream === "stdout" || value.stream === "stderr") &&
      typeof value.text === "string"
    );
  }
  if (value.type === "run_failed") {
    return (
      typeof value.message === "string" &&
      (value.detail === null || typeof value.detail === "string")
    );
  }
  if (value.type === "run_completed") {
    if (!isRecord(value.artifacts) || !isRecord(value.metrics)) return false;
    const metrics = value.metrics;
    return (
      typeof value.artifacts.reportUrl === "string" &&
      typeof value.artifacts.jsonPath === "string" &&
      typeof value.artifacts.htmlPath === "string" &&
      Number.isSafeInteger(metrics.analyzed) &&
      Number.isSafeInteger(metrics.agreementAt1) &&
      Number.isSafeInteger(metrics.agreementAt3) &&
      Number.isSafeInteger(metrics.abstained) &&
      Number.isSafeInteger(metrics.disagreements)
    );
  }
  return false;
}
