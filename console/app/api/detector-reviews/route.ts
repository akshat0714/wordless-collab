import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";

import {
  detectorIds,
  type DetectorReviewRecord,
  type DetectorReviewResponse,
  parseReviewMutation,
  parseStoredReviews,
} from "@/lib/detector-review-schema";
import {
  detectorReviewPath,
  wordlessStateDirectory,
} from "@/lib/local-runtime";
import { detectors } from "@/data/fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumReviewFileBytes = 16 * 1024;
const maximumRequestBytes = 2 * 1024;

type DetectorReviewFile = {
  version: 1;
  updatedAt: string;
  reviews: DetectorReviewRecord[];
};

declare global {
  // Serializes local file updates across route module reloads in one Next process.
  var wordlessDetectorReviewQueue: Promise<void> | undefined;
}

class RequestValidationError extends Error {}

function defaultReviews(): DetectorReviewRecord[] {
  return detectorIds.map((id) => {
    const detector = detectors.find((item) => item.id === id);
    if (!detector) throw new Error(`missing fixture detector ${id}`);
    return { id, status: "proposed", condition: detector.condition };
  });
}

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new RequestValidationError("cross-origin review writes are not allowed");
  }
}

function parseReviewFile(value: unknown): DetectorReviewFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("review file must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "reviews" ||
    keys[1] !== "updatedAt" ||
    keys[2] !== "version" ||
    record.version !== 1 ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new Error("review file metadata is invalid");
  }
  return {
    version: 1,
    updatedAt: record.updatedAt,
    reviews: parseStoredReviews(record.reviews),
  };
}

async function readReviewFile(): Promise<DetectorReviewFile | null> {
  try {
    const info = await lstat(detectorReviewPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumReviewFileBytes) {
      throw new Error("review file is not a bounded regular file");
    }
    const text = await readFile(detectorReviewPath, "utf8");
    return parseReviewFile(JSON.parse(text) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error("review file contains invalid JSON");
    }
    throw error;
  }
}

async function assertStateDirectory(): Promise<void> {
  await mkdir(wordlessStateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(wordlessStateDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(".wordless must be a local directory, not a symbolic link");
  }
  await access(wordlessStateDirectory, constants.R_OK | constants.W_OK);
}

async function atomicWriteReviewFile(file: DetectorReviewFile): Promise<void> {
  await assertStateDirectory();
  const text = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > maximumReviewFileBytes) {
    throw new Error("review file exceeds the local size limit");
  }
  const temporaryPath = `${detectorReviewPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, detectorReviewPath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function withReviewLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalThis.wordlessDetectorReviewQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.wordlessDetectorReviewQueue = previous.catch(() => undefined).then(() => current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function GET(): Promise<Response> {
  try {
    const file = await readReviewFile();
    const response: DetectorReviewResponse = {
      reviews: file?.reviews ?? defaultReviews(),
      source: file ? "file" : "defaults",
      updatedAt: file?.updatedAt ?? null,
    };
    return noStoreJson(response);
  } catch (error) {
    console.error("Could not read the bounded detector review file.", error);
    return noStoreJson(
      { error: "The local detector review file could not be read safely." },
      500,
    );
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new RequestValidationError("content type must be application/json");
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes) {
      throw new RequestValidationError("request body is too large");
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > maximumRequestBytes) {
      throw new RequestValidationError("request body is too large");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new RequestValidationError("request body must be valid JSON");
    }
    let mutation: DetectorReviewRecord;
    try {
      mutation = parseReviewMutation(payload);
    } catch (error) {
      throw new RequestValidationError((error as Error).message);
    }

    const response = await withReviewLock(async (): Promise<DetectorReviewResponse> => {
      const current = (await readReviewFile())?.reviews ?? defaultReviews();
      const reviews = current.map((review) =>
        review.id === mutation.id ? mutation : review,
      );
      const updatedAt = new Date().toISOString();
      await atomicWriteReviewFile({ version: 1, updatedAt, reviews });
      return { reviews, source: "file", updatedAt };
    });
    return noStoreJson(response);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return noStoreJson({ error: error.message }, 400);
    }
    console.error("Could not update the bounded detector review file.", error);
    return noStoreJson(
      { error: "The decision could not be saved to the local review file." },
      500,
    );
  }
}
