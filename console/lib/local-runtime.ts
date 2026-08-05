import path from "node:path";

const consoleRoot = process.cwd();

if (path.basename(consoleRoot) !== "console") {
  throw new Error(
    "Wordless console routes must run with the console directory as the working directory.",
  );
}

export const repositoryRoot = path.resolve(consoleRoot, "..");
export const fixtureScriptPath = path.join(repositoryRoot, "scripts", "run_fixture_audit.py");
export const benchmarkPath = path.join(repositoryRoot, "bench", "results", "benchmark.json");
export const fixtureReportJsonPath = path.join(
  repositoryRoot,
  "outputs",
  "demo-audit",
  "report.json",
);
export const fixtureReportHtmlPath = path.join(
  repositoryRoot,
  "outputs",
  "demo-audit",
  "index.html",
);
export const wordlessStateDirectory = path.join(repositoryRoot, ".wordless");
export const detectorReviewPath = path.join(
  wordlessStateDirectory,
  "detector-reviews.json",
);

export const fixtureCommand = Object.freeze({
  executable: "uv",
  arguments: ["run", "python", "scripts/run_fixture_audit.py", "--progress-jsonl"] as const,
  cwd: repositoryRoot,
});
