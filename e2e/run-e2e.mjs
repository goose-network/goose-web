// e2e/run-e2e.mjs — real end-to-end test for goose-web.
//
// Boots nothing itself: expects a running goose engine admin API (behind the
// app's /api proxy) and the built app served at E2E_BASE_URL. Drives the real
// UI in headless Chromium via Playwright and asserts against the live engine.
//
// Run: node e2e/run-e2e.mjs  (E2E_BASE_URL defaults to http://127.0.0.1:4173)

import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4173";
const CHROME_PATH = process.env.CHROME_PATH;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(err);
  }
}

const browser = await chromium.launch(
  CHROME_PATH ? { executablePath: CHROME_PATH } : {},
);
const page = await browser.newPage();
page.setDefaultTimeout(10_000);

// Helper: read the engine state straight through the app's own proxy, so the
// test asserts the UI against what the engine actually served.
async function api(path) {
  const res = await page.request.get(`${BASE}/api/${path.replace(/^\//, "")}`);
  assert.equal(res.status(), 200, `GET /api/${path} -> ${res.status()}`);
  return res.json();
}

// Helper: deletes are two-step (click arms, click again confirms), so a
// single click must never remove anything.
async function confirmDelete(rowSelector) {
  const btn = page.locator(`${rowSelector} button.danger`).first();
  await btn.click();
  // Still there: the first click only arms the button.
  await page.waitForSelector(`${rowSelector} button.danger.armed`, { timeout: 5_000 });
  assert.ok(
    (await page.locator(rowSelector).count()) > 0,
    "first click deleted without confirming",
  );
  await page.locator(`${rowSelector} button.danger.armed`).first().click();
  await page.waitForSelector(rowSelector, { state: "detached", timeout: 5_000 });
}

await test("app loads and connects to the engine", async () => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  // The connection banner must report a working same-origin connection.
  await page.waitForSelector(".conn-banner .conn-dot.ok", { timeout: 5_000 });
  const msg = await page.locator(".conn-msg").innerText();
  assert.match(msg, /connected/, `connection banner says: ${msg}`);
});

await test("every route renders its page", async () => {
  const routes = [
    ["/", "Overview"],
    ["/inbounds", "Inbounds"],
    ["/outbounds", "Outbounds"],
    ["/pools", "Pools"],
    ["/chains", "Chains"],
    ["/providers", "Providers"],
    ["/exit-checks", "Exit IP"],
    ["/metrics", "Metrics"],
  ];
  for (const [path, title] of routes) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const h1 = await page.locator("main h1").innerText();
    assert.equal(h1.trim(), title, `${path} heading`);
  }
});

await test("unknown route shows a not-found page", async () => {
  await page.goto(`${BASE}/nope`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("main").innerText();
  assert.match(bodyText, /not found|No page/i, `404 body: ${bodyText}`);
});

await test("theme toggle switches to dark and back", async () => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator('button[aria-label="Dark theme"]').click();
  await page.waitForSelector('html[data-theme="dark"]');
  assert.equal(
    await page.locator('button[aria-label="Dark theme"]').getAttribute("aria-pressed"),
    "true",
  );
  await page.locator('button[aria-label="Light theme"]').click();
  await page.waitForSelector('html[data-theme="light"]');
});

await test("inbound from config is listed", async () => {
  await page.goto(`${BASE}/inbounds`, { waitUntil: "networkidle" });
  const inbounds = await api("inbounds");
  const bodyText = await page.locator("body").innerText();
  for (const inbound of inbounds) {
    assert.ok(
      bodyText.includes(inbound.id),
      `inbound ${inbound.id} not visible on /inbounds`,
    );
  }
});

await test("the form rejects a bad listen address before saving", async () => {
  await page.goto(`${BASE}/inbounds`, { waitUntil: "networkidle" });
  const id = `e2e-bad-${Date.now()}`;
  await page.click("button:has-text('New inbound')");
  await page.locator("#inb-id").fill(id);
  await page.locator("#inb-listen").fill("not-a-host");
  await page.click("button:has-text('Save')");
  await page.waitForSelector("#inb-listen-error", { timeout: 5_000 });
  assert.equal(
    await page.locator("#inb-id").getAttribute("aria-invalid"),
    null,
    "unrelated field marked invalid",
  );
  const after = await api("inbounds");
  assert.ok(
    !after.some((i) => i.id === id),
    "invalid inbound reached the engine",
  );
  // Cancel out of the form (twice: the dirty guard asks first).
  await page.click("form button:has-text('Cancel')");
  await page.click("form button:has-text('Discard changes?')");
  await page.waitForSelector("#inb-id", { state: "detached", timeout: 5_000 });
});

