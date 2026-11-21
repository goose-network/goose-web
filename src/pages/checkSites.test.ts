// src/pages/checkSites.test.ts — the check-site picker's data and the
// single-run request it builds: the two things that decide whether a one-off
// exit-IP check reaches the engine in a shape it can run — including the
// refusal that keeps a half-finished outbound picker from reaching it in the
// *opposite* shape.

import { describe, expect, it } from "vitest";
import {
  ALL_SELECTED,
  NONE_SELECTED,
  nothingSelectedProblem,
  type ChipSelection,
} from "../components/ChipPicker";
import {
  BAD_SITE_MESSAGE,
  buildExitRunSpec,
  CHECK_SITE_PRESETS,
  effectiveNumber,
  editorSeedSites,
  ENGINE_DEFAULT_SITES,
  exitRunOutbounds,
  exitRunProblem,
  firstBadSite,
  savedSiteList,
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

describe("exitRunOutbounds", () => {
  it("sends an empty list for all-mode, which the builder then omits", () => {
    // RunSpec.Outbounds is omitempty, and the engine reads the absent list as
    // "check every address-bearing outbound" — the all-chip's own meaning, so
    // [] is the right answer here and buildExitRunSpec's omission carries it.
    expect(exitRunOutbounds(ALL_SELECTED)).toEqual([]);
    expect(
      buildExitRunSpec({
        sites: [],
        outbounds: exitRunOutbounds(ALL_SELECTED) ?? [],
        timeoutSec: 0,
        concurrency: 0,
      }),
    ).toEqual({});
  });

  it("answers nothing-selected with null, the state the wire cannot carry", () => {
    // [] here would travel as all-mode: the engine would check every
    // address-bearing outbound of a fleet the reader just unchecked. null is
    // what lets run() refuse the round instead of sending its opposite.
    expect(exitRunOutbounds(NONE_SELECTED)).toBeNull();
  });

  it("sends an explicit selection, as a copy of it", () => {
    const sel: ChipSelection = { all: false, refs: ["outbound:a", "outbound:b"] };
    const sent = exitRunOutbounds(sel);
    expect(sent).toEqual(["outbound:a", "outbound:b"]);
    // The selection is the picker's state, so a caller pushing into the array
    // it was handed must not move the chips behind it.
    sent?.push("outbound:c");
    expect(sel.refs).toEqual(["outbound:a", "outbound:b"]);
  });

  it("would send nothing-selected as all-mode if the null gate went away", () => {
    // The inversion this file exists to prevent, stated on the wire: with the
    // null coerced away, both selections build the byte-identical body {} and
    // the engine expands it to every address-bearing outbound either way.
    const none = buildExitRunSpec({
      sites: [],
      outbounds: exitRunOutbounds(NONE_SELECTED) ?? [],
      timeoutSec: 0,
      concurrency: 0,
    });
    const all = buildExitRunSpec({
      sites: [],
      outbounds: exitRunOutbounds(ALL_SELECTED) ?? [],
      timeoutSec: 0,
      concurrency: 0,
    });
    expect(none).toEqual({});
    expect(all).toEqual({});
    expect(none).toEqual(all);
  });
});

describe("exitRunProblem", () => {
  const explicit: ChipSelection = { all: false, refs: ["outbound:a"] };

  it("lets a finished selection run, all-mode or explicit", () => {
    expect(exitRunProblem(ALL_SELECTED, undefined)).toBeNull();
    expect(exitRunProblem(explicit, undefined)).toBeNull();
  });

  it("names the bad site before a missing selection", () => {
    // fetchExitIP needs an absolute http(s) URL, and one site without a scheme
    // fails every check against it — so it is the thing to fix first, which is
    // the precedence the button's title had while it was an inline ternary.
    expect(exitRunProblem(NONE_SELECTED, "ifconfig.me")).toEqual({
      blocked: true,
      message: BAD_SITE_MESSAGE,
    });
    expect(exitRunProblem(explicit, "ifconfig.me")?.message).toContain(
      "absolute http(s) URL",
    );
  });

  it("says it in the words the save button is disabled by", () => {
    // Two buttons refuse a bad site — "Check now" through exitRunProblem, and
    // "Save these sites as the defaults" through its own title ternary — and the
    // page imports this constant for the second one. Asserting the message IS
    // the constant is what keeps them one sentence: a rewording here that
    // missed ExitChecksPage would leave the save button explaining a refusal
    // the run button no longer states, and nothing else in the repo would say
    // so. The literal is pinned too, so the constant cannot be reworded into
    // vagueness while both call sites happily follow.
    expect(BAD_SITE_MESSAGE).toBe(
      "Fix the check site first — the engine needs an absolute http(s) URL",
    );
  });

  it("refuses nothing-selected in the words both pickers share", () => {
    // Same helper as probeSpec.probeRoundProblem: the engine reads an empty
    // list as "every one of them", so this is a form to finish rather than a
    // round the engine would reject — and the message must not be retyped
    // here, where the two would drift.
    const problem = exitRunProblem(NONE_SELECTED, undefined);
    expect(problem?.blocked).toBe(true);
    expect(problem?.message).toContain("every outbound");
    expect(problem).toEqual(nothingSelectedProblem("outbound", "every outbound"));
  });
});

describe("savedSiteList", () => {
  it("keeps a saved list — including an explicitly emptied one — as its own state", () => {
    // An empty saved list is not "no list": it means every site was deleted
    // and the engine checks nothing, so an editor must not re-seed defaults.
    expect(savedSiteList(["https://a"])).toEqual(["https://a"]);
    expect(savedSiteList([])).toEqual([]);
  });

  it("reports an unsaved list (absent, or JSON null from the engine) as undefined", () => {
    expect(savedSiteList(undefined)).toBeUndefined();
    expect(savedSiteList(null)).toBeUndefined();
  });
});

describe("editorSeedSites", () => {
  it("seeds the engine's defaults when no list is saved, so they are deletable rows", () => {
    // This is what makes the built-ins deletable on the web (R3): a fresh
    // engine serves sites:null, and the editors must still show every
    // default as an ordinary row.
    expect(editorSeedSites(undefined)).toEqual([...ENGINE_DEFAULT_SITES]);
    expect(editorSeedSites(null)).toEqual([...ENGINE_DEFAULT_SITES]);
  });

  it("keeps a saved list — including an emptied one — instead of re-seeding", () => {
    expect(editorSeedSites(["https://a"])).toEqual(["https://a"]);
    expect(editorSeedSites([])).toEqual([]);
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
