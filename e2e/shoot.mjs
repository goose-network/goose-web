// e2e/shoot.mjs — screenshot helper for visual review (not part of CI).
//
// Usage: node e2e/shoot.mjs <outDir> [base]
// Captures every route at desktop + narrow width, in light and dark mode,
// plus the open create-form on each CRUD page.

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { stubObservability } from "./fixtures.mjs";

const OUT = process.argv[2] ?? "/tmp/shots";
const BASE = process.argv[3] ?? "http://127.0.0.1:4173";

const ROUTES = [
  ["overview", "/"],
  ["inbounds", "/inbounds"],
  ["outbounds", "/outbounds"],
  ["pools", "/pools"],
  ["chains", "/chains"],
  ["providers", "/providers"],
  ["exit", "/exit-checks"],
  ["metrics", "/metrics"],
];

// Pages with a "New …" button whose open form is worth a look.
const FORMS = [
  ["inbounds", "/inbounds", "New inbound"],
  ["pools", "/pools", "New pool"],
  ["providers", "/providers", "New provider"],
];

mkdirSync(OUT, { recursive: true });
// CHROME_PATH lets a dev box point at an already-downloaded Chromium when the
// playwright-core revision doesn't match the local browser cache.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);

for (const theme of ["light", "dark"]) {
  for (const [w, h, tag] of [[1280, 1000, "desktop"], [430, 900, "narrow"]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await stubObservability(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      localStorage.setItem("goose-web.theme", JSON.stringify(t));
    }, theme);

    for (const [name, route] of ROUTES) {
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${OUT}/${theme}-${tag}-${name}.png`, fullPage: true });
    }

    if (tag === "desktop") {
      for (const [name, route, label] of FORMS) {
        await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        const btn = page.locator(`button:has-text("${label}")`).first();
        if (await btn.count()) {
          await btn.click();
          await page.waitForTimeout(250);
          await page.screenshot({ path: `${OUT}/${theme}-${tag}-${name}-form.png`, fullPage: true });
        }
      }
    }
    await page.close();
  }
}

await browser.close();
console.log(`wrote screenshots to ${OUT}`);
