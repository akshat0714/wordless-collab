import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";

import {
  FixtureProgressParser,
  fixtureProgressPrefix,
  internalFixtureStages,
  type FixtureProgressEvent,
} from "@/lib/fixture-progress";
import type {
  FixtureRunEvent,
  FixtureRunMetrics,
  FixtureStageId,
} from "@/lib/fixture-run-events";
import {
  benchmarkPath,
  fixtureCommand,
  fixtureReportHtmlPath,
  fixtureReportJsonPath,
  fixtureScriptPath,
  repositoryRoot,
} from "@/lib/local-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

declare global {
  var wordlessFixtureAuditRunning: boolean | undefined;
  var wordlessFixtureAuditChild: ChildProcess | undefined;
}

const maximumArtifactBytes = 2 * 1024 * 1024;
const maximumStreamedOutputBytes = 12 * 1024;
const maximumDiagnosticCharacters = 4_000;
const maximumProgressLineCharacters = 4_000;
const maximumAuditRuntimeMs = 15 * 60 * 1_000;

class RunFailure extends Error {
  constructor(message: string, readonly detail: string | null = null) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RunFailure(`The generated report has an invalid ${name} count.`);
  }
  return value as number;
}

function parseMetrics(value: unknown): FixtureRunMetrics {
  if (!isRecord(value) || !isRecord(value.outcomes)) {
    throw new RunFailure("The generated report is missing its outcome counts.");
  }
  const outcomes = value.outcomes;
  const metrics = {
    analyzed: readCount(outcomes.analyzed, "analyzed"),
    agreementAt1: readCount(outcomes.agreement_at_1, "agreement@1"),
    agreementAt3: readCount(outcomes.agreement_at_3, "agreement@3"),
    abstained: readCount(outcomes.abstained, "abstained"),
    disagreements: readCount(outcomes.disagreements, "disagreements"),
  };
  if (
    metrics.agreementAt1 > metrics.analyzed ||
    metrics.agreementAt3 > metrics.analyzed ||
    metrics.abstained > metrics.analyzed ||
    metrics.disagreements > metrics.analyzed
  ) {
    throw new RunFailure("The generated report contains counts above its analyzed denominator.");
  }
  return metrics;
}

function compactDiagnostic(value: string): string | null {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!normalized) return null;
  return normalized.slice(-maximumDiagnosticCharacters);
}

function restrictedFixtureEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    HF_HOME: process.env.HF_HOME,
    SENTENCE_TRANSFORMERS_HOME: process.env.SENTENCE_TRANSFORMERS_HOME,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    UV_OFFLINE: "1",
    PYTHONHASHSEED: "0",
    PYTHONUNBUFFERED: "1",
  };
}

