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

// Helper: write engine state the same way, for the fixtures a test needs the
// UI to have something to look at. Returns the body on success and asserts the
// status, so a fixture that failed to seed fails the test that asked for it
// rather than the assertion that depended on it.
async function apiPost(path, body) {
  const res = await page.request.post(`${BASE}/api/${path.replace(/^\//, "")}`, {
    data: body,
  });
  assert.ok(
    res.status() === 200 || res.status() === 201,
    `POST /api/${path} -> ${res.status()}`,
  );
  return res.status() === 204 ? null : res.json();
}

async function apiDelete(path) {
  const res = await page.request.delete(`${BASE}/api/${path.replace(/^\//, "")}`);
  assert.ok(
    res.status() === 200 || res.status() === 204,
    `DELETE /api/${path} -> ${res.status()}`,
  );
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

await test("outbound form shows per-protocol examples while configuring", async () => {
  await page.goto(`${BASE}/outbounds`, { waitUntil: "networkidle" });
  await page.click("button:has-text('New outbound')");
  // The example under Config (JSON) is whatever the selected protocol's
  // plugin parses: switching the protocol select must swap it. Markers are
  // exact substrings of the rendered note/JSON per src/pages/outboundExamples.ts.
  const hint = page.locator(".kv-editor:has(#out-config) .field-hint");
  for (const [protocol, marker] of [
    ["direct", "No config"],
    ["http", '"address": "proxy.example.com:8080"'],
    ["psiphon", '"tunnel": "psiphon"'],
    ["mihomo-vmess", '"type": "vmess"'],
    ["singbox-shadowsocks", '"cipher": "aes-256-gcm"'],
  ]) {
    await page.locator("#out-proto").selectOption(protocol);
    const hintText = await hint.innerText();
    assert.ok(
      hintText.includes(marker),
      `protocol ${protocol} example missing (looked for ${marker})`,
    );
  }
  // An empty editor offers to insert the example, filling the field with it.
  await page.locator("#out-proto").selectOption("http");
  await page
    .locator(".kv-editor:has(#out-config) button:has-text('Insert example')")
    .click();
  const inserted = JSON.parse(await page.locator("#out-config").inputValue());
  assert.equal(
    inserted.address,
    "proxy.example.com:8080",
    "inserted example lost its address",
  );
  // The inserted config made the draft dirty, so cancel is two-step.
  await page.click("form button:has-text('Cancel')");
  await page.click("form button:has-text('Discard changes?')");
  await page.waitForSelector("#out-config", { state: "detached", timeout: 5_000 });
});

await test("pool form shows selector and filter examples while configuring", async () => {
  await page.goto(`${BASE}/pools`, { waitUntil: "networkidle" });
  await page.click("button:has-text('New pool')");
  // The Selector params example is whatever the chosen strategy parses
  // (src/pages/poolExamples.ts).
  const selectorHint = page.locator(
    ".kv-editor:has(#pool-selector-params) .field-hint",
  );
  for (const [strategy, marker] of [
    ["random", "Takes no params"],
    ["sticky", '"key": "src+domain"'],
    ["leastlatency", '"tolerance_ms": 100'],
  ]) {
    await page.locator("#pool-selector").selectOption(strategy);
    const hintText = await selectorHint.innerText();
    assert.ok(
      hintText.includes(marker),
      `selector ${strategy} example missing (looked for ${marker})`,
    );
  }
  // Each filter row's Params example follows that row's filter type.
  await page.click("button:has-text('Add filter')");
  const filterHint = page.locator(".kv-editor:has(#filter-params-0) .field-hint");
  for (const [type, marker] of [
    ["location", '"exclude"'],
    ["latency", '"max_ms": 300'],
    ["protocol", '"allow"'],
  ]) {
    await page.locator("#filter-type-0").selectOption(type);
    const hintText = await filterHint.innerText();
    assert.ok(
      hintText.includes(marker),
      `filter ${type} example missing (looked for ${marker})`,
    );
  }

  // Both editors offer to insert what they show, and insert the strategy's own
  // shape — an example you can put in the field, not one you have to retype.
  await page.locator("#pool-selector").selectOption("sticky");
  await page
    .locator(".kv-editor:has(#pool-selector-params) button:has-text('Insert example')")
    .click();
  const selectorParams = JSON.parse(
    await page.locator("#pool-selector-params").inputValue(),
  );
  assert.equal(
    selectorParams.key,
    "src+domain",
    "inserted selector example lost its key",
  );
  await page.locator("#filter-type-0").selectOption("latency");
  await page
    .locator(".kv-editor:has(#filter-params-0) button:has-text('Insert example')")
    .click();
  const filterParams = JSON.parse(
    await page.locator("#filter-params-0").inputValue(),
  );
  assert.equal(
    filterParams.max_ms,
    300,
    "inserted filter example lost its max_ms",
  );

  await page.click("form button:has-text('Cancel')");
  await page.click("form button:has-text('Discard changes?')");
  await page.waitForSelector("#pool-id", { state: "detached", timeout: 5_000 });
});

await test("outbound editor opens inline under its row, not at the top", async () => {
  // "Under its row" needs a row after it to mean anything: with the single
  // outbound the CI fixture declares, an editor appended to the end of the
  // tbody would also sit "under" that row. So the test seeds a second one and
  // takes it away again whatever happens below.
  const fixture = "e2e-inline-editor-row";
  await apiPost("outbounds", { id: fixture, protocol: "direct", config: {} });
  try {
    await page.goto(`${BASE}/outbounds`, { waitUntil: "networkidle" });
    const outbounds = await api("outbounds");
    assert.ok(outbounds.length >= 2, "the fixture outbound did not reach the engine");
    const id = outbounds[0].id;
    const row = `table.data tbody tr:not(.editor-row):has-text('${id}')`;

    await page.locator(`${row} button:has-text('Edit')`).click();
    // The editor belongs to the row: it renders in a full-width cell directly
    // under it, and the row itself is marked as the one being edited. The
    // sibling combinator is what pins "directly under" — the fixture row is
    // there to be between them if it is not.
    const editor = page.locator(`table.data tbody tr.editor-row .form-inline`);
    await editor.waitFor({ timeout: 5_000 });
    assert.equal(await editor.count(), 1, "more than one inline editor opened");
    assert.equal(
      await page.locator(`${row}.editing`).count(),
      1,
      `row ${id} is not marked as editing`,
    );
    assert.equal(
      await page.locator("table.data tbody tr.editing + tr.editor-row").count(),
      1,
      "the editor row does not sit directly under the row it edits",
    );
    // Nothing at the top of the page: a create has no row to sit under, so the
    // card variant is for creates — an edit that renders there too would be the
    // behaviour this test exists to rule out. `role="region"` is FormCard's own
    // marker; the table's wrapper is a plain .card, and while an editor is open
    // inline that wrapper does contain #out-id.
    const topCard = page.locator(`main .card[role="region"]:has(#out-id)`);
    assert.equal(
      await topCard.count(),
      0,
      "editing opened the top-of-page card instead of the row",
    );
    // The editor is under the row it edits, not above it.
    const rowBox = await page.locator(row).first().boundingBox();
    const editorBox = await editor.boundingBox();
    assert.ok(rowBox && editorBox, "row or editor has no box");
    assert.ok(
      editorBox.y > rowBox.y,
      `inline editor at y=${editorBox.y} is not under its row at y=${rowBox.y}`,
    );
    assert.equal(
      await page.locator(`${row} button[aria-expanded="true"]`).count(),
      1,
      "the edited row's Edit button does not report itself expanded",
    );

    // The draft still holds what the engine has, so saving writes it straight
    // back. Saving is also the only way this test can prove the inline form
    // submits at all: the <form> lives inside a full-width <td>, and nothing
    // else here would notice if the wiring were lost there.
    assert.equal(await page.locator("#out-id").inputValue(), id);
    const saved = outbounds.find((o) => o.id === id);
    await editor.locator("form button:has-text('Save')").click();
    await page.waitForSelector("table.data tbody tr.editor-row", {
      state: "detached",
      timeout: 5_000,
    });
    assert.equal(
      await page.locator("table.data tbody tr.editor-row").count(),
      0,
      "saving left the editor row behind",
    );
    const after = await api("outbounds");
    const kept = after.find((o) => o.id === id);
    assert.ok(kept, `saving lost ${id}`);
    assert.equal(kept.protocol, saved.protocol, "saving changed the protocol");

    // Reopen to walk the close path: OutboundsPage hands FormCard `dirty`
    // unconditionally, so cancelling is two-step — Cancel arms, the armed
    // button confirms.
    await page.locator(`${row} button:has-text('Edit')`).click();
    await editor.waitFor({ timeout: 5_000 });
    await editor.locator("form button:has-text('Cancel')").click();
    await editor.locator("form button:has-text('Discard changes?')").click();
    await page.waitForSelector(`#out-id`, { state: "detached", timeout: 5_000 });
    assert.equal(
      await page.locator("table.data tbody tr.editor-row").count(),
      0,
      "cancelling left the editor row behind",
    );

    // A create has no row, so it stays the card at the top — and it must not
    // take a row with it.
    await page.click("button:has-text('New outbound')");
    const card = topCard;
    await card.waitFor({ timeout: 5_000 });
    assert.equal(
      await page.locator("table.data tbody tr.editor-row").count(),
      0,
      "a create rendered an inline editor",
    );
    await card.locator("form button:has-text('Cancel')").click();
    await card.locator("form button:has-text('Discard changes?')").click();
    await page.waitForSelector(`#out-id`, { state: "detached", timeout: 5_000 });
  } finally {
    await apiDelete(`outbounds/${fixture}`);
  }
});

await test("chain layers are picked from the engine's pools and outbounds", async () => {
  await page.goto(`${BASE}/chains`, { waitUntil: "networkidle" });
  const [pools, outbounds] = [await api("pools"), await api("outbounds")];
  const poolIds = pools.map((p) => p.id).filter(Boolean);
  const outboundIds = outbounds.map((o) => o.id).filter(Boolean);
  if (poolIds.length === 0 && outboundIds.length === 0) return; // nothing to pick

  const id = `e2e-chain-${Date.now()}`;
  await page.click("button:has-text('New chain')");
  await page.locator("#chain-id").fill(id);

  // A layer is a picker, not a free-text field: the point is that the reader
  // cannot commit an id the engine has nothing behind. The row is a
  // FilterSelect combobox — typing filters the engine's own choices, and a
  // query that names nothing offers nothing to commit.
  await page.click("button:has-text('Add layer')");
  const layer = page.locator("#chain-layers");
  // The catalog may still be in flight when the row first renders (text-input
  // mode); wait for the picker it becomes once the choices arrive.
  await page.locator("#chain-layers[role=combobox]").waitFor({ timeout: 5_000 });
  assert.equal(
    await page.locator(".arr-editor:has(#chain-layers) .filter-select").count(),
    1,
    "the layer row is not a filterable picker",
  );

  // The choices are the engine's own, grouped, so the reader can tell a pool
  // from an outbound — the value is a bare id either way (the option labels
  // are the ids themselves).
  await layer.click();
  await page.locator("#chain-layers-listbox").waitFor({ timeout: 5_000 });
  const optionLabels = await page
    .locator("#chain-layers-listbox .fs-option-label")
    .evaluateAll((els) => els.map((e) => e.textContent));
  const groupLabels = await page
    .locator(".fs-panel .fs-group")
    .evaluateAll((gs) => gs.map((g) => g.textContent));
  for (const pid of poolIds) {
    assert.ok(optionLabels.includes(pid), `pool ${pid} is not a layer choice`);
  }
  // An outbound whose id is also a pool's is shadowed by that pool — the engine
  // resolves it to the pool, so offering both would offer a choice that does
  // not exist.
  const poolSet = new Set(poolIds);
  for (const oid of outboundIds.filter((o) => !poolSet.has(o))) {
    assert.ok(optionLabels.includes(oid), `outbound ${oid} is not a layer choice`);
  }
  assert.ok(groupLabels.includes("Pools") || poolIds.length === 0, "no Pools group");
  assert.ok(
    groupLabels.includes("Outbounds") ||
      outboundIds.filter((o) => !poolSet.has(o)).length === 0,
    "no Outbounds group",
  );

  // The free-text guard the select enforced by construction: typing an id the
  // engine has nothing behind narrows to "No matches.", and Enter commits
  // nothing (allowCustom is off for layers). Esc then restores the unchosen
  // trigger — proof the draft never took the typed text.
  await layer.fill("e2e-no-such-route-xyz");
  await page.waitForSelector(".fs-panel .fs-none", { timeout: 5_000 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");

  // The negative path, taken while the row "Add layer" just pushed is still
  // unchosen (its value is ""): the save has to be blocked HERE, not accepted
  // and shortened. Nothing downstream would catch it. The engine stores the
  // layer list verbatim — SetChain cleans nothing, and POST /api/chains echoes
  // the "" straight back at 201 (internal/config/store.go) — and only skips the
  // ref it cannot resolve later, when it BUILDS the chain ("unknown references
  // are skipped; the chain keeps its order", internal/router/router.go). So the
  // stored chain keeps the hop the reader left blank while the chain traffic
  // rides does not, and no error anywhere says so.
  // ChainsPage.chainLayerProblem returns the token that refuses it, and
  // useResource.save returns before it ever calls the API.
  assert.equal(
    await layer.inputValue(),
    "(choose a pool or outbound)",
    "premise: the row 'Add layer' pushed should still be unchosen",
  );
  // Scoped by the ID field, not the layers editor: the editor's only row (and
  // with it #chain-layers) is what the empty-list branch below removes, while
  // #chain-id lives as long as the draft does.
  const form = "form:has(#chain-id)";
  const blankNotice = `${form} .notice[role="alert"]:has-text("left unchosen")`;
  const emptyNotice = `${form} .notice[role="alert"]:has-text("Add at least one layer")`;
  await page.click("form button:has-text('Save')");
  await page.waitForSelector(blankNotice, { timeout: 5_000 });
  assert.match(
    await page.locator(blankNotice).innerText(),
    /remove the row/,
    "the blocked save did not say what to do about the unchosen row",
  );
  // Still open: a blocked save leaves the draft where the reader put it, so the
  // Notice can be acted on instead of having to start over.
  assert.ok(
    (await page.locator("#chain-layers").count()) > 0,
    "the blocked save closed the form",
  );
  // The load-bearing half: nothing reached the engine. A Notice alone would
  // also be consistent with a POST the server rejected, and this is the case
  // where the server would NOT have rejected it.
  assert.ok(
    !(await api("chains")).some((c) => c.id === id),
    `the blocked save created ${id} on the engine anyway`,
  );
  // … and nothing claimed success. Scoped to this id, so a toast still fading
  // from an earlier test cannot trip it.
  assert.equal(
    await page.locator(`.toast-stack .toast:has-text("${id}")`).count(),
    0,
    "the blocked save reported itself as saved",
  );

  // The same guard's other arm. chainLayerProblem answers "layers" for an empty
  // list BEFORE it looks for a blank one, because a reader who removed every
  // row has to be told to add one — the unchosen-row Notice would explain a row
  // they can no longer see. Exactly one of the two may show.
  await page
    .locator(`${form} button[aria-label="Remove Layers (in order) entry 1"]`)
    .click();
  await page.waitForSelector("#chain-layers", { state: "detached", timeout: 5_000 });
  await page.click("form button:has-text('Save')");
  await page.waitForSelector(emptyNotice, { timeout: 5_000 });
  await page.waitForSelector(blankNotice, { state: "detached", timeout: 5_000 });
  assert.ok(
    (await page.locator("#chain-id").count()) > 0,
    "the blocked empty-chain save closed the form",
  );
  assert.ok(
    !(await api("chains")).some((c) => c.id === id),
    `the blocked empty-chain save created ${id} on the engine anyway`,
  );

  // Put the row back, so the happy path below still has one to pick into.
  await page.click("button:has-text('Add layer')");
  await page.waitForSelector("#chain-layers", { timeout: 5_000 });

  // Pick the pool when there is one, else the first outbound, and save it.
  // The option's label is the bare id; click its row in the open box.
  const picked = poolIds[0] ?? outboundIds[0];
  await layer.click();
  await page
    .locator(`#chain-layers-listbox .fs-option:has(.fs-option-label:text-is("${picked}"))`)
    .click();
  await page.click("form button:has-text('Save')");
  await page.waitForSelector(`tr:has-text('${id}')`, { timeout: 5_000 });
  const after = await api("chains");
  const saved = after.find((c) => c.id === id);
  assert.ok(saved, "created chain missing from engine");
  assert.deepEqual(saved.layers, [picked], `chain saved layers ${saved.layers}`);

  // Editing it back keeps the stored layer chosen — the closed trigger shows
  // the stored id (its option's label); a picker that lost it would render the
  // placeholder, and saving that would silently shorten the chain.
  await page
    .locator(`table.data tbody tr:not(.editor-row):has-text('${id}') button:has-text('Edit')`)
    .click();
  await page.locator("#chain-layers").waitFor({ timeout: 5_000 });
  assert.equal(
    await page.locator("#chain-layers").inputValue(),
    picked,
    "editing lost the stored layer",
  );
  // ChainsPage passes FormCard `dirty` unconditionally, so Cancel is two-step.
  await page.click("form button:has-text('Cancel')");
  await page.click("form button:has-text('Discard changes?')");
  await page.waitForSelector("#chain-layers", { state: "detached", timeout: 5_000 });

  await confirmDelete(`tr:has-text('${id}')`);
  const final = await api("chains");
  assert.ok(!final.some((c) => c.id === id), "deleted chain still on engine");
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

  // WHY this row has no attempt to number: it is a DISPATCH, and the dispatch
  // path picks one member per chain layer and dials that one. Attempt numbering
  // comes from dialPoolSnapshot, which only a pool ROUTE dial walks
  // (internal/router/upstream.go) — so it is a route-dial fact, not something
  // every row can carry.
  //
  // It is not unreachable from a live run, and the run that reaches it is
  // asserted below rather than excused here: "a pool round that fails over
  // numbers every dial it made" drives a round through the fixture's
  // repeated-member pool and checks both attempts on the wire and on the pixels.
  // shape (b) in e2e/fixtures.mjs covers the half a round where nothing won
  // cannot: a failover with a WINNER, where the strip takes the attempt that got
  // through and the pane keeps the one that did not.
});

await test("a pool round that fails over numbers every dial it made", async () => {
  // The premise, computed rather than assumed: attempts only get numbered when a
  // pool BUILDS more than one member, and the router builds one member per id it
  // can resolve without deduping (internal/router/router.go appends every `ok`
  // hit), so pool-default's repeated direct-1 builds two candidates out of a
  // single server. ProbesPage.poolChipGroups dedupes the very same list for the
  // chip badge the probe test below reads — the picker counts distinct routes to
  // probe, the router counts dials to try, and only the second can fail over.
  const [pools, outbounds] = [await api("pools"), await api("outbounds")];
  const configured = new Set(outbounds.map((o) => o.id).filter(Boolean));
  const failover = pools
    .filter((p) => typeof p?.id === "string" && p.id !== "")
    .map((p) => ({
      ref: `pool:${p.id}`,
      // What the router builds: every declared id that resolves, repeats kept.
      built: (Array.isArray(p.outbound_ids) ? p.outbound_ids : []).filter((id) =>
        configured.has(id),
      ),
    }))
    .find((p) => p.built.length > 1);
  assert.ok(
    failover !== undefined,
    "no pool builds to more than one member, so no live round can fail over — " +
      '.github/workflows/ci.yml declares pool-default as ["direct-1","direct-1",' +
      '"e2e-not-configured"] for exactly this',
  );

  // Port 9 (discard) is closed here and on the CI runner, so every dial is
  // refused in microseconds: no external network, no dial timeout to wait out,
  // and a failure the pool has to walk PAST rather than stop at.
  const target = "http://127.0.0.1:9/";
  const ran = await apiPost("probes/run", {
    routes: [failover.ref],
    targets: [target],
    method: "GET",
    timeout_seconds: 5,
  });
  const row = Array.isArray(ran) ? ran.find((r) => r?.route === failover.ref) : undefined;
  assert.ok(row !== undefined, `POST /api/probes/run returned no row for ${failover.ref}`);
  assert.equal(
    row.success,
    false,
    `${target} answered, so the round proved nothing about failover — the target has to refuse`,
  );

  // --- the wire first: one proxy node per dial, numbered from 1 ---
  const nodes = row.path?.nodes ?? [];
  const attempts = nodes.filter((n) => n.kind === "proxy").map((n) => n.attempt);
  assert.deepEqual(
    attempts,
    failover.built.map((_, i) => i + 1),
    `${failover.ref} built ${failover.built.length} member(s) but recorded attempts [${attempts}]`,
  );

  // --- then the pixels, on the card that keeps every recorded round ---
  await page.goto(`${BASE}/probes`, { waitUntil: "networkidle" });
  const history = page.locator("main .card:has(h2:has-text('History'))");
  await history.waitFor({ timeout: 10_000 });
  // Narrow to this route, then take the newest: the History table is newest
  // first, and the route filter is what keeps an earlier round's row from being
  // read as this one's. The dropdown is built from the rows the fetch brought
  // back, so wait for the option rather than racing the request — "attached",
  // because an <option> inside a closed <select> is never "visible".
  await page.waitForSelector(
    `#probe-history-route option[value="${failover.ref}"]`,
    { state: "attached", timeout: 10_000 },
  );
  await history.locator("#probe-history-route").selectOption(failover.ref);
  const hrow = history.locator("tbody tr", { hasText: target }).first();
  await hrow.locator(".path-strip").waitFor({ timeout: 10_000 });

  // The strip draws ONE attempt, not both: buildPathView takes the leg that
  // actually carried the request onward and, when none did, the LAST one — the
  // furthest attempt the row got to (pathGraph.ts, pinned by pathGraph.test.ts's
  // "takes the last attempt when none of them succeeded"). So attempt 2 is the
  // chip and attempt 1 is pane material.
  const chips = hrow.locator(".path-strip .path-node.kind-proxy");
  assert.equal(
    await chips.count(),
    1,
    "the strip drew a chip per attempt instead of the one the row gave up on",
  );
  assert.equal(
    await chips.first().locator("sup.path-attempt").innerText(),
    String(failover.built.length),
    "the strip's proxy chip is not the last attempt",
  );
  // Nothing arrived, so the chip is muted: `reached` means a SUCCESSFUL leg
  // pointed at this node, and no leg did.
  assert.match(
    (await chips.first().getAttribute("class")) ?? "",
    /\bunreached\b/,
    "a dial that was refused drew as an arrival",
  );

  // The pane's headline counts the dials before it lists them, which is the only
  // place a reader learns the pool tried twice without opening anything.
  assert.match(
    await hrow.locator(".path-detail summary").innerText(),
    new RegExp(
      `${failover.built.length} legs · ${failover.built.length} failed`,
    ),
    "the pane's headline did not count every dial",
  );
  await hrow.locator(".path-detail summary").click();
  await hrow.locator(".path-legs .path-leg").first().waitFor({ timeout: 5_000 });

  const legs = hrow.locator(".path-legs .path-leg");
  assert.equal(
    await legs.count(),
    failover.built.length,
    "the pane did not keep one leg per dial",
  );
  // Every attempt but the strip's stays in the pane, marked off-strip in the
  // class as well as in words — colour is not the only signal, and neither is
  // the strip.
  const offStrip = hrow.locator(".path-legs .path-leg.off-strip");
  assert.equal(
    await offStrip.count(),
    failover.built.length - 1,
    "every attempt but the strip's belongs in the pane as off-strip",
  );
  assert.match(
    await offStrip.first().innerText(),
    /not shown on the path above/,
    "the off-strip leg does not say it is off the strip",
  );
  // And the loser keeps its own explanation rather than inheriting the row's:
  // the classified words plus the engine's raw error, which is what tells two
  // dials of the SAME server apart when their labels are identical.
  assert.ok(
    (await offStrip.first().locator(".path-leg-why").innerText()).trim() !== "",
    "the losing leg lost its classified failure",
  );
  assert.equal(
    await offStrip.first().locator(".path-leg-err").count(),
    1,
    "the losing leg lost the engine's raw error",
  );

  // The node table is the one view where both attempts are visible together, so
  // it has to list every node the engine recorded — including the target no leg
  // ever reached — and number the ones that were one of several.
  assert.equal(
    await hrow.locator(".path-nodes tbody tr").count(),
    nodes.length,
    "the node table drew a row for something the engine did not record, or dropped one it did",
  );
  assert.deepEqual(
    (await hrow.locator(".path-nodes tbody tr td.num").allInnerTexts())
      .filter((n) => n !== "—")
      .sort(),
    failover.built.map((_, i) => String(i + 1)),
    "the node table did not number every attempt",
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

await test("an exit-IP run with nothing selected is refused, not sent as every outbound", async () => {
  await page.goto(`${BASE}/exit-checks`, { waitUntil: "networkidle" });
  const runCard = page.locator("main .card").first();
  const group = '[aria-labelledby="run-outbounds-label"]';
  const chipSel = (ref) => `${group} label.chip:has(span:text-is("${ref}"))`;
  const allSel = `${group} label.chip:has-text("every outbound")`;
  // This card-head carries two pills — the site count, then the selection word
  // (ExitChecksPage.tsx:474-483) — so the one under test is the second.
  const pill = runCard.locator(".card-head .pill").nth(1);
  // The refusal renders INSIDE the field: FieldGroup puts its children in the
  // role=group box and the page renders this Notice as one of them, so it is
  // scoped by the group rather than hunted for in the card.
  const notice = runCard.locator(`${group} .notice[role="alert"]`);
  const checkNow = runCard.locator("button.primary:has-text('Check now')");
  await checkNow.waitFor({ timeout: 5_000 });

  // The ids exactly as the picker builds them (ExitChecksPage.tsx:335-342):
  // blank and absent ids dropped, then sorted, so "the first chip" is a
  // deterministic one on any engine.
  const ids = (await api("outbounds"))
    .map((o) => o.id)
    .filter((id) => typeof id === "string" && id !== "")
    .sort();
  assert.ok(ids.length > 0, "engine reports no outbound for the run card to offer");
  const first = ids[0];
  // Wait for the picker's own chips instead of trusting an empty box: while the
  // outbound list is in flight "no chip is checked" passes for the wrong reason
  // and the recovery click at the end has nothing to click.
  await page.waitForSelector(chipSel(first), { timeout: 10_000 });

  // Past FILTER_AT the picker hides unmatched chips behind its filter box, so a
  // chip is only clickable once it is on screen (ChipPicker.tsx:210). CI has one
  // outbound and therefore no box; this keeps the click honest on a fleet.
  const filterBox = runCard.locator("#run-outbounds-filter");
  const pick = async (ref) => {
    if ((await filterBox.count()) > 0) await filterBox.fill(ref);
    await runCard.locator(chipSel(ref)).click();
  };
  const checked = async (sel) =>
    (await runCard.locator(sel).count()) > 0 &&
    (await runCard.locator(`${sel} input`).first().isChecked());
  // The engine's own answer, read the way the page reads it
  // (goose.listExitChecks({ n }) → GET /api/exit-checks?n=…). "Nothing was
  // recorded" has to come from the engine, not from a history table that simply
  // has not refreshed yet — and the shape is checked, because `undefined ===
  // undefined` would pass a comparison of two answers that were not lists.
  const history = async () => {
    const rows = await api("exit-checks?n=1000");
    assert.ok(
      Array.isArray(rows) || rows === null,
      `GET /api/exit-checks answered neither a list nor null: ${JSON.stringify(rows).slice(0, 120)}`,
    );
    // The window AND its newest row, because a count alone goes blind once the
    // history is deeper than n=1000: a row written then pushes one off the end
    // and the count never moves. Rows come back newest first — that is why the
    // page can pass items[0]?.id as its own baseline — so an id that moved is a
    // round that recorded.
    return [rows?.length ?? 0, rows?.[0]?.id ?? null];
  };
  // Read until the history stops moving, one second apart. The test
  // above ends with a round that may still be running — the engine hands a slow
  // one back at 202 and its rows land on the engine's schedule, not this test's
  // (ExitChecksPage.rowsSince exists because of exactly that). A baseline taken
  // mid-write moves by itself, and would blame this test's click for somebody
  // else's round; a fixed sleep instead would have to guess how slow "slow" is.
  // Whether it settled is RETURNED rather than assumed, for the same reason: a
  // reading that never stopped moving cannot support "nothing was recorded",
  // and saying so beats pointing the failure at the click below. The cap is
  // generous because a settled history returns on the first poll — only one
  // still writing spends the time, and that is the case where waiting is the
  // point. Returns [rows, newestId, settled].
  const settledHistory = async () => {
    let n = await history();
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1_000);
      const again = await history();
      if (JSON.stringify(again) === JSON.stringify(n)) return [...n, true];
      n = again;
    }
    return [...n, false];
  };
  // Counted in the box, not read off the pill: the all-chip renders in its own
  // grid, so this selector sees individual chips only.
  const checkedCount = async () =>
    await runCard.locator(`${group} .chip-scroll label.chip.on`).count();

  // A fresh form is in all-mode, which is the state that CAN go on the wire:
  // `exitip.RunSpec.Outbounds` is omitempty, so an absent list is what the engine
  // reads as "every address-bearing built outbound".
  assert.ok(await checked(allSel), "all-chip not checked on a fresh form");
  assert.match(await pill.innerText(), /every outbound/, "pill does not say every outbound");
  assert.equal(await checkedCount(), 0, "a fresh all-mode form had an outbound chip checked");
  assert.ok(await checkNow.isEnabled(), "'Check now' disabled on a fresh form");

  // Unchecking "every outbound" leaves nothing selected — the one state the wire
  // has no form for, because an empty list reads as all-mode at the other end
  // (checkSites.exitRunOutbounds returns null rather than []).
  await runCard.locator(`${allSel} input`).click();
  await page.waitForSelector(`${allSel}.on`, { state: "detached", timeout: 5_000 });
  assert.match(await pill.innerText(), /no outbounds/, "pill does not say no outbounds");
  assert.equal(await checkedCount(), 0, "unchecking all-mode left an outbound chip checked");
  await page.waitForSelector(`${group} .notice[role="alert"]`, { timeout: 5_000 });
  // Whitespace-blind on both sides: innerText reports the RENDERED text, so it
  // carries a break wherever the notice wrapped (and `overflow-wrap: anywhere`
  // can put one inside a word), while the title attribute is the raw string.
  const said = (await notice.innerText()).replace(/\s+/g, "");
  assert.match(said, /Nooutboundselected/, `the field did not explain itself: ${said}`);
  assert.match(
    said,
    /emptylistwouldmeaneveryoneofthem/,
    `the Notice did not say why the state is refused: ${said}`,
  );
  assert.ok(await checkNow.isDisabled(), "'Check now' still enabled with nothing selected");
  // The button says why it is dead, not just that it is: title is the same string
  // the field carries (ExitChecksPage.tsx:489, `title={runProblem?.message}`),
  // so a reader who never looks down at the box still learns what unchecking it
  // cost them. Equality rather than a substring: a title that drifts from the
  // Notice is a second, contradictory explanation of one refusal.
  assert.equal(
    (await checkNow.getAttribute("title"))?.replace(/\s+/g, ""),
    said,
    "the disabled button's title does not carry the field's explanation",
  );

  // THE POINT — nothing was sent. Both attempts are made for real, and a
  // disabled button is expected to swallow both: Chromium drops click events
  // targeted at disabled form controls, and React's own listener lookup returns
  // null for onClick on a disabled button/input/select/textarea
  // (react-dom-client getListener), so a dispatched event never reaches run()
  // either. run() keeps its own second gate (ExitChecksPage.tsx:418,
  // `runOutbounds === null`), but no click this test can make observes THAT
  // half alone: a null list implies a non-null problem, which is what disabled
  // the button, and the button's onClick is run()'s only call site — so the
  // check is belt to the button's braces. What the two assertions below
  // measure is therefore narrower and still the one with teeth: the gates only
  // fail TOGETHER, and one POST here means all three let a round through.
  const [before, beforeNewest, beforeSettled] = await settledHistory();
  assert.ok(
    beforeSettled,
    `the exit-check history was still moving after 15 one-second polls (last read: ${before} rows, newest ${beforeNewest}), so there is no stable baseline to compare a refused run against — this is the test above's round still landing rows, not anything the click below did`,
  );
  const posted = [];
  const onRequest = (req) => {
    if (req.url().includes("/api/exit-checks/run")) posted.push(`${req.method()} ${req.url()}`);
  };
  page.on("request", onRequest);
  // Each attempt is recorded rather than allowed to throw the test out: a
  // control that swallows the click is the behaviour under test, and Playwright
  // refusing to click a disabled button is the same refusal proven from the
  // other side. What must never happen is a POST reaching the engine, which is
  // what the two assertions below measure. Each one gets its own try, so an
  // attempt that throws still leaves the OTHER attempt made — the two gates
  // (the browser's, React's) are exercised independently.
  const attempt = async (what, fn) => {
    try {
      await fn();
      return "swallowed";
    } catch (err) {
      return `${what} refused: ${String(err?.message ?? err).split("\n")[0]}`;
    }
  };
  const realClick = await attempt("Playwright", () => checkNow.click({ force: true }));
  const synthetic = await attempt("the dispatched click", () =>
    checkNow.dispatchEvent("click"),
  );
  // Both halves of "nothing was sent" need the page to have stopped talking to
  // the engine before they are read: the log, so a POST the click DID make is in
  // it, and the history, so a round it DID start has had its turn to record.
  // networkidle is what the rest of this file waits on and it settles by itself.
  await page.waitForLoadState("networkidle");
  page.off("request", onRequest);
  // The assertion with teeth. Every gate the page has — the disabled button, the
  // React listener it filters out, run()'s own null check — has to fail together
  // before this endpoint is reached, and one POST here is a round the reader
  // asked the picker not to run.
  assert.deepEqual(
    posted,
    [],
    `the refused run reached the engine's run endpoint (real click ${realClick}, synthetic ${synthetic})`,
  );
  // The engine-side half, and on the CI fixture the weaker of the two: the only
  // outbound configured there is "direct-1", which has no server address, so the
  // engine skips it and a round that DID start would record nothing either way
  // (internal/exitip/manager.go, `if o.Address() == ""`). On an engine with a
  // real proxy behind it this is the assertion that names the damage — rows a
  // round nobody asked for wrote into the history.
  const [after, afterNewest, afterSettled] = await settledHistory();
  // Not settling HERE is itself the failure: the baseline was quiet, so rows
  // still landing means a round started — the refused click's, since the only
  // thing between the two readings is the two clicks on a disabled button.
  assert.ok(
    afterSettled,
    `the exit-check history started moving after the refused click and was still moving 15 polls later (was ${before} rows / newest ${beforeNewest}, now ${after} rows / newest ${afterNewest}; real click ${realClick}, synthetic ${synthetic}) — a round nobody asked for is recording rows`,
  );
  assert.deepEqual(
    [after, afterNewest],
    [before, beforeNewest],
    `the refused run recorded exit-check rows on the engine — ${before} rows, newest ${beforeNewest}, became ${after} rows, newest ${afterNewest} (real click ${realClick}, synthetic ${synthetic})`,
  );

  // One click gets the run back: the guard is about the state, not the field.
  await pick(first);
  await page.waitForSelector(`${chipSel(first)}.on`, { timeout: 5_000 });
  assert.match(await pill.innerText(), /^1 outbound$/, "pill does not count one outbound");
  assert.equal(await notice.count(), 0, "the nothing-selected Notice outlived the selection");
  assert.ok(await checkNow.isEnabled(), "'Check now' still disabled with one outbound picked");
  // Stopped here on purpose: pressing it would run a real round against a live
  // check site, and the test above already covers the run itself.
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

await test("probe routes: 'every outbound' unchecks everything, and a pool selects its members", async () => {
  await page.goto(`${BASE}/probes`, { waitUntil: "networkidle" });
  const group = '[aria-labelledby="probe-routes-label"]';
  const chipSel = (ref) => `${group} label.chip:has(span:text-is("${ref}"))`;
  const allSel = `${group} label.chip:has-text("every outbound")`;
  const pill = page.locator(".card-head .pill").first();
  const notice = page.locator(`${group} + .notice, .field:has(${group}) .notice`).first();
  const runBtn = page.locator("main button.primary:has-text('Probe now')");

  const outbounds = await api("outbounds");
  assert.ok(outbounds.length > 0, "engine reports no outbounds to probe");
  const firstOut = `outbound:${outbounds[0].id}`;
  // The route the all-mode never covers: "direct" is always offered
  // (ProbesPage appends it to the route list) and no outbound chip can collide
  // with it — those render as "outbound:<id>".
  const extra = "direct";

  // Past FILTER_AT the picker hides unmatched chips behind its filter box, so
  // a chip is only clickable once it is on screen: type its reference in first
  // when the box exists, then clear it again.
  const filterBox = page.locator(`#probe-routes-filter`);
  const reveal = async (ref) => {
    if ((await filterBox.count()) === 0) return;
    await filterBox.fill(ref);
    await page.waitForSelector(chipSel(ref), { timeout: 5_000 });
  };
  const click = async (ref) => {
    await reveal(ref);
    await page.locator(chipSel(ref)).click();
  };
  const checked = async (sel) =>
    (await page.locator(sel).count()) > 0 &&
    (await page.locator(`${sel} input`).first().isChecked());
  // Count the checked chips in the box. With nothing selected no chip can
  // render as `.on` whether or not a filter is applied — chipChecked answers
  // from an empty ref list — so this count holds past FILTER_AT too, where the
  // DOM shows filter-matched chips only. A large SELECTION is what the DOM
  // cannot show, and there the pill (an exact count) carries the invariant.
  const checkedCount = async () =>
    await page.locator(`${group} .chip-scroll label.chip.on`).count();

  await page.waitForSelector(chipSel(firstOut), { timeout: 10_000 });

  // The hint states the caps the picker can run into, so the reader learns
  // them before the round hits them. (It sits beside the group, not inside it —
  // FieldGroup renders hint as a sibling of the role=group.) The route cap is
  // 65535: naming a fleet is legal, and it is the 512-request fan-out that
  // decides whether the round can run.
  const hint = await page
    .locator(`.field:has(${group}) > .field-hint`)
    .first()
    .innerText();
  assert.match(hint, /512 requests/, "route hint lost the fan-out cap");
  assert.match(hint, /65535 routes/, "route hint lost the engine's route cap");

  // A fresh form is in all-mode: the all-chip is on, and NO individual chip
  // reads as checked. The round's own set is the engine's to enumerate — the
  // BUILT outbounds, which no endpoint reports — so checking them would
  // promise a list the round may not match.
  assert.ok(await checked(allSel), "all-chip not checked on a fresh form");
  assert.match(await pill.innerText(), /every outbound/, "pill does not say every outbound");
  for (const ref of [firstOut, extra]) {
    await reveal(ref);
    assert.equal(
      await checked(chipSel(ref)),
      false,
      `${ref} checked under "every outbound"`,
    );
  }

  // Unchecking "every outbound" unselects everything. This is the state the
  // wire cannot carry — an empty `routes` list means all-mode to the engine —
  // so the page refuses the round instead of sending it.
  await page.locator(`${allSel} input`).click();
  await page.waitForSelector(`${allSel}.on`, { state: "detached", timeout: 5_000 });
  assert.match(await pill.innerText(), /no routes/, "pill does not say no routes");
  const nothing = await notice.innerText();
  assert.match(nothing, /No route selected/, `notice does not explain: ${nothing}`);
  assert.ok(await runBtn.isDisabled(), "'Probe now' still enabled with nothing selected");
  // Not one chip anywhere in the box. The all-chip renders in its own grid,
  // so this selector counts individual chips only — and with nothing selected
  // every one of them reads unchecked even past FILTER_AT, where the DOM holds
  // the filter's matches rather than the whole fleet.
  assert.equal(await checkedCount(), 0, "unchecking all-mode left a chip checked");

  // One click selects exactly that chip — not the fleet around it.
  await click(extra);
  await page.waitForSelector(`${chipSel(extra)}.on`, { timeout: 5_000 });
  assert.equal(await checked(chipSel(extra)), true, "clicking a chip did not check it");
  assert.match(await pill.innerText(), /1 route$/, "pill does not count one route");
  assert.ok(await runBtn.isEnabled(), "'Probe now' disabled with one route selected");
  for (const o of outbounds.slice(0, 5)) {
    await reveal(`outbound:${o.id}`);
    assert.equal(
      await checked(chipSel(`outbound:${o.id}`)),
      false,
      `one click selected ${o.id} too`,
    );
  }

  // A pool chip selects ALL of that pool's outbounds, because probing through
  // "pool:…" itself rides whichever member the selector picks — one click has
  // to name the members for the round to say anything about the pool.
  //
  // Every pool is covered, in whatever order /api/pools returns them, and the
  // expectations are computed here the way ProbesPage.poolChipGroups computes
  // them: refs to blank ids dropped, repeats counted once (matching cleanList,
  // and the engine, whose probeRoutes drops repeats too), ids the engine has no
  // outbound for dropped (internal/router/router.go, `if o, ok := r.outbounds[id];
  // ok` skips them when it builds the pool), and a pool left with no member
  // getting no group at all — which is NOT the same as no chip.
  const pools = await api("pools");
  const configured = new Set(outbounds.map((o) => `outbound:${o.id}`));
  const poolRefs = pools
    .filter((p) => typeof p?.id === "string" && p.id !== "")
    .map((p) => {
      const raw = Array.isArray(p.outbound_ids) ? p.outbound_ids : [];
      // `declared` is the count /api/pools serves verbatim (internal/config/
      // store.go does no cleaning), `live` what a click on the chip selects.
      const live = [
        ...new Set(
          raw
            .filter((id) => typeof id === "string" && id !== "")
            .map((id) => `outbound:${id}`),
        ),
      ].filter((m) => configured.has(m));
      return { ref: `pool:${p.id}`, declared: raw.length, live };
    });
  assert.ok(poolRefs.length > 0, "engine reports no pool for the route picker to offer");
  // Premise guard, stated before the badges are read: a pool whose declared
  // members all survive the two cuts cannot tell a correct badge from a
  // hardcoded "1", so the fixture has to stay dirty. .github/workflows/ci.yml
  // declares pool-default as ["direct-1","direct-1","e2e-not-configured"] and
  // pool-ghost as ["nope-1","nope-2"] for exactly this — a future fixture that
  // tidies them up stops here, named, instead of leaving a pool-chip failure to
  // be diagnosed out of the DOM.
  const dirty = poolRefs.filter((g) => g.declared > g.live.length);
  assert.ok(
    dirty.length > 0,
    `every pool's declared members survive ProbesPage's dedupe and its filter to configured outbounds (${poolRefs
      .map((g) => `${g.ref}: ${g.declared} declared / ${g.live.length} live`)
      .join(", ")}), so the badge proves nothing — .github/workflows/ci.yml has to keep a pool naming a repeat and an id no outbound has`,
  );
  assert.ok(
    poolRefs.some((g) => g.live.length === 0),
    `every pool in /api/pools has a configured member, so the "a pool with no member gets no group, and its chip selects itself" branch has no subject — .github/workflows/ci.yml declares pool-ghost (["nope-1","nope-2"]) for it`,
  );

  // Clear the explicit list first, so every pool's click below is its own: each
  // pass starts from nothing selected and ends that way again.
  await click(extra);
  await page.waitForSelector(`${chipSel(extra)}.on`, { state: "detached", timeout: 5_000 });
  assert.ok(await runBtn.isDisabled(), "'Probe now' enabled with nothing selected");

  for (const g of poolRefs.filter((x) => x.live.length > 0)) {
    assert.equal(
      await checkedCount(),
      0,
      `${g.ref}: the pass before it left a chip checked, so its click is not its own`,
    );
    await click(g.ref);
    await page.waitForSelector(`${chipSel(g.ref)}.on`, { timeout: 5_000 });
    for (const m of g.live) {
      await reveal(m);
      assert.equal(await checked(chipSel(m)), true, `${g.ref} did not select ${m}`);
    }
    // The chip says what one click on it commits to, so a pool of 40 does not
    // read as one route among hundreds. `live.length` rather than `declared`:
    // the badge is the page's own dedupe-and-filter result, which is the whole
    // reason the CI fixture names direct-1 twice plus an id no outbound has.
    //
    // Re-reveal the pool chip first: the member checks above left the filter on
    // a member ref, and past FILTER_AT a selection is pinned into the filtered
    // view only by its own refs — which are the MEMBERS, never the pool chip.
    // Without this, on a fleet the pool chip is not in the DOM at all and the
    // badge read times out instead of reporting a wrong count.
    await reveal(g.ref);
    const badge = page.locator(`${chipSel(g.ref)} .chip-count`);
    assert.equal(
      await badge.innerText(),
      String(g.live.length),
      `${g.ref} does not show its member count (it declares ${g.declared} ids, ${g.live.length} of them configured)`,
    );
    assert.match(
      await pill.innerText(),
      new RegExp(`${g.live.length} route${g.live.length === 1 ? "" : "s"}$`),
      `${g.ref}: pill does not count the pool's members`,
    );
    // … and one more click takes them all back out, leaving nothing selected.
    // (`click` reveals the chip first, so the filter the member loop left on a
    // member ref cannot hide it.)
    await click(g.ref);
    await page.waitForSelector(`${chipSel(g.ref)}.on`, { state: "detached", timeout: 5_000 });
    assert.ok(await runBtn.isDisabled(), `'Probe now' enabled after unselecting ${g.ref}`);
  }

  // The dropped branch, asserted as what the CODE does rather than as a chip
  // that is missing: `pool:<id>` is a legal route reference in its own right, so
  // ProbesPage still lists it in `choices` and ChipPicker still renders it —
  // what poolChipGroups withheld is the GROUP, and ChipPicker's `covers` falls
  // back to [ref] for a chip no group claims. So the chip is there, carries no
  // member badge (it commits to nothing but itself), and one click selects it
  // alone. A round through it rides a pool the engine built from members it
  // could not resolve, which is the engine's to explain, not the picker's to
  // hide.
  for (const g of poolRefs.filter((x) => x.live.length === 0)) {
    assert.equal(
      await checkedCount(),
      0,
      `${g.ref}: the pass before it left a chip checked, so its click is not its own`,
    );
    await click(g.ref);
    await page.waitForSelector(`${chipSel(g.ref)}.on`, { timeout: 5_000 });
    assert.equal(
      await page.locator(`${chipSel(g.ref)} .chip-count`).count(),
      0,
      `${g.ref} advertises a member count for a pool with no configured member`,
    );
    assert.equal(await checkedCount(), 1, `${g.ref} selected more than itself`);
    assert.match(
      await pill.innerText(),
      /1 route$/,
      `${g.ref}: pill does not count the one route its chip selects`,
    );
    assert.ok(await runBtn.isEnabled(), `'Probe now' disabled with ${g.ref} selected`);
    await click(g.ref);
    await page.waitForSelector(`${chipSel(g.ref)}.on`, { state: "detached", timeout: 5_000 });
    assert.ok(await runBtn.isDisabled(), `'Probe now' enabled after unselecting ${g.ref}`);
  }

  // Checking the all-chip returns to all-mode and drops the explicit list:
  // a materialized copy would miss outbounds added later.
  await click(extra);
  await page.locator(`${allSel} input`).click();
  await page.waitForSelector(`${allSel}.on`, { timeout: 5_000 });
  assert.match(await pill.innerText(), /every outbound/, "pill did not return to all-mode");
  await reveal(extra);
  assert.equal(await checked(chipSel(extra)), false, "all-mode left a chip checked");
  assert.ok(await runBtn.isEnabled(), "'Probe now' disabled in all-mode");
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
