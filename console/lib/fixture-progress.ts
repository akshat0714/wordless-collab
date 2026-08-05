import type { FixtureStageId } from "@/lib/fixture-run-events";

export const fixtureProgressPrefix = "WORDLESS_FIXTURE_PROGRESS ";

const fixtureProgressProtocol = "wordless.fixture-progress.v1";
const maximumProgressElapsedMs = 15 * 60 * 1_000 + 5_000;

export const internalFixtureStages = [
  {
    id: "benchmark",
    label: "Validate benchmark gate",
    startedDetail:
      "Reading the fixed Module 0 result and resolving its verified winning semantic method.",
    completedDetail: "Validated the passed benchmark and resolved its semantic winner.",
  },
  {
    id: "model",
    label: "Initialize semantic model",
    startedDetail: "Loading the verified winner in offline CPU mode from local model files.",
    completedDetail: "Initialized the verified semantic model in offline CPU mode.",
  },
  {
    id: "redaction",
    label: "Redact fixture interactions",
    startedDetail: "Applying the mandatory redactor to all 30 synthetic interactions before analysis.",
    completedDetail: "Redacted and normalized all 30 synthetic interactions.",
  },
  {
    id: "calibration",
    label: "Calibrate confidence floor",
    startedDetail: "Fitting on 15 alternating fixture records and freezing the held-out threshold.",
    completedDetail: "Calibrated on 15 fixture records and froze the confidence floor.",
  },
  {
    id: "replay",
    label: "Replay resolution evidence",
    startedDetail: "Reconstructing state and testing the frozen detector set across 30 interactions.",
    completedDetail: "Replayed reconstructed evidence across all 30 interactions.",
  },
  {
    id: "report",
    label: "Build audit report",
    startedDetail: "Aggregating outcomes and writing canonical JSON and HTML audit artifacts.",
    completedDetail: "Aggregated outcomes and wrote the canonical report artifacts.",
  },
] as const satisfies readonly {
  id: FixtureStageId;
  label: string;
  startedDetail: string;
  completedDetail: string;
}[];

type InternalFixtureStageId = (typeof internalFixtureStages)[number]["id"];

export type FixtureProgressEvent =
  | {
      event: "stage_started";
      stageId: InternalFixtureStageId;
      elapsedMs: number;
    }
  | {
      event: "stage_completed";
      stageId: InternalFixtureStageId;
      elapsedMs: number;
      durationMs: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export class FixtureProgressParser {
  private nextSequence = 0;
  private lastElapsedMs = 0;

  parse(jsonText: string): FixtureProgressEvent {
    let value: unknown;
    try {
      value = JSON.parse(jsonText) as unknown;
    } catch {
      throw new Error("The fixture process emitted malformed progress JSON.");
    }
    if (!isRecord(value) || value.protocol !== fixtureProgressProtocol) {
      throw new Error("The fixture process emitted an unknown progress protocol.");
    }

    const expectedStage = internalFixtureStages[Math.floor(this.nextSequence / 2)];
    if (!expectedStage) {
      throw new Error("The fixture process emitted progress after its final stage.");
    }
    const expectedEvent = this.nextSequence % 2 === 0 ? "stage_started" : "stage_completed";
    const expectedKeys = expectedEvent === "stage_started"
      ? ["elapsed_ms", "event", "protocol", "sequence", "stage_id"]
      : ["duration_ms", "elapsed_ms", "event", "protocol", "sequence", "stage_id"];
    if (!hasExactKeys(value, expectedKeys)) {
      throw new Error("The fixture process emitted progress with an invalid shape.");
    }
    if (
      value.sequence !== this.nextSequence ||
      value.event !== expectedEvent ||
      value.stage_id !== expectedStage.id
    ) {
      throw new Error("The fixture process emitted progress out of order.");
    }
    if (
      !isNonnegativeSafeInteger(value.elapsed_ms) ||
      value.elapsed_ms < this.lastElapsedMs ||
      value.elapsed_ms > maximumProgressElapsedMs
    ) {
      throw new Error("The fixture process emitted an invalid elapsed time.");
    }

    const stageId = expectedStage.id;
    const elapsedMs = value.elapsed_ms;
    this.lastElapsedMs = elapsedMs;
    this.nextSequence += 1;
    if (expectedEvent === "stage_started") {
      return { event: "stage_started", stageId, elapsedMs };
    }
    if (
      !isNonnegativeSafeInteger(value.duration_ms) ||
      value.duration_ms > elapsedMs ||
      value.duration_ms > maximumProgressElapsedMs
    ) {
      throw new Error("The fixture process emitted an invalid stage duration.");
    }
    return {
      event: "stage_completed",
      stageId,
      elapsedMs,
      durationMs: value.duration_ms,
    };
  }

  assertComplete(): void {
    if (this.nextSequence !== internalFixtureStages.length * 2) {
      throw new Error("The fixture process ended before reporting every internal stage.");
    }
  }
}
