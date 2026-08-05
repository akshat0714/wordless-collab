"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import {
  isFixtureRunEvent,
  type FixtureRunEvent,
  type FixtureRunMetrics,
  type FixtureStageId,
} from "@/lib/fixture-run-events";

type StageView = {
  id: FixtureStageId;
  label: string;
  detail: string;
  status: "ready" | "running" | "complete" | "failed";
  durationMs: number | null;
  startedAtElapsedMs?: number;
};

const initialStages: StageView[] = [
  {
    id: "preflight",
    label: "Verify local fixture inputs",
    detail: "Fixed script and Module 0 benchmark paths; not checked in this browser session yet.",
    status: "ready",
    durationMs: null,
  },
  {
    id: "benchmark",
    label: "Validate benchmark gate",
    detail: "Fixed Module 0 result and semantic winner; not checked in this browser session yet.",
    status: "ready",
    durationMs: null,
  },
  {
    id: "model",
    label: "Initialize semantic model",
    detail: "Verified semantic winner in offline CPU mode; not initialized in this session yet.",
    status: "ready",
    durationMs: null,
  },
  {
    id: "redaction",
    label: "Redact fixture interactions",
    detail: "All 30 synthetic interactions; mandatory preprocessing has not run in this session yet.",
    status: "ready",
    durationMs: null,
  },
  {
    id: "calibration",
    label: "Calibrate confidence floor",
    detail: "The fixed 15-record calibration split; not fitted in this browser session yet.",
    status: "ready",
    durationMs: null,
  },
  {
    id: "replay",
    label: "Replay resolution evidence",
    detail: "Frozen detectors across 30 interactions; replay has not run in this session yet.",
    status: "ready",
    durationMs: null,
  },
  {
    id: "report",
    label: "Build audit report",
    detail: "Canonical JSON and HTML outputs; not written in this browser session yet.",
    status: "ready",
    durationMs: null,
  },
  {
    id: "artifacts",
    label: "Validate the generated artifacts",
    detail: "Fresh report.json and index.html outputs; not checked in this browser session yet.",
    status: "ready",
    durationMs: null,
  },
];

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = ((milliseconds % 60_000) / 1_000).toFixed(1);
  return `${minutes} min ${seconds} s`;
}

function stageStatusClass(status: StageView["status"]): string {
  if (status === "complete") return "label-status label-status-ok";
  if (status === "failed") return "label-status label-status-flag";
  return "label-status label-status-hold";
}

