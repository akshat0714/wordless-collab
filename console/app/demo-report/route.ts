import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const demoReportPath = resolve(process.cwd(), "..", "outputs", "demo-audit", "index.html");

export async function GET() {
  try {
    const report = await readFile(demoReportPath, "utf8");
    return new Response(report, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(
      "The generated demo report is unavailable. Run the fixture audit to create outputs/demo-audit/index.html.",
      {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
