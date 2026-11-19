// e2e/run-e2e.mjs — real end-to-end test for goose-web.
//
// Boots nothing itself: expects a running goose engine admin API (behind the
// app's /api proxy) and the built app served at E2E_BASE_URL. Drives the real
// UI in headless Chromium via Playwright and asserts against the live engine.
//
// Run: node e2e/run-e2e.mjs  (E2E_BASE_URL defaults to http://127.0.0.1:4173)

import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import http from "node:http";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4173";
// The engine's HTTP inbound, as declared in .github/workflows/ci.yml.
const ENGINE_INBOUND = process.env.E2E_PROXY_URL ?? "http://127.0.0.1:18080";
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

// Helper: one real request through the engine's HTTP inbound.
//
// The request-target has to be ABSOLUTE-form (`GET http://host/path`). With an
// origin-form target the inbound has nothing but the Host header to go on, so
// it derives the target from that — which names the inbound itself, and the
// request loops back into the engine instead of reaching a target. Playwright's
// request.get() always sends origin-form, so this goes through node's client,
// which puts a full URL on the request line when `path` is one.
function proxyGet(targetUrl, timeoutMs = 10_000) {
  const proxy = new URL(ENGINE_INBOUND);
  const target = new URL(targetUrl);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: proxy.hostname,
        port: proxy.port || 80,
        method: "GET",
        path: targetUrl,
        headers: { Host: target.host },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, error: "" }));
        res.on("error", (e) => resolve({ status: 0, error: String(e.message ?? e) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", (e) => resolve({ status: 0, error: String(e.message ?? e) }));
    req.end();
  });
}