async function waitForChild(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json(
      { error: "Cross-origin fixture runs are not allowed." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    (Number.isFinite(contentLength) && contentLength > 0) ||
    request.headers.has("content-type") ||
    request.headers.has("transfer-encoding")
  ) {
    return Response.json(
      { error: "The fixture run does not accept runtime arguments." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (globalThis.wordlessFixtureAuditRunning) {
    return Response.json(
      { error: "A local fixture audit is already running. Wait for it to finish." },
      { status: 409, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
    );
  }
  globalThis.wordlessFixtureAuditRunning = true;

  const encoder = new TextEncoder();
  let streamCancelled = false;
  let outputBytes = 0;
  const startedAtWall = Date.now();
  const startedAt = performance.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
      const send = (event: FixtureRunEvent): void => {
        if (streamCancelled) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          streamCancelled = true;
        }
      };
      const stageStarted = (
        stageId: FixtureStageId,
        label: string,
        detail: string,
      ): number => {
        send({ type: "stage_started", stageId, label, detail, elapsedMs: elapsed() });
        return performance.now();
      };
      const stageCompleted = (
        stageId: FixtureStageId,
        stageStart: number,
        detail: string,
      ): void => {
        send({
          type: "stage_completed",
          stageId,
          detail,
          elapsedMs: elapsed(),
          durationMs: Math.max(0, Math.round(performance.now() - stageStart)),
        });
      };
      const sendOutput = (streamName: "stdout" | "stderr", raw: Buffer): void => {
        if (outputBytes >= maximumStreamedOutputBytes) return;
        const remaining = maximumStreamedOutputBytes - outputBytes;
        const bytes = raw.subarray(0, remaining);
        outputBytes += bytes.byteLength;
        const text = bytes.toString("utf8");
        if (text) {
          send({ type: "process_output", stream: streamName, text, elapsedMs: elapsed() });
        }
      };

      const abortChild = (): void => {
        streamCancelled = true;
        globalThis.wordlessFixtureAuditChild?.kill("SIGTERM");
      };
      request.signal.addEventListener("abort", abortChild, { once: true });

      void (async () => {
        let stderr = "";
        const heartbeat = setInterval(() => {
          send({ type: "heartbeat", elapsedMs: elapsed() });
        }, 1_000);
        try {
          send({
            type: "run_started",
            startedAt: new Date(startedAtWall).toISOString(),
            elapsedMs: 0,
          });

          const preflightStart = stageStarted(
            "preflight",
            "Verify local fixture inputs",
            "Checking the fixed script and passed Module 0 benchmark paths.",
          );
          await Promise.all([
            access(fixtureScriptPath, constants.R_OK),
            access(benchmarkPath, constants.R_OK),
          ]);
          stageCompleted(
            "preflight",
            preflightStart,
            "The fixed fixture script and benchmark result are readable.",
          );

          const child = spawn(fixtureCommand.executable, [...fixtureCommand.arguments], {
            cwd: fixtureCommand.cwd,
            // Deliberately omit integration/API credential variables from the child.
            env: restrictedFixtureEnvironment(),
            stdio: ["ignore", "pipe", "pipe"],
          });
          globalThis.wordlessFixtureAuditChild = child;
          let timedOut = false;
          let forceStop: ReturnType<typeof setTimeout> | null = null;
          const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
          }, maximumAuditRuntimeMs);
          const progressParser = new FixtureProgressParser();
          const stderrDecoder = new StringDecoder("utf8");
          const progressState: { failure: RunFailure | null } = { failure: null };
          let stderrPending = "";
          const forwardProgress = (event: FixtureProgressEvent): void => {
            const definition = internalFixtureStages.find((stage) => stage.id === event.stageId);
            if (!definition) {
              progressState.failure = new RunFailure(
                "The fixture audit emitted an unknown internal stage.",
              );
              child.kill("SIGTERM");
              return;
            }
            if (event.event === "stage_started") {
              send({
                type: "stage_started",
                stageId: definition.id,
                label: definition.label,
                detail: definition.startedDetail,
                elapsedMs: elapsed(),
              });
              return;
            }
            send({
              type: "stage_completed",
              stageId: definition.id,
              detail: definition.completedDetail,
              elapsedMs: elapsed(),
              durationMs: event.durationMs,
            });
          };
          const forwardDiagnostic = (text: string): void => {
            if (!text) return;
            stderr = `${stderr}${text}`.slice(-maximumDiagnosticCharacters);
            sendOutput("stderr", Buffer.from(text, "utf8"));
          };
          const consumeStderrLine = (line: string, terminated: boolean): void => {
            if (line.startsWith(fixtureProgressPrefix)) {
              if (progressState.failure) return;
              try {
                forwardProgress(progressParser.parse(line.slice(fixtureProgressPrefix.length)));
              } catch (error) {
                progressState.failure = new RunFailure(
                  "The fixture audit emitted invalid internal progress.",
                  compactDiagnostic(error instanceof Error ? error.message : String(error)),
                );
                child.kill("SIGTERM");
              }
              return;
            }
            forwardDiagnostic(`${line}${terminated ? "\n" : ""}`);
          };
          const consumeStderr = (text: string, flush: boolean): void => {
            stderrPending += text;
            let newlineAt = stderrPending.indexOf("\n");
            while (newlineAt >= 0) {
              const line = stderrPending.slice(0, newlineAt).replace(/\r$/, "");
              stderrPending = stderrPending.slice(newlineAt + 1);
              consumeStderrLine(line, true);
              newlineAt = stderrPending.indexOf("\n");
            }
            if (stderrPending.length > maximumProgressLineCharacters) {
              if (stderrPending.startsWith(fixtureProgressPrefix)) {
                progressState.failure = new RunFailure(
                  "The fixture audit emitted an oversized internal progress event.",
                );
                child.kill("SIGTERM");
                stderrPending = "";
              } else {
                forwardDiagnostic(stderrPending);
                stderrPending = "";
              }
            }
            if (flush && stderrPending) {
              consumeStderrLine(stderrPending.replace(/\r$/, ""), false);
              stderrPending = "";
            }
          };
          child.stdout.on("data", (chunk: Buffer) => sendOutput("stdout", chunk));
          child.stderr.on("data", (chunk: Buffer) => {
            consumeStderr(stderrDecoder.write(chunk), false);
          });
          let result: Awaited<ReturnType<typeof waitForChild>>;
          try {
            result = await waitForChild(child);
          } finally {
            clearTimeout(timeout);
            if (forceStop) clearTimeout(forceStop);
          }
          consumeStderr(stderrDecoder.end(), true);
          globalThis.wordlessFixtureAuditChild = undefined;
          if (request.signal.aborted) {
            throw new RunFailure("The browser ended the local fixture run.");
          }
          if (progressState.failure) {
            throw progressState.failure;
          }
          if (result.code !== 0) {
            if (timedOut) {
              throw new RunFailure(
                "The fixture audit exceeded its 15-minute local runtime limit.",
                compactDiagnostic(stderr),
              );
            }
            const reason = result.signal
              ? `Process stopped by ${result.signal}.`
              : `Process exited with code ${result.code ?? "unknown"}.`;
            throw new RunFailure("The fixture audit process did not complete.", compactDiagnostic(`${reason}\n${stderr}`));
          }
          try {
            progressParser.assertComplete();
          } catch (error) {
            throw new RunFailure(
              "The fixture audit did not report every internal stage.",
              compactDiagnostic(error instanceof Error ? error.message : String(error)),
            );
          }

          const artifactStart = stageStarted(
            "artifacts",
            "Validate the generated artifacts",
            "Reading the exact local JSON and HTML outputs and checking the reported outcome counts.",
          );
          const [jsonInfo, htmlInfo] = await Promise.all([
            stat(fixtureReportJsonPath),
            stat(fixtureReportHtmlPath),
          ]);
          if (
            !jsonInfo.isFile() ||
            !htmlInfo.isFile() ||
            jsonInfo.size <= 0 ||
            htmlInfo.size <= 0 ||
            jsonInfo.size > maximumArtifactBytes ||
            htmlInfo.size > maximumArtifactBytes ||
            jsonInfo.mtimeMs < startedAtWall - 1_000 ||
            htmlInfo.mtimeMs < startedAtWall - 1_000
          ) {
            throw new RunFailure("The fixture process did not produce fresh, bounded report artifacts.");
          }
          const [jsonText, htmlText] = await Promise.all([
            readFile(fixtureReportJsonPath, "utf8"),
            readFile(fixtureReportHtmlPath, "utf8"),
          ]);
          let report: unknown;
          try {
            report = JSON.parse(jsonText) as unknown;
          } catch {
            throw new RunFailure("The generated report JSON could not be parsed.");
          }
          if (!htmlText.toLowerCase().includes("<!doctype html>")) {
            throw new RunFailure("The generated HTML artifact is not a complete document.");
          }
          const metrics = parseMetrics(report);
          stageCompleted(
            "artifacts",
            artifactStart,
            `Validated report.json and index.html for ${metrics.analyzed} analyzed interactions.`,
          );
          send({
            type: "run_completed",
            elapsedMs: elapsed(),
            artifacts: {
              reportUrl: "/demo-report",
              jsonPath: path.relative(repositoryRoot, fixtureReportJsonPath),
              htmlPath: path.relative(repositoryRoot, fixtureReportHtmlPath),
            },
            metrics,
          });
        } catch (error) {
          const failure = error instanceof RunFailure
            ? error
            : new RunFailure(
                "The local fixture audit could not be completed.",
                compactDiagnostic(error instanceof Error ? error.message : String(error)),
              );
          send({
            type: "run_failed",
            elapsedMs: elapsed(),
            message: failure.message,
            detail: failure.detail ?? compactDiagnostic(stderr),
          });
        } finally {
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", abortChild);
          globalThis.wordlessFixtureAuditChild = undefined;
          globalThis.wordlessFixtureAuditRunning = false;
          if (!streamCancelled) controller.close();
        }
      })();
    },
    cancel() {
      streamCancelled = true;
      globalThis.wordlessFixtureAuditChild?.kill("SIGTERM");
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