await test("create + delete an inbound through the UI", async () => {
  await page.goto(`${BASE}/inbounds`, { waitUntil: "networkidle" });
  const id = `e2e-in-${Date.now()}`;
  await page.click("button:has-text('New inbound')");
  await page.locator("#inb-id").fill(id);
  await page.locator("#inb-listen").fill("127.0.0.1:18081");
  await page.click("button:has-text('Save')");
  await page.waitForSelector(`tr:has-text('${id}')`, { timeout: 5_000 });
  const after = await api("inbounds");
  assert.ok(
    after.some((i) => i.id === id),
    "created inbound missing from engine",
  );

  // Delete it again through the row's two-step delete control.
  await confirmDelete(`tr:has-text('${id}')`);
  const final = await api("inbounds");
  assert.ok(
    !final.some((i) => i.id === id),
    "deleted inbound still present on engine",
  );
});

await test("table filter narrows the list client-side", async () => {
  await page.goto(`${BASE}/inbounds`, { waitUntil: "networkidle" });
  const inbounds = await api("inbounds");
  if (inbounds.length === 0) return; // nothing to filter on a fresh engine
  const id = inbounds[0].id;
  await page.locator("#inbound-filter").fill(id);
  const rows = page.locator("table.data tbody tr");
  const shown = await rows.count();
  assert.equal(shown, 1, `filter left ${shown} rows`);
  await page.locator("#inbound-filter").fill("zzz-no-such-inbound");
  await page.waitForSelector(".empty", { timeout: 5_000 });
  await page.locator("#inbound-filter").fill("");
});

await test("engine config form is live on the overview", async () => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("body").innerText();
  assert.match(bodyText, /Network stack/, "engine config fields missing");
  assert.match(bodyText, /Admin API listen/, "admin api field missing");
  const listen = await page.locator("#engine-api-listen").inputValue();
  assert.ok(listen.length > 0, "admin api listen input empty");
});

await test("create + delete a subscription provider through the UI", async () => {
  await page.goto(`${BASE}/providers`, { waitUntil: "networkidle" });
  const id = `e2e-sub-${Date.now()}`;
  await page.click("button:has-text('New provider')");
  await page.locator("#prov-id").fill(id);
  // Pool IDs is a list editor: add one entry and fill it.
  await page.click("button:has-text('Add pool')");
  await page.locator("#prov-pools").fill(`pool-${id}`);
  await page.locator("#prov-url").fill("http://127.0.0.1:18080/example.com/");
  await page.click("button:has-text('Save')");
  await page.waitForSelector(`tr:has-text('${id}')`, { timeout: 5_000 });
  const after = await api("providers");
  assert.ok(
    after.some(
      (p) => p.id === id && (p.pool_ids ?? []).includes(`pool-${id}`),
      "created provider missing from engine",
    ),
    `created provider missing from engine: ${JSON.stringify(after)}`,
  );

  // Delete it again through the row's two-step delete control.
  await confirmDelete(`tr:has-text('${id}')`);
  const final = await api("providers");
  assert.ok(
    !final.some((p) => p.id === id),
    "deleted provider still present on engine",
  );
});

await test("provider form shows per-plugin examples while configuring", async () => {
  await page.goto(`${BASE}/providers`, { waitUntil: "networkidle" });
  await page.click("button:has-text('New provider')");
  // Switching the plugin select must swap the inline guidance + example.
  for (const [plugin, marker] of [
    ["subscription", "generic subscription link"],
    ["psiphon", "zero configuration"],
    ["mihomo", "bundled mihomo core"],
    ["singbox", "three subscription dialects"],
  ]) {
    await page.locator("#prov-plugin").selectOption(plugin);
    const bodyText = await page.locator("main").innerText();
    assert.match(
      bodyText,
      new RegExp(marker),
      `plugin ${plugin} guidance missing (looked for ${marker})`,
    );
    assert.match(bodyText, /pool_ids/, `plugin ${plugin} example JSON missing pool_ids`);
  }
  // The form starts not-dirty, so the first Cancel click discards directly.
  await page.click("button:has-text('Cancel')");
});

await test("metrics page renders the dashboard", async () => {
  // Drive one proxied request through the engine first so metrics exist.
  // The engine's HTTP inbound rewrites the request to an absolute-form
  // target; http://example.com is fine for a direct outbound.
  const proxied = await page.request.get(
    "http://127.0.0.1:18080/example.com/",
    { maxRedirects: 0 },
  ).catch(() => null);
  console.log(`  (proxied request status: ${proxied?.status() ?? "n/a"})`);

  await page.goto(`${BASE}/metrics`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("body").innerText();
  assert.match(bodyText, /Metrics/, "metrics heading missing");
  assert.match(
    bodyText,
    /Requests in range|Success rate|Avg latency/i,
    "KPI tiles missing",
  );
  // At least one metric row or an explicit empty state must be present.
  assert.ok(
    /ok|failed|No metrics|No requests/.test(bodyText),
    "no metric rows and no empty state",
  );
});

await test("exit IP page renders checks or its empty state", async () => {
  await page.goto(`${BASE}/exit-checks`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("main").innerText();
  assert.match(bodyText, /Exit IP/, "exit IP heading missing");
  assert.ok(
    /Current exit IP per outbound|No exit-IP checks recorded yet/.test(bodyText),
    `neither table nor empty state: ${bodyText.slice(0, 200)}`,
  );
});

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} e2e test(s) failed`);
  process.exit(1);
}
console.log("\nall e2e tests passed");