// Helper: metric rows name the target as "host:port". Normalize whatever the
// engine recorded there so it can be compared against an origin.
function targetHost(t) {
  return String(t ?? "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/.*$/, "");
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
    ["/probes", "Reachability probe"],
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
  // The subscription URL must NOT point at the engine's own HTTP inbound
  // (ENGINE_INBOUND). The provider fetches this URL directly; aimed at the
  // inbound it loops back into the engine, which derives the target from the
  // origin-form request's Host header — the inbound itself — and self-loops.
  // Each attempt times out (10s) and the provider retries on a schedule, so a
  // single create floods /api/metrics with inbound-targeted rows (reproduced:
  // 10k+ rows, 168 MB db) that then bury the row the metrics test drives.
  // The app origin (BASE) is always up, never loops, and is what this CRUD
  // test actually needs: a well-formed URL the form accepts. The fetch lands
  // on the static server, finds no subscription nodes, and logs once.
  await page.locator("#prov-url").fill(`${BASE}/e2e-subscription-probe`);
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
  // Premise guard, checked rather than assumed: every "no proxy node"
  // assertion below only holds if the engine has no proxy outbound to ride.
  // A config that declares no providers gets the plugin-declared default
  // seeded (psiphon), and a seeded provider registers one outbound per server
  // it finds — all of which join the router's all-outbounds fallback, so a
  // dispatched request can legitimately ride one and record a proxy node.
  // ci.yml starts the engine with GOOSE_NO_DEFAULT_PROVIDER=1 to keep the
  // engine exactly as configured; this guard names the cause if that regresses
  // instead of leaving a baffling assertion about proxy nodes.
  const outbounds = await api("outbounds");
  assert.ok(Array.isArray(outbounds) && outbounds.length > 0, "engine reports no outbounds");
  const nonDirect = outbounds.filter((o) => o.protocol !== "direct");
  assert.deepEqual(
    nonDirect.map((o) => `${o.id}:${o.protocol}`),
    [],
    "engine has a non-direct outbound, so a request may legitimately ride it",
  );

  // Drive one proxied request through the engine first so metrics exist.
  // Target the app's own origin: it is always up in CI, needs no external
  // network, and gives the direct outbound something that answers.
  const appHost = new URL(BASE).host;
  const proxied = await proxyGet(`${BASE}/`);
  console.log(
    `  (proxied request status: ${proxied.status || "n/a"}${proxied.error ? ` ${proxied.error}` : ""})`,
  );

  // --- the observed path: wire first, then the pixels ---
  //
  // The wire assertion comes first on purpose: if the engine is not sending
  // `path` at all, the UI assertions below would only report a missing strip,
  // and the reason would be invisible. `path` is omitempty on the row, so a
  // build that predates the path recorder simply omits the key.
  //
  // The row is written as the request finishes, which can land a beat after
  // the response reaches us — poll for it instead of racing the store.
  //
  // Ask for a wide window: /api/metrics returns the newest n rows (default
  // 100), so anything else writing rows concurrently can push the one row
  // driven above out of view and report a missing path when the engine sent
  // one. Widening the window makes "not there yet" and "not there at all" the
  // only remaining explanations.
  let observed = [];
  let driven = [];
  for (let i = 0; i < 40 && driven.length === 0; i++) {
    const metricRows = await api("metrics?n=1000");
    assert.ok(Array.isArray(metricRows), "GET /api/metrics did not return a list");
    observed = metricRows.filter((m) => m.path && Array.isArray(m.path.nodes));
    driven = observed.filter((m) => targetHost(m.target) === appHost);
    if (driven.length === 0) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(observed.length > 0, "no metric row carried an observed path (`path.nodes`)");

  // Name the flood if it ever comes back, instead of leaving a bare "no row
  // for the driven request": rows targeting the engine's own inbound mean
  // something is fetching ENGINE_INBOUND, and each pass self-loops and records
  // again. The provider test above is the one that used to do this.
  const inboundHost = new URL(ENGINE_INBOUND).host;
  const looped = observed.filter((m) => targetHost(m.target) === inboundHost);
  assert.equal(
    looped.length,
    0,
    `${looped.length} metric rows target the engine's own inbound (${inboundHost}): ` +
      `something is fetching it, and each pass loops back in and records again`,
  );

  // The row for the request just driven: local, then the target, and nothing
  // in between. A direct route is the ABSENCE of a proxy, not a proxy called
  // "direct" — so a proxy node here is either an engine regression or the
  // request never reached this engine.
  assert.ok(
    driven.length > 0,
    `no metric row for the request driven to ${appHost} (saw targets: ${[
      ...new Set(observed.map((m) => m.target)),
    ].join(", ")})`,
  );
  for (const row of driven) {
    const ids = row.path.nodes.map((n) => n.id);
    const kinds = row.path.nodes.map((n) => n.kind);
    for (const kind of ["local", "target"]) {
      assert.ok(kinds.includes(kind), `path for ${row.target} has no ${kind} node (saw: ${ids.join(", ")})`);
    }
    assert.deepEqual(
      row.path.nodes.filter((n) => n.kind === "proxy").map((n) => n.id),
      [],
      `a direct-only engine recorded a proxy node for ${row.target}`,
    );
  }

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

  // The strip is what a reader sees first: every path starts at the engine
  // host, so the driven row's strip must name it.
  await page.waitForSelector(".path-strip", { timeout: 5_000 });
  // Scope the pixel assertions to the row the request above produced. Other
  // rows on the page are not the dispatch path this invariant is about — a
  // reachability or HTTP probe row names the server it dialed as a proxy node
  // even when that server is a direct outbound, because a probe's graph is
  // the route under test rather than a request's route.
  const row = page.locator(`tr:has(span[title="${appHost}"])`).first();
  await row.waitFor({ timeout: 5_000 });
  assert.match(
    await row.locator(".path-strip").innerText(),
    /local/,
    "the driven row's path strip does not mention the engine host",
  );

  // Same invariant, now on the pixels: the strip draws a chip per graph node,
  // so a proxy chip on this row means the UI invented a hop the wire never
  // carried (the guard above already ruled out the engine sending one).
  assert.equal(
    await row.locator(".path-strip .path-node.kind-proxy").count(),
    0,
    "a direct-only engine produced a proxy node on the driven row's strip",
  );

  // The folded pane holds what the strip has no room for: one row per leg.
  await row.locator(".path-detail summary").click();
  await row.locator(".path-legs .path-leg").first().waitFor({ timeout: 5_000 });

  // WHY there is no failover assertion here: multi-attempt paths come from
  // dialPoolSnapshot, which numbers its attempts as it walks a pool's members.
  // This CI engine is configured with one outbound ("direct-1") in one pool
  // ("pool-default"), so the attempt counter can never get past 1 and a graph
  // with a second attempt node is unreachable from a live run. Failover is not
  // left untested, it is untestable against THIS engine: shape (b) in
  // e2e/fixtures.mjs stubs a refused attempt 1 and a winning attempt 2 so the
  // strip and its pane have a multi-attempt graph to draw.
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

await test("a single exit-IP run works with the schedule untouched", async () => {
  await page.goto(`${BASE}/exit-checks`, { waitUntil: "networkidle" });
  const runCard = page.locator("main .card").first();
  const checkNow = runCard.locator("button.primary:has-text('Check now')");
  await checkNow.waitFor({ timeout: 5_000 });

  // A preset is one click from being in the list, and marks itself as being in
  // it — whether this click put it there or the engine config already had it.
  await runCard.locator("button.chip:has-text('ifconfig.me')").first().click();
  await runCard
    .locator("button.chip.on:has-text('ifconfig.me')")
    .first()
    .waitFor({ timeout: 5_000 });

  await checkNow.click();
  // Either this run's records, or a note saying the round is still going / the
  // engine has no run endpoint. Doing nothing at all is the failure.
  await runCard.locator("h3.card-sub, .notice").first().waitFor({ timeout: 40_000 });
  assert.match(
    await runCard.innerText(),
    // /i: the results heading is styled uppercase, and innerText reports the
    // rendered text.
    /This run|still running|round started|newer engine build|not wired a runner/i,
    "run card said nothing after Check now",
  );
});

await test("probe page renders the run form and a history or an explanation", async () => {
  await page.goto(`${BASE}/probes`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("main").innerText();
  assert.match(bodyText, /Reachability probe/, "probe heading missing");
  // The form is static, so it renders whatever the engine supports.
  assert.ok((await page.locator("#probe-method").count()) > 0, "method select missing");
  assert.ok((await page.locator("#probe-expect-status").count()) > 0, "assertion field missing");
  assert.ok(
    /No probes recorded yet|Showing \d+ of \d+|newer engine build|not wired a runner/.test(
      bodyText,
    ),
    `history has neither rows, an empty state, nor an explanation: ${bodyText.slice(-300)}`,
  );
});

await test("a probe run answers, or explains why it cannot", async () => {
  await page.goto(`${BASE}/probes`, { waitUntil: "networkidle" });
  await page.click("button:has-text('Add target')");
  await page.locator("#probe-targets").fill("https://www.gstatic.com/generate_204");
  await page.click("main button.primary:has-text('Probe now')");
  await page
    .locator("main h2:has-text('Results'), main .notice")
    .first()
    .waitFor({ timeout: 40_000 });
  assert.match(
    await page.locator("main").innerText(),
    /Results|newer engine build|not wired a runner/,
    "no results and no explanation after Probe now",
  );

  // A completed run draws each result's observed path in the results table.
  // The same escape hatches the assertion above tolerates apply here: an engine
  // build that has not wired a probe runner explains itself instead of running
  // the round, and a round that produced no rows renders its empty state rather
  // than a table — neither has a cell to hold a strip, so neither may turn CI
  // red.
  const mainText = await page.locator("main").innerText();
  const resultsCard = page.locator("main .card:has(h2:has-text('Results'))");
  if (
    !/newer engine build|not wired a runner/.test(mainText) &&
    (await resultsCard.count()) > 0 &&
    (await resultsCard.locator("tbody tr").count()) > 0
  ) {
    await resultsCard.locator(".path-strip").first().waitFor({ timeout: 5_000 });
  }
});

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} e2e test(s) failed`);
  process.exit(1);
}
console.log("\nall e2e tests passed");
