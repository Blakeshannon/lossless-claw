// Browser contract smoke test. Use a locally installed Playwright, or point
// LCM_PLAYWRIGHT_MODULE at an existing installation's index.mjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import(process.env.LCM_PLAYWRIGHT_MODULE || "playwright");
const output = process.env.LCM_UI_ARTIFACT_DIR || "/tmp/lossless-context-explorer-ui";
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const filename = req.url === "/index.js" ? "dist/control-ui/index.js" : req.url === "/index.css" ? "dist/control-ui/index.css" : null;
  if (filename) {
    res.setHeader("content-type", filename.endsWith(".css") ? "text/css" : "text/javascript");
    res.end(await readFile(resolve(filename))); return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/index.css"><style>
    :root{color-scheme:dark;--text:#dce5e9;--muted:#95a6b0;--card:#1b242b;--border:#303d45}
    body{margin:0;background:#151d24}main{width:400px;min-height:800px;margin:auto;border-inline:1px solid #303d45}
    </style></head><body><main id="panel"></main></body></html>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true, ...(process.env.LCM_BROWSER_PATH ? { executablePath: process.env.LCM_BROWSER_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 960 }, deviceScaleFactor: 2 });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-09-18T12:00:00Z") });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const plugin = (await import("/index.js")).default;
    const snapshot = {
      basis: "stored-active-context", capturedAt: new Date().toISOString(), conversationId: 1,
      summaryCount: 3, messageCount: 24, summaryTokens: 12420, messageTokens: 26000, nextOffset: null,
      summaries: [
        { summaryId: "sum_a83d2b", ordinal: 0, kind: "condensed", depth: 2, tokenCount: 6840,
          preview: "Context architecture & design decisions", earliestAt: "2026-09-14", latestAt: "2026-09-14T12:00:00Z", createdAt: "2026-09-16", descendantCount: 18, sourceMessageTokenCount: 186000 },
        { summaryId: "sum_c91e5f", ordinal: 1, kind: "condensed", depth: 1, tokenCount: 3920,
          preview: "Search semantics and session boundaries", earliestAt: "2026-09-16", latestAt: "2026-09-17T12:00:00Z", createdAt: "2026-09-17", descendantCount: 6, sourceMessageTokenCount: 52000 },
        { summaryId: "sum_f24a8c", ordinal: 2, kind: "leaf", depth: 0, tokenCount: 1660,
          preview: "A read-only explorer beside the conversation", earliestAt: "2026-09-18", latestAt: "2026-09-18T07:00:00Z", createdAt: "2026-09-18", descendantCount: 0, sourceMessageTokenCount: 12000 },
      ],
    };
    window.snapshot = snapshot; window.calls = []; window.fail = false; window.delay = false;
    const controller = new AbortController();
    const host = { connection: { connected: true }, ui: { registerPanel(panel) { window.panelDefinition = panel; return () => {}; } },
      async request(method, params) {
        window.calls.push({ method, ...params });
        if (window.fail) throw new Error("Network unavailable");
        if (window.delay) await new Promise(done => { window.release = done; });
        if (params.sessionKey === "agent:other:empty") return { ok: true, result: { ...snapshot, conversationId: null, summaryCount: 0, summaries: [] } };
        if (params.payload.summaryId) return { ok: true, result: { summaryId: params.payload.summaryId,
          content: "## Design discussion\nKeep the explorer session-scoped. Surface summary coverage and token estimates without implying these are the exact provider prompt.\n\n## Search decision\nPreserve the summary DAG and support read-only child inspection.\n\n<img src=x onerror=window.injected=true>",
          nextOffset: null, sourceMessages: 12,
          children: params.payload.summaryId === "sum_a83d2b" ? [{ summaryId: "sum_child", kind: "leaf", depth: 0 }] : [], childrenTruncated: false } };
        return { ok: true, result: snapshot };
      },
    };
    plugin.activate(host);
    window.ctx = { props: { sessionKey: "agent:main:example", agentId: "main" }, host, signal: controller.signal, presented: true };
    window.view = window.panelDefinition.mount(document.querySelector("#panel"), window.ctx);
    window.controller = controller;
  });
  await page.waitForSelector(".lcm-explorer__card");
  assert.equal(await page.locator(".lcm-explorer__card").count(), 3);
  assert.equal(await page.locator(".lcm-explorer__stats strong").first().textContent(), "3");
  assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).count(), 0);
  assert.deepEqual(await page.locator(".lcm-explorer__age").allTextContents(), ["4d", "1d", "5h"]);
  assert((await page.locator(".lcm-explorer__card").first().boundingBox()).height < 60);
  await page.locator(".lcm-explorer").screenshot({ path: resolve(output, "context-explorer.png") });
  await page.locator(".lcm-explorer__card > summary").first().click();
  await page.waitForSelector(".lcm-explorer__content");
  assert.match(await page.locator(".lcm-explorer__content").first().textContent(), /Design discussion/);
  assert.equal(await page.locator(".lcm-explorer img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator(".lcm-explorer__branch > summary").click();
  await page.waitForFunction(() => document.querySelectorAll(".lcm-explorer__content").length === 2);
  await page.screenshot({ path: resolve(output, "context-explorer-expanded.png"), fullPage: true });
  const calls = await page.evaluate(() => window.calls);
  assert(calls.every(call => call.method === "plugins.sessionAction" && call.agentId === "main" && call.sessionKey === "agent:main:example"));
  await page.clock.fastForward(3600000);
  await page.waitForFunction(() => document.querySelectorAll(".lcm-explorer__age")[2].textContent === "6h");
  await page.evaluate(() => { window.snapshot.messageCount++; });
  await page.clock.runFor(10000);
  await page.waitForFunction(() => document.querySelector(".lcm-explorer__tail").textContent.includes("25 recent"));
  assert.equal(await page.locator(".lcm-explorer__card[open]").count(), 1);
  assert.equal(await page.locator(".lcm-explorer__content").count(), 2, "polling preserves expanded details");
  await page.evaluate(() => { window.fail = true; });
  await page.clock.runFor(10000);
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("retrying"));
  assert.equal(await page.locator(".lcm-explorer__card").count(), 3);
  await page.evaluate(() => { window.fail = false; });
  await page.clock.runFor(10000);
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent === "");
  await page.evaluate(() => { window.view.update({ ...window.ctx, presented: false }); });
  const pausedCalls = await page.evaluate(() => window.calls.length);
  await page.clock.runFor(20000);
  assert.equal(await page.evaluate(() => window.calls.length), pausedCalls, "hidden panels do not poll");
  await page.evaluate(() => { window.delay = true; window.view.update(window.ctx); });
  await page.waitForFunction(() => typeof window.release === "function");
  await page.evaluate(() => {
    window.view.update({ ...window.ctx, props: { sessionKey: "agent:other:empty", agentId: "other" } });
    window.delay = false; window.release();
  });
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("not recorded"));
  assert.equal(await page.locator(".lcm-explorer__card").count(), 0, "old session's response must not repaint the new session");
  assert.equal((await page.evaluate(() => window.calls)).at(-1).agentId, "other");
  await page.evaluate(() => window.controller.abort());
  assert.equal(await page.locator(".lcm-explorer").count(), 0);
  const disposedCalls = await page.evaluate(() => window.calls.length);
  await page.clock.runFor(20000);
  assert.equal(await page.evaluate(() => window.calls.length), disposedCalls, "disposal stops polling");
  assert.deepEqual(errors, []);
  console.log(`PASS: compact layout, relative ages, automatic refresh/recovery, retained expansion, hidden-panel pause, text safety, session switching, disposal. Screenshots: ${output}`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
