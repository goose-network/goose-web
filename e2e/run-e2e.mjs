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

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(10_000);

// Helper: read the engine state straight through the app's own proxy, so the
// test asserts the UI against what the engine actually served.
async function api(path) {
  const res = await page.request.get(`${BASE}/api/${path.replace(/^\//, "")}`);
  assert.equal(res.status(), 200, `GET /api/${path} -> ${res.status()}`);
  return res.json();
}

await test("app loads and connects to the engine", async () => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  // The connection banner must report a working same-origin connection.
  await page.waitForSelector(".conn-banner .conn-dot.ok", { timeout: 5_000 });
  const msg = await page.locator(".conn-msg").innerText();
  assert.match(msg, /connected/, `connection banner says: ${msg}`);
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

  // Delete it again through the row's delete control.
  await page.locator(`tr:has-text('${id}') button.danger`).click();
  await page.waitForSelector(`tr:has-text('${id}')`, {
    state: "detached",
    timeout: 5_000,
  });
  const final = await api("inbounds");
  assert.ok(
    !final.some((i) => i.id === id),
    "deleted inbound still present on engine",
  );
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
  await page.locator("#prov-pool").fill(`pool-${id}`);
  await page.locator("#prov-url").fill("http://127.0.0.1:18080/example.com/");
  await page.click("button:has-text('Save')");
  await page.waitForSelector(`tr:has-text('${id}')`, { timeout: 5_000 });
  const after = await api("providers");
  assert.ok(
    after.some((p) => p.id === id && p.pool_id === `pool-${id}`),
    "created provider missing from engine",
  );

  // Delete it again through the row's delete control.
  await page.locator(`tr:has-text('${id}') button.danger`).click();
  await page.waitForSelector(`tr:has-text('${id}')`, {
    state: "detached",
    timeout: 5_000,
  });
  const final = await api("providers");
  assert.ok(
    !final.some((p) => p.id === id),
    "deleted provider still present on engine",
  );
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
    /Requests in range|Success rate|Avg latency/,
    "KPI tiles missing",
  );
  // At least one metric row or an explicit empty state must be present.
  assert.ok(
    /ok|failed|No metrics/.test(bodyText),
    "no metric rows and no empty state",
  );
});

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} e2e test(s) failed`);
  process.exit(1);
}
console.log("\nall e2e tests passed");