function stageStatusText(status: StageView["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function errorMessage(value: unknown, fallback: string): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return fallback;
}

export function AuditRunner() {
  const [stages, setStages] = useState<StageView[]>(initialStages);
  const [runState, setRunState] = useState<"ready" | "running" | "complete" | "failed">("ready");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [metrics, setMetrics] = useState<FixtureRunMetrics | null>(null);
  const [artifacts, setArtifacts] = useState<Extract<FixtureRunEvent, { type: "run_completed" }>["artifacts"] | null>(null);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [processOutput, setProcessOutput] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const applyEvent = useCallback((event: FixtureRunEvent) => {
    setElapsedMs(event.elapsedMs);
    if (event.type === "run_started") {
      setRunState("running");
      return;
    }
    if (event.type === "heartbeat") return;
    if (event.type === "stage_started") {
      setStages((current) =>
        current.map((stage) =>
          stage.id === event.stageId
            ? {
                ...stage,
                label: event.label,
                detail: event.detail,
                status: "running",
                durationMs: null,
                startedAtElapsedMs: event.elapsedMs,
              }
            : stage,
        ),
      );
      return;
    }
    if (event.type === "stage_completed") {
      setStages((current) =>
        current.map((stage) =>
          stage.id === event.stageId
            ? {
                ...stage,
                detail: event.detail,
                status: "complete",
                durationMs: event.durationMs,
              }
            : stage,
        ),
      );
      return;
    }
    if (event.type === "process_output") {
      setProcessOutput((current) => `${current}${event.text}`.slice(-8_000));
      return;
    }
    if (event.type === "run_completed") {
      setRunState("complete");
      setMetrics(event.metrics);
      setArtifacts(event.artifacts);
      return;
    }
    setRunState("failed");
    setError({ message: event.message, detail: event.detail });
    setStages((current) =>
      current.map((stage) =>
        stage.status === "running" ? { ...stage, status: "failed" } : stage,
      ),
    );
  }, []);

  const startRun = useCallback(async () => {
    if (runState === "running") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStages(initialStages);
    setRunState("running");
    setElapsedMs(0);
    setMetrics(null);
    setArtifacts(null);
    setError(null);
    setProcessOutput("");
    try {
      const response = await fetch("/api/audits/fixture", {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/x-ndjson" },
        signal: controller.signal,
      });
      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          // A non-JSON proxy error still receives the bounded fallback below.
        }
        throw new Error(errorMessage(payload, `The local runner returned HTTP ${response.status}.`));
      }
      if (!response.body) throw new Error("The local runner did not return a readable event stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let receivedTerminalEvent = false;
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: unknown;
          try {
            event = JSON.parse(line) as unknown;
          } catch {
            throw new Error("The local runner returned a malformed event.");
          }
          if (!isFixtureRunEvent(event)) {
            throw new Error("The local runner returned an event with an invalid shape.");
          }
          if (event.type === "run_completed" || event.type === "run_failed") {
            receivedTerminalEvent = true;
          }
          applyEvent(event);
        }
        if (done) break;
      }
      if (pending.trim()) {
        const event = JSON.parse(pending) as unknown;
        if (!isFixtureRunEvent(event)) throw new Error("The local runner returned an invalid final event.");
        if (event.type === "run_completed" || event.type === "run_failed") {
          receivedTerminalEvent = true;
        }
        applyEvent(event);
      }
      if (!receivedTerminalEvent) {
        throw new Error("The local runner ended without a completion event.");
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        setRunState("failed");
        setError({ message: "The local run was cancelled.", detail: null });
      } else {
        setRunState("failed");
        setError({
          message: caught instanceof Error ? caught.message : "The local run failed.",
          detail: null,
        });
      }
      setStages((current) =>
        current.map((stage) =>
          stage.status === "running" ? { ...stage, status: "failed" } : stage,
        ),
      );
    } finally {
      abortRef.current = null;
    }
  }, [applyEvent, runState]);

  const completeCount = stages.filter((stage) => stage.status === "complete").length;

  return (
    <>
      <section className="pt-8" aria-labelledby="run-instrument-heading">
        <div className="grid grid-cols-1 gap-6 border-b border-rule-firm pb-7 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div>
            <h2 id="run-instrument-heading" className="text-lg font-semibold">
              Local fixture instrument
            </h2>
            <p className="mt-2 max-w-prose text-sm text-ink-soft">
              Starts the fixed offline synthetic audit entry point. Only one run can execute at a
              time, with a 15-minute hard limit; no corpus, command, path, model, or output target
              can be supplied from this page. The child process receives a restricted environment,
              without integration credential variables.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="button-primary"
              onClick={() => void startRun()}
              disabled={runState === "running"}
            >
              {runState === "running" ? "Fixture audit running…" : runState === "complete" ? "Run fixture audit again" : "Start fixture audit"}
            </button>
            {runState === "running" ? (
              <button
                type="button"
                className="button-danger"
                onClick={() => abortRef.current?.abort()}
              >
                Cancel local run
              </button>
            ) : null}
          </div>
        </div>

        <div
          className={`border-b px-4 py-3 text-xs font-medium ${
            runState === "failed"
              ? "border-flag bg-flag-bg text-flag"
              : runState === "complete"
                ? "border-ok bg-surface text-ok"
                : "border-rule bg-hold-bg text-hold"
          }`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {runState === "ready" ? "Ready · no process started in this browser session." : null}
          {runState === "running" ? (
            <>
              <span>Running · {completeCount} / {stages.length} measured stages complete.</span>
              <span aria-hidden="true"> · {formatDuration(elapsedMs)} elapsed.</span>
            </>
          ) : null}
          {runState === "complete" ? `Complete · ${completeCount} / ${stages.length} stages validated · ${formatDuration(elapsedMs)} total.` : null}
          {runState === "failed" ? `${error?.message ?? "The local fixture audit failed."} · ${formatDuration(elapsedMs)} elapsed.` : null}
        </div>

        <ol className="border-t border-rule-firm">
          {stages.map((stage, index) => (
            <li
              key={stage.id}
              className="grid grid-cols-[36px_1fr] gap-x-4 border-b border-rule py-5 sm:grid-cols-[40px_minmax(0,1fr)_110px_120px] sm:items-center sm:gap-x-6"
            >
              <span className="row-span-2 font-mono text-xs tabular-nums text-ink-faint sm:row-span-1">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="font-semibold">{stage.label}</h3>
                <p className="mt-1 text-sm text-ink-soft">{stage.detail}</p>
              </div>
              <div className="mt-3 sm:mt-0">
                <span className={stageStatusClass(stage.status)}>{stageStatusText(stage.status)}</span>
              </div>
              <div className="mt-3 text-left font-mono text-sm tabular-nums sm:mt-0 sm:text-right">
                <span className="block text-[10px] uppercase tracking-[0.1em] text-ink-faint">Measured</span>
                {stage.durationMs !== null
                  ? formatDuration(stage.durationMs)
                  : stage.status === "running" && stage.startedAtElapsedMs !== undefined
                    ? formatDuration(Math.max(0, elapsedMs - stage.startedAtElapsedMs))
                    : "—"}
              </div>
            </li>
          ))}
        </ol>

        {error?.detail ? (
          <details className="border-b border-flag bg-flag-bg px-4 py-4 text-xs text-flag">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold">Local process diagnostic</summary>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap font-mono leading-5">{error.detail}</pre>
          </details>
        ) : null}

        {runState === "complete" && metrics && artifacts ? (
          <div className="mt-7 border-y border-rule-firm bg-surface py-5">
            <div className="flex flex-col gap-4 px-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ok">Validated local output</p>
                <p className="mt-2 text-xs text-ink-soft">
                  Counts below were parsed from this run’s fresh report.json; they are synthetic test outcomes, not production rates.
                </p>
              </div>
              <Link className="button-primary shrink-0" href={artifacts.reportUrl}>Open generated report</Link>
            </div>
            <div className="audit-table-wrap mt-5 px-4">
              <table className="audit-table !min-w-[520px]">
                <thead>
                  <tr>
                    <th scope="col">Outcome</th>
                    <th scope="col">Count</th>
                    <th scope="col">Denominator</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="font-semibold">Analyzed</td><td className="font-mono">{metrics.analyzed}</td><td className="font-mono">{metrics.analyzed} / {metrics.analyzed}</td></tr>
                  <tr><td className="font-semibold">Agreement@1</td><td className="font-mono">{metrics.agreementAt1}</td><td className="font-mono">{metrics.agreementAt1} / {metrics.analyzed}</td></tr>
                  <tr><td className="font-semibold">Agreement@3</td><td className="font-mono">{metrics.agreementAt3}</td><td className="font-mono">{metrics.agreementAt3} / {metrics.analyzed}</td></tr>
                  <tr><td className="font-semibold text-hold">Abstained</td><td className="font-mono text-hold">{metrics.abstained}</td><td className="font-mono">{metrics.abstained} / {metrics.analyzed}</td></tr>
                  <tr><td className="font-semibold text-flag">Findings</td><td className="font-mono text-flag">{metrics.disagreements}</td><td className="font-mono">{metrics.disagreements} / {metrics.analyzed}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="px-4 pt-4 font-mono text-[11px] text-ink-faint">
              {artifacts.jsonPath} · {artifacts.htmlPath}
            </p>
          </div>
        ) : null}

        {processOutput ? (
          <details className="mt-5 border-y border-rule py-3 text-xs text-ink-soft">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold text-ink">
              Bounded process output
            </summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap py-3 font-mono leading-5">{processOutput}</pre>
          </details>
        ) : null}
      </section>
    </>
  );
}
