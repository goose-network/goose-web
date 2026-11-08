// src/pages/checkSites.test.ts — the check-site picker's data and the
// single-run request it builds: the two things that decide whether a one-off
// exit-IP check reaches the engine in a shape it can run.

import { describe, expect, it } from "vitest";
import {
  buildExitRunSpec,
  CHECK_SITE_PRESETS,
  effectiveNumber,
  ENGINE_DEFAULT_SITES,
  firstBadSite,
} from "./checkSites";

const presetURLs = CHECK_SITE_PRESETS.flatMap((g) => g.sites.map((s) => s.url));

describe("CHECK_SITE_PRESETS", () => {
  it("offers every engine default, so the picker can reproduce the fallback", () => {
    for (const url of ENGINE_DEFAULT_SITES) {
      expect(presetURLs, `${url} should be a preset`).toContain(url);
    }
  });

  it("lists only sites whose body is a bare IP", () => {
    // The engine reads at most 64 bytes and runs them through net.ParseIP, so
    // a JSON or HTML answer fails the check and reads like a broken proxy.
    for (const { group, sites } of CHECK_SITE_PRESETS) {
      for (const s of sites) {
        expect(s.url, group).toMatch(/^https?:\/\/[^/\s]+/);
        expect(s.url, group).not.toMatch(/format=json|\/json\b|\.(html?)\b/);
        expect(s.note, `${s.url} should say why`).not.toBe("");
      }
    }
  });

  it("has no duplicate URLs across groups", () => {
    expect(new Set(presetURLs).size).toBe(presetURLs.length);
  });
});

describe("buildExitRunSpec", () => {
  it("omits untouched fields so the engine's configured values apply", () => {
    expect(
      buildExitRunSpec({ sites: [], outbounds: [], timeoutSec: 0, concurrency: 0 }),
    ).toEqual({});
  });

  it("sends only what was set, trimmed and deduped", () => {
    expect(
      buildExitRunSpec({
        sites: [" https://a ", "https://a", "", "https://b"],
        outbounds: ["one"],
        timeoutSec: 8,
        concurrency: 0,
      }),
    ).toEqual({ sites: ["https://a", "https://b"], outbounds: ["one"], timeout_seconds: 8 });
  });
});

describe("firstBadSite", () => {
  it("flags a site the engine would reject", () => {
    // fetchExitIP requires an absolute http(s) URL, and every table and chip on
    // the page shows sites without their scheme — so "ifconfig.me" is what a
    // reader types, and what then fails each check with `bad site URL`.
    expect(firstBadSite(["https://ifconfig.me"])).toBeUndefined();
    expect(firstBadSite(["ifconfig.me"])).toBe("ifconfig.me");
    expect(firstBadSite(["https://a", "ftp://b"])).toBe("ftp://b");
  });

  it("judges the trimmed value, because that is what gets saved", () => {
    expect(firstBadSite([" https://ifconfig.me "])).toBeUndefined();
    expect(firstBadSite([" ifconfig.me "])).toBe("ifconfig.me");
  });

  it("leaves an empty list alone — it means the engine's defaults", () => {
    expect(firstBadSite([])).toBeUndefined();
    expect(firstBadSite(["", "   "])).toBeUndefined();
  });
});

describe("effectiveNumber", () => {
  it("shows the configured value when there is one", () => {
    expect(effectiveNumber(30, 15)).toBe("30");
  });

  it("falls back to the engine's default for 0 and for absent", () => {
    // exit_checks has no omitempty, so an engine nobody configured reports 0
    // rather than leaving the field out — and 0 is not a value it will use.
    expect(effectiveNumber(0, 15)).toBe("15");
    expect(effectiveNumber(undefined, 4)).toBe("4");
  });
});
