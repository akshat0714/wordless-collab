import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://wordless.example/", {
      headers: { accept: "text/html", host: "wordless.example", "x-forwarded-proto": "https" },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the complete public Wordless product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Wordless — Support that helps you find the words<\/title>/i);
  assert.match(html, /Support that helps you find the words/);
  assert.match(html, /Public synthetic demo/);
  assert.match(html, /No real account or support agent is connected/);
  assert.match(html, /Do not enter personal information/);
  assert.match(html, /I don’t know what to say/);
  assert.match(html, /concept vectors \+ typo similarity \+ current account evidence/i);
  assert.match(html, /One synthetic customer · current sample context/i);
  assert.match(html, /These are evidence signals, not message options/i);
  assert.match(html, /Zendesk pilot kit/i);
  assert.match(html, /English-only/i);
  assert.match(html, /Any English free-text message/i);
  assert.match(html, /Preview human handoff/);
  assert.match(html, /Add one decision before your bot replies/);
  assert.match(html, /uv run python scripts\/run_wordless\.py/);
  assert.match(html, /https:\/\/wordless-support\.magarwal-iit\.chatgpt\.site\/og\.png/);
  assert.match(html, /http-equiv="Content-Security-Policy"/i);
  assert.match(html, /name="referrer" content="no-referrer"/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/);
  assert.doesNotMatch(html, /live account context|production-ready|Zendesk-ready/i);
  assert.doesNotMatch(html, /wl_live_|signing-secret|WORDLESS_REALTIME_API_KEY/);
});

test("public root is exported without request-time rendering", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../dist/server/vinext-prerender.json", import.meta.url),
    "utf8",
  ));
  const root = manifest.routes.find((route) => route.route === "/");
  assert.equal(root?.status, "rendered");
  assert.equal(root?.revalidate, false);
});

test("public response carries a restrictive browser security boundary", async () => {
  const response = await render();
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
});

test("static export declares its restrictive hosting security boundary", async () => {
  const headers = await readFile(new URL("../dist/client/_headers", import.meta.url), "utf8");
  const html = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  assert.match(headers, /^\/\*/m);
  assert.match(headers, /Content-Security-Policy: .*frame-ancestors 'none'/);
  assert.match(headers, /Permissions-Policy: camera=\(\), geolocation=\(\)/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.match(headers, /Strict-Transport-Security: max-age=31536000/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /^\/assets\/\*/m);
  assert.match(headers, /max-age=31536000, immutable/);
  assert.match(html, /http-equiv="Content-Security-Policy"/i);
  assert.match(html, /name="referrer" content="no-referrer"/i);
});

test("public demo is browser-only and makes no credentialed request", async () => {
  const source = await readFile(new URL("../app/wordless-demo.tsx", import.meta.url), "utf8");
  const engine = await readFile(new URL("../app/concept-engine.ts", import.meta.url), "utf8");
  const humanIntent = await readFile(new URL("../app/human-request.ts", import.meta.url), "utf8");
  assert.match(source, /data-public-demo="browser-only"/);
  assert.match(source, /No login, diagnosis, account change, or message storage/);
  assert.match(source, /maxLength=\{500\}/);
  assert.match(source, /support is available any time in this demo/);
  assert.match(source, /latest tracking status/);
  assert.match(source, /verified email link/);
  assert.match(source, /No cancellation happens/);
  assert.match(source, /A person request always wins/);
  assert.match(source, /humanRequested\(message\) \? null : assistMessage/);
  assert.doesNotMatch(source, /aria-pressed|selectScenario|selectAccount/);
  assert.doesNotMatch(`${source}\n${engine}\n${humanIntent}`, /\bfetch\s*\(/);
  assert.doesNotMatch(`${source}\n${engine}\n${humanIntent}`, /localStorage|sessionStorage|document\.cookie|Authorization/);
});
