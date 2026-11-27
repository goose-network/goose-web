// src/pages/fullProbeSpec.test.ts — the full-probe page's pure logic: the
// form's validation and wire mapping, the progress math over a job's levels,
// and the default path selection a no-body apply builds from (the browser's
// mirror of the engine's BestPaths — they must agree, or the page would
// promise inbounds the engine builds differently).

import { describe, expect, it } from "vitest";
import {
  allPathsFastest,
  appliedForCard,
  bestPaths,
  buildApplySpec,
  buildFullProbeRequest,
  buildResultsOpts,
  foldHeadPage,
  foldOlderPage,
  FULL_PROBE_APPLY_POOL_CAP,
  FULL_PROBE_CAPS,
  FULL_PROBE_POLL_MAX_MS,
  FULL_PROBE_POLL_MS,
  fullProbeFormProblems,
  fullProbePollDelay,
  fullProbeProgress,
  fullProbeRunning,
  INITIAL_APPLY_FIELDS,
  INITIAL_FULL_PROBE_FIELDS,
  INITIAL_RESULTS_FILTERS,
  levelSummaries,
  loadMoreAction,
  mergeRowsById,
  nextCursor,
  olderPageContiguous,
  pathLabel,
  poolApplyCapable,
  poolApplyPreview,
  RESULTS_PAGE_DEFAULT,
  RESULTS_PAGE_OPTIONS,
  resultsDepthChoices,
  resultsExhaustedShort,
  resultsFiltersActive,
  resultsHopChoices,
  resultsLandingState,
  resultsReasonChoices,
  resultsViewReset,
  statePill,
  type AppliedState,
  type ResultsFilterFields,
} from "./fullProbeSpec";
import { buildResultsQuery } from "../fullProbeApi";
import type { FullProbeJob } from "../fullProbeApi";
import type { HTTPProbe } from "../runApi";
import { REASON_LABELS } from "./probeSpec";

const okFields = {
  ...INITIAL_FULL_PROBE_FIELDS,
  target: "https://example.com",
};

describe("fullProbeFormProblems", () => {
  it("accepts a bare target with every knob defaulted", () => {
    expect(fullProbeFormProblems(okFields)).toEqual({});
  });

  it("rejects a missing or non-http target", () => {
    expect(fullProbeFormProblems({ ...okFields, target: "" }).target).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, target: "ftp://x.com" }).target,
    ).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, target: "example.com" }).target,
    ).toBeDefined();
  });

  it("rejects values past the engine's caps", () => {
    expect(
      fullProbeFormProblems({ ...okFields, maxDepth: FULL_PROBE_CAPS.maxDepth + 1 })
        .maxDepth,
    ).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, rps: FULL_PROBE_CAPS.maxRPS + 1 }).rps,
    ).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, timeoutSec: 61 }).timeoutSec,
    ).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, concurrency: -1 }).concurrency,
    ).toBeDefined();
  });

  it("accepts the caps themselves", () => {
    expect(
      fullProbeFormProblems({
        ...okFields,
        maxDepth: FULL_PROBE_CAPS.maxDepth,
        rps: FULL_PROBE_CAPS.maxRPS,
        timeoutSec: FULL_PROBE_CAPS.maxTimeoutSec,
        concurrency: FULL_PROBE_CAPS.maxConcurrency,
      }),
    ).toEqual({});
  });

  it("rejects fractional knobs — the wire fields are ints", () => {
    expect(
      fullProbeFormProblems({ ...okFields, timeoutSec: 2.5 }).timeoutSec,
    ).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, maxDepth: 1.5 }).maxDepth,
    ).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, rps: 100.25 }).rps,
    ).toBeDefined();
    expect(
      fullProbeFormProblems({ ...okFields, concurrency: 0.5 }).concurrency,
    ).toBeDefined();
  });

  it("rejects NaN and Infinity, which slip past bare range comparisons", () => {
    // NumberField emits Number(raw); NaN < 0 and NaN > max are both false,
    // so without the integer guard a NaN knob would validate clean.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const p = fullProbeFormProblems({
        ...okFields,
        timeoutSec: bad,
        maxDepth: bad,
        rps: bad,
        concurrency: bad,
      });
      expect(p.timeoutSec).toBeDefined();
      expect(p.maxDepth).toBeDefined();
      expect(p.rps).toBeDefined();
      expect(p.concurrency).toBeDefined();
    }
  });
});

describe("fullProbePollDelay", () => {
  it("doubles from the normal cadence per consecutive failure", () => {
    expect(fullProbePollDelay(1)).toBe(FULL_PROBE_POLL_MS * 2);
    expect(fullProbePollDelay(2)).toBe(FULL_PROBE_POLL_MS * 4);
  });

  it("caps the backoff so a long outage neither hammers nor freezes", () => {
    expect(fullProbePollDelay(3)).toBe(FULL_PROBE_POLL_MAX_MS);
    expect(fullProbePollDelay(50)).toBe(FULL_PROBE_POLL_MAX_MS);
    expect(fullProbePollDelay(10_000)).toBe(FULL_PROBE_POLL_MAX_MS);
  });

  it("never waits less than the normal cadence", () => {
    expect(fullProbePollDelay(0)).toBe(FULL_PROBE_POLL_MS);
    expect(fullProbePollDelay(-3)).toBe(FULL_PROBE_POLL_MS);
  });
});

describe("buildFullProbeRequest", () => {
  it("omits zero knobs so the engine's defaults apply", () => {
    expect(buildFullProbeRequest(okFields)).toEqual({
      target: "https://example.com",
    });
  });

  it("maps the set knobs and trims the target", () => {
    expect(
      buildFullProbeRequest({
        target: "  https://example.com/x ",
        timeoutSec: 7,
        maxDepth: 3,
        rps: 10000,
        concurrency: 64,
      }),
    ).toEqual({
      target: "https://example.com/x",
      timeout_seconds: 7,
      max_depth: 3,
      rps: 10000,
      concurrency: 64,
    });
  });
});

describe("fullProbeRunning", () => {
  it("is true only for the running state", () => {
    expect(fullProbeRunning({ state: "running" })).toBe(true);
    expect(fullProbeRunning({ state: "done" })).toBe(false);
    expect(fullProbeRunning({ state: "canceled" })).toBe(false);
    expect(fullProbeRunning({})).toBe(false);
    expect(fullProbeRunning(undefined)).toBe(false);
  });
});

describe("bestPaths", () => {
  const job: FullProbeJob = {
    levels: [
      {
        depth: 1,
        success_paths: [
          { hops: ["slow"], latency: 30 },
          { hops: ["fast"], latency: 10 },
        ],
      },
      {
        depth: 2,
        success_paths: [{ hops: ["fast", "b"], latency: 20 }],
      },
      { depth: 3, success_paths: null },
    ],
  };

  it("picks the fastest path per depth, depth ascending, skipping empty levels", () => {
    expect(bestPaths(job)).toEqual([
      { hops: ["fast"], latency: 10 },
      { hops: ["fast", "b"], latency: 20 },
    ]);
  });

  it("handles absent jobs and levels", () => {
    expect(bestPaths(undefined)).toEqual([]);
    expect(bestPaths({})).toEqual([]);
    expect(bestPaths({ levels: null })).toEqual([]);
  });
});

describe("fullProbeProgress", () => {
  it("sums finished over planned across levels", () => {
    expect(
      fullProbeProgress({
        levels: [
          { done: 2, total: 2 },
          { done: 1, total: 4 },
        ],
      }),
    ).toEqual({ done: 3, total: 6, pct: 50 });
  });

  it("is null before anything is planned", () => {
    expect(fullProbeProgress(undefined)).toBeNull();
    expect(fullProbeProgress({ levels: [] })).toBeNull();
    expect(fullProbeProgress({ levels: [{ done: 0, total: 0 }] })).toBeNull();
  });

  it("never exceeds 100% when a live counter outruns the plan", () => {
    expect(
      fullProbeProgress({ levels: [{ done: 5, total: 4 }] })?.pct,
    ).toBe(100);
  });
});

describe("levelSummaries", () => {
  it("marks a level finished only when its plan is fully done", () => {
    const s = levelSummaries({
      levels: [
        { depth: 1, done: 2, total: 2, success: 1, failed: 1 },
        { depth: 2, done: 1, total: 3, success: 1, failed: 0, skipped: 1 },
        { depth: 3, done: 0, total: 0 },
      ],
    });
    expect(s[0]).toEqual({
      depth: 1, done: 2, total: 2, success: 1, failed: 1, skipped: 0, finished: true,
    });
    expect(s[1]?.finished).toBe(false);
    expect(s[1]?.skipped).toBe(1);
    expect(s[2]?.finished).toBe(false);
  });
});

describe("pathLabel", () => {
  it("frames the hops between local and target", () => {
    expect(pathLabel({ hops: ["relay", "work"] })).toBe(
      "local → relay → work → target",
    );
    expect(pathLabel({})).toBe("local → target");
  });
});

describe("statePill", () => {
  it("maps each state to its pill", () => {
    expect(statePill({ state: "running" })).toEqual({ cls: "pill warn", text: "running" });
    expect(statePill({ state: "done" })).toEqual({ cls: "pill ok", text: "done" });
    expect(statePill({ state: "error" })).toEqual({ cls: "pill fail", text: "error" });
    expect(statePill({ state: "canceled" }).text).toBe("canceled");
    expect(statePill(undefined).text).toBe("unknown");
  });
});
// ---------------------------------------------------------------------------
// Attempt results: query, merge, reset, vocabularies
// ---------------------------------------------------------------------------

describe("RESULTS_PAGE_OPTIONS", () => {
  it("offers the sizes the card's select lists, with the default among them", () => {
    expect([...RESULTS_PAGE_OPTIONS]).toEqual([100, 200, 500, 1000]);
    expect(RESULTS_PAGE_OPTIONS).toContain(RESULTS_PAGE_DEFAULT);
    // Every choice is a legal `n` for the engine (default 200, cap 10000).
    for (const n of RESULTS_PAGE_OPTIONS) expect(n).toBeLessThanOrEqual(10000);
  });
});

describe("buildResultsOpts + buildResultsQuery", () => {
  it("an untouched form pages from the head with the default size and no filters", () => {
    const opts = buildResultsOpts(INITIAL_RESULTS_FILTERS, RESULTS_PAGE_DEFAULT, "");
    expect(buildResultsQuery(opts)).toBe("?n=200");
  });

  it("maps every filter onto the endpoint's parameter names", () => {
    const f: ResultsFilterFields = {
      outcome: "failed",
      depth: 2,
      reason: "connect_timeout",
      route: "a>b",
      hop: "b",
      lastHop: "b",
    };
    const q = buildResultsQuery(buildResultsOpts(f, 500, "r-99"));
    // URLSearchParams order is insertion order; assert the parsed form so
    // the test pins the wire keys, not their serialization order.
    const params = new URLSearchParams(q.slice(1));
    expect(Object.fromEntries(params)).toEqual({
      n: "500",
      before: "r-99",
      outcome: "failed",
      depth: "2",
      reason: "connect_timeout",
      route: "a>b",
      hop: "b",
      last_hop: "b",
    });
  });

  it("unset fields never travel as empty strings or zero", () => {
    // An empty `outcome=` is still a filter key to a stricter engine, and
    // depth 0 is not a depth the engine stores.
    expect(
      buildResultsQuery({ n: 0, before: "", outcome: "", depth: 0, reason: "", route: "", hop: "", last_hop: "" }),
    ).toBe("");
  });

  it("encodes values that would otherwise break the URL", () => {
    const q = buildResultsQuery({ route: "a>b c", hop: "x&y" });
    expect(q).toContain("route=a%3Eb+c");
    expect(q).toContain("hop=x%26y");
  });
});

describe("resultsFiltersActive", () => {
  it("is false for the untouched form and true for any single filter", () => {
    expect(resultsFiltersActive(INITIAL_RESULTS_FILTERS)).toBe(false);
    const keys: Array<keyof ResultsFilterFields> = ["outcome", "depth", "reason", "route", "hop", "lastHop"];
    for (const k of keys) {
      const f = { ...INITIAL_RESULTS_FILTERS, [k]: k === "depth" ? 1 : "x" };
      expect(resultsFiltersActive(f)).toBe(true);
    }
  });
});

describe("nextCursor", () => {
  it("is the last loaded row's id — the oldest row in hand", () => {
    expect(nextCursor([{ id: "r3" }, { id: "r2" }, { id: "r1" }])).toBe("r1");
  });
  it("is empty with no rows, or a tail row without an id", () => {
    expect(nextCursor([])).toBe("");
    expect(nextCursor([{ id: "r2" }, {}])).toBe("");
  });
});

describe("olderPageContiguous", () => {
  const row = (id: string): HTTPProbe => ({ id });
  it("is true when the page's cursor still matches the window's tail", () => {
    expect(olderPageContiguous([row("r5"), row("r4")], "r4")).toBe(true);
  });
  it("is false when a head reset moved the tail while the page was in flight", () => {
    // The window reset to a newer head (r9..r8); appending a page fetched
    // from r4 would leave the rows between r8 and r4 an unreachable gap.
    expect(olderPageContiguous([row("r9"), row("r8")], "r4")).toBe(false);
  });
  it("is false for an empty cursor, an empty window, or an id-less tail", () => {
    expect(olderPageContiguous([row("r5")], "")).toBe(false);
    expect(olderPageContiguous([], "r4")).toBe(false);
    expect(olderPageContiguous([row("r5"), {}], "r5")).toBe(false);
  });
});

describe("mergeRowsById", () => {
  const row = (id: string, status = 200): HTTPProbe => ({ id, status });
  it("puts the fresh head first and keeps the older tail behind it", () => {
    const merged = mergeRowsById([row("r5"), row("r4")], [row("r4"), row("r3")]);
    expect(merged.map((r) => r.id)).toEqual(["r5", "r4", "r3"]);
  });
  it("the head's copy of a repeated id wins — it is the newer read", () => {
    const merged = mergeRowsById([row("r4", 204)], [row("r4", 500)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe(204);
  });
  it("keeps id-less rows — dropping them would silently lose an attempt", () => {
    const merged = mergeRowsById([{}, row("r1")], [{}, row("r1")]);
    expect(merged).toHaveLength(3);
  });
  it("a head refresh over an unchanged window is a no-op", () => {
    const window = [row("r3"), row("r2"), row("r1")];
    expect(mergeRowsById([row("r3"), row("r2")], window)).toEqual(window);
  });
});

describe("foldHeadPage", () => {
  const row = (id: string): HTTPProbe => ({ id });
  // A page of `n` rows with ids r{start}..r{start+n-1}, newest first.
  const page = (start: number, n: number): HTTPProbe[] =>
    Array.from({ length: n }, (_, i) => row(`r${start + n - 1 - i}`));

  it("a short head spans the whole stored set: window = head, end proven", () => {
    const head = page(1, 3);
    const prev = page(1, 10);
    const fold = foldHeadPage(prev, true, head, 10);
    expect(fold.rows).toEqual(head);
    expect(fold.exhausted).toBe(true);
    expect(fold.reset).toBe(true);
  });

  it("a short head proves the end even when the old window was not exhausted", () => {
    // Retention pruned the tail between refreshes: the short head is now the
    // entire stored set, and keeping the old rows would show pruned attempts.
    const head = page(5, 2);
    const fold = foldHeadPage(page(1, 10), false, head, 10);
    expect(fold.rows).toEqual(head);
    expect(fold.exhausted).toBe(true);
  });

  it("a full head over an empty window is the first page — not exhausted", () => {
    const head = page(1, 10);
    const fold = foldHeadPage([], false, head, 10);
    expect(fold.rows).toEqual(head);
    expect(fold.exhausted).toBe(false);
    expect(fold.reset).toBe(true);
  });

  it("a full head that overlaps merges contiguously and keeps a proven end", () => {
    // Head r12..r3 overlaps the window r10..r1: one unbroken slice r12..r1.
    const prev = page(1, 10);
    const head = page(3, 10);
    const fold = foldHeadPage(prev, true, head, 10);
    expect(fold.rows.map((r) => r.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `r${12 - i}`),
    );
    expect(fold.exhausted).toBe(true);
    expect(fold.reset).toBe(false);
  });

  it("a full overlapping head keeps an UNproven end unproven", () => {
    const fold = foldHeadPage(page(1, 10), false, page(3, 10), 10);
    expect(fold.exhausted).toBe(false);
    expect(fold.reset).toBe(false);
    expect(fold.rows).toHaveLength(12);
  });

  it("a full head with NO overlap resets to the head alone, end unproven", () => {
    // The gap scenario: >pageSize new rows landed between head refreshes, so
    // the head (r25..r16) sits entirely above the window (r10..r1). Merging
    // would keep the unreachable hole r15..r11 forever — Load-more pages from
    // r1 and can never walk back up into it.
    const head = page(16, 10);
    const fold = foldHeadPage(page(1, 10), true, head, 10);
    expect(fold.rows).toEqual(head);
    expect(fold.exhausted).toBe(false);
    expect(fold.reset).toBe(true);
  });

  it("id-less rows cannot prove overlap — the safe reset branch applies", () => {
    const fold = foldHeadPage([{}, row("r1")], true, [{}, row("r9")], 2);
    expect(fold.reset).toBe(true);
    expect(fold.exhausted).toBe(false);
  });

  it("the high-rps regression: an exhausted window UNLATCHES when the head outpaces it", () => {
    // End-to-end at helper level: the window walked to the end (exhausted,
    // Load-more hidden, banner armed), then a burst of >pageSize attempts
    // lands. The head fold must reset so Load-more returns and the pruning
    // banner cannot fire on rows that were never fetched.
    const prev = page(1, 200);
    const head = page(401, 200); // 400 new rows since the last refresh
    const fold = foldHeadPage(prev, true, head, 200);
    expect(fold.exhausted).toBe(false);
    expect(fold.rows).toEqual(head);
    expect(nextCursor(fold.rows)).toBe("r401"); // pages older from the head
    expect(resultsExhaustedShort(fold.exhausted, fold.rows.length, 100000)).toBe(false);
  });

  it("a head refresh over an unchanged exhausted window stays a no-op", () => {
    // Steady state: the whole stored set fits one short page — the fold
    // re-lands the same rows and the proven end stands.
    const window = page(1, 10);
    const fold = foldHeadPage(window, true, page(1, 10), 200);
    expect(fold.rows).toEqual(window);
    expect(fold.exhausted).toBe(true);
    // Exactly pageSize stored rows answer a FULL page: overlap merges, and
    // the proven end is preserved rather than re-walked.
    const exact = foldHeadPage(window, true, page(1, 10), 10);
    expect(exact.rows).toEqual(window);
    expect(exact.exhausted).toBe(true);
    expect(exact.reset).toBe(false);
  });

  it("a short head while the job runs collapses the window but proves no end", () => {
    // Row ids are minted at attempt START, rows recorded at completion: a
    // slow attempt can still land a row sorting below this short tail.
    const head = page(1, 3);
    const fold = foldHeadPage(page(1, 10), true, head, 10, true);
    expect(fold.rows).toEqual(head);
    expect(fold.exhausted).toBe(false);
    expect(fold.reset).toBe(true);
  });

  it("an overlapping head while the job runs clears a previously proven end", () => {
    const fold = foldHeadPage(page(1, 10), true, page(3, 10), 10, true);
    expect(fold.exhausted).toBe(false);
    expect(fold.reset).toBe(false);
    expect(fold.rows).toHaveLength(12);
    // Terminal: every attempt is recorded, so the same fold keeps the end.
    const terminal = foldHeadPage(page(1, 10), true, page(3, 10), 10, false);
    expect(terminal.exhausted).toBe(true);
  });

  it("the running-job regression: a short early head must not latch the end", () => {
    // Default settings: pageSize 200 at rps 50 — the first poll sees ~75
    // rows. The store keeps growing below that short tail (start-time ids,
    // async completion recording), so the latch must stay clear while
    // running: pre-fix it latched here, hid Load-more forever and armed the
    // pruning banner on rows that were merely not recorded YET.
    const first = foldHeadPage([], false, page(1, 75), 200, true);
    expect(first.exhausted).toBe(false);
    expect(first.reset).toBe(true);
    expect(resultsExhaustedShort(first.exhausted, first.rows.length, 100000, false, false)).toBe(false);
    // The store grows past a page: full overlapping heads must not
    // resurrect a latch from the short first page.
    const grown = foldHeadPage(first.rows, first.exhausted, page(1, 200), 200, true);
    expect(grown.exhausted).toBe(false);
    expect(grown.reset).toBe(false);
    expect(grown.rows).toHaveLength(200);
    const more = foldHeadPage(grown.rows, grown.exhausted, page(101, 200), 200, true);
    expect(more.exhausted).toBe(false);
    expect(more.rows).toHaveLength(300);
    expect(resultsExhaustedShort(more.exhausted, more.rows.length, 100000, false, false)).toBe(false);
    // Terminal: the runner recorded every attempt before the terminal head
    // refresh, so a short page now really is the whole stored set.
    const terminal = foldHeadPage(more.rows, more.exhausted, page(1, 150), 200, false);
    expect(terminal.exhausted).toBe(true);
    expect(terminal.reset).toBe(true);
  });
});

describe("foldOlderPage", () => {
  const row = (id: string): HTTPProbe => ({ id });
  it("appends below the window; a short page proves the end", () => {
    const fold = foldOlderPage([row("r5"), row("r4")], [row("r3"), row("r2")], 10);
    expect(fold.rows.map((r) => r.id)).toEqual(["r5", "r4", "r3", "r2"]);
    expect(fold.exhausted).toBe(true);
  });
  it("a full older page leaves the cursor walkable", () => {
    const fold = foldOlderPage([row("r5")], [row("r4"), row("r3")], 2);
    expect(fold.exhausted).toBe(false);
  });
  it("a re-seek overlap dedupes by id, window copy first", () => {
    const fold = foldOlderPage([row("r5"), row("r4")], [row("r4"), row("r3")], 10);
    expect(fold.rows.map((r) => r.id)).toEqual(["r5", "r4", "r3"]);
  });
  it("a short older page while the job runs appends but proves no end", () => {
    // Late completions can still land rows below the fetched page's tail —
    // the cursor must stay walkable until the job is terminal.
    const fold = foldOlderPage([row("r5"), row("r4")], [row("r3"), row("r2")], 10, true);
    expect(fold.rows.map((r) => r.id)).toEqual(["r5", "r4", "r3", "r2"]);
    expect(fold.exhausted).toBe(false);
  });
});

describe("loadMoreAction", () => {
  const row = (id: string): HTTPProbe => ({ id });
  it("advances the cursor when the tail moved — setBefore refetches", () => {
    // First click from the head: before="" and the window's tail is the cursor.
    expect(loadMoreAction([row("r5"), row("r4")], "")).toEqual({ cursor: "r4", refetch: false });
    // After an older page appended, the tail walked past the last before.
    expect(loadMoreAction([row("r5"), row("r4"), row("r3")], "r4")).toEqual({
      cursor: "r3",
      refetch: false,
    });
  });
  it("refetches when the cursor has NOT moved — the empty-older-page re-click", () => {
    // While the job runs, an older page can land EMPTY (ids are minted at
    // attempt start, recorded async at completion): the running fold keeps
    // exhausted=false so Load more stays visible, but before === tail. The
    // old setBefore-only path was a NO-OP here (deps unchanged → no refetch
    // → an enabled but inert button); the click must bump the tick instead
    // and re-query the same page.
    expect(loadMoreAction([row("r5"), row("r4")], "r4")).toEqual({ cursor: "r4", refetch: true });
  });
  it("is a no-op with nothing to page from", () => {
    expect(loadMoreAction([], "")).toBeNull();
    expect(loadMoreAction([], "r4")).toBeNull();
    expect(loadMoreAction([row("r5"), {}], "r5")).toBeNull();
  });
  it("the running-job recovery loop: empty page → refetch → late rows land → advance", () => {
    // End-to-end pure pin of the regression: a running job's empty older
    // page must leave a FUNCTIONAL Load-more, not an inert one.
    const window0 = [row("r5"), row("r4")];
    expect(loadMoreAction(window0, "")).toEqual({ cursor: "r4", refetch: false });
    // The older page comes back empty; the running fold proves no end and
    // the tail does not move, so the button's render gate stays open.
    const fold = foldOlderPage(window0, [], 10, true);
    expect(fold.exhausted).toBe(false);
    expect(nextCursor(fold.rows)).toBe("r4");
    // Second click: before === cursor — must refetch (old code: inert no-op).
    // The re-query still appends contiguously: the tail never moved.
    expect(loadMoreAction(fold.rows, "r4")).toEqual({ cursor: "r4", refetch: true });
    expect(olderPageContiguous(fold.rows, "r4")).toBe(true);
    // Late completions land below the cursor; the re-query folds them in
    // and the tail moves, so the next click advances normally again.
    const late = foldOlderPage(fold.rows, [row("r3"), row("r2")], 10, true);
    expect(late.rows.map((r) => r.id)).toEqual(["r5", "r4", "r3", "r2"]);
    expect(loadMoreAction(late.rows, "r4")).toEqual({ cursor: "r2", refetch: false });
  });
});

describe("resultsViewReset", () => {
  const scope = (over: Partial<{ engine: string; job: string; filters: ResultsFilterFields }> = {}) => ({
    engine: "http://a",
    job: "fp-1",
    filters: INITIAL_RESULTS_FILTERS,
    ...over,
  });
  it("the first load is not a reset", () => {
    expect(resultsViewReset(undefined, scope())).toBe(false);
  });
  it("a poll tick never resets: same engine, job and filters", () => {
    // The job snapshot is a new OBJECT every tick — only identity of the
    // scope's fields matters, or a Load-more view would collapse each cadence.
    expect(resultsViewReset(scope(), scope())).toBe(false);
    const filtered = { ...INITIAL_RESULTS_FILTERS, outcome: "failed" };
    expect(resultsViewReset(scope({ filters: filtered }), scope({ filters: { ...filtered } }))).toBe(false);
  });
  it("a filter change resets — the cursor walked the old filter's rows", () => {
    expect(
      resultsViewReset(scope(), scope({ filters: { ...INITIAL_RESULTS_FILTERS, depth: 2 } })),
    ).toBe(true);
  });
  it("a job or engine switch always resets", () => {
    expect(resultsViewReset(scope(), scope({ job: "fp-2" }))).toBe(true);
    expect(resultsViewReset(scope(), scope({ engine: "http://b" }))).toBe(true);
  });
});

describe("resultsExhaustedShort", () => {
  it("claims pruning only when the cursor ended AND fewer rows than attempts", () => {
    expect(resultsExhaustedShort(true, 120, 500)).toBe(true);
    expect(resultsExhaustedShort(true, 500, 500)).toBe(false);
    expect(resultsExhaustedShort(false, 120, 500)).toBe(false);
    expect(resultsExhaustedShort(true, 120, undefined)).toBe(false);
  });

  it("a filtered shortfall is NOT pruning — the filter alone explains it", () => {
    // The regression: a filter matching fewer rows than the job ran fired
    // the retention banner with rows_pruned=false. loaded < total under a
    // filter says nothing about retention; the banner must stay silent.
    expect(resultsExhaustedShort(true, 120, 500, true, false)).toBe(false);
    expect(resultsExhaustedShort(true, 0, 500, true, false)).toBe(false);
  });

  it("a filtered shortfall may claim pruning only when the job reports it", () => {
    expect(resultsExhaustedShort(true, 120, 500, true, true)).toBe(true);
    // Still gated on the proven end and a real shortfall.
    expect(resultsExhaustedShort(false, 120, 500, true, true)).toBe(false);
    expect(resultsExhaustedShort(true, 500, 500, true, true)).toBe(false);
  });

  it("an unfiltered proven shortfall stands even without the rows_pruned flag", () => {
    // Older engines never send rows_pruned; the arithmetic proof (end of ALL
    // stored rows walked, fewer than attempted) is enough.
    expect(resultsExhaustedShort(true, 120, 500, false, false)).toBe(true);
  });
});

describe("resultsLandingState", () => {
  it("a success always re-probes ok — recovering an old latch without remount", () => {
    // Whatever was latched before, a positive answer clears it: an engine
    // upgraded while the page is open re-enables pool mode on the next fetch.
    expect(resultsLandingState({ unsupported: false, gone: null })).toEqual({
      unsupported: false,
      capability: "ok",
    });
  });
  it("a confirmed unsupported page latches old", () => {
    expect(resultsLandingState({ unsupported: true, gone: null })).toEqual({
      unsupported: true,
      capability: "old",
    });
  });
  it("a gone page carries NO capability verdict — eviction is not an old engine", () => {
    // The 404 regression: latching "old" here disabled pool-mode apply on a
    // capable engine whose terminal job was merely evicted from history.
    expect(
      resultsLandingState({ unsupported: false, gone: "No full-probe job..." }),
    ).toEqual({ unsupported: false, capability: null });
  });
});

const vocabJob: FullProbeJob = {
  levels: [
    {
      depth: 1,
      success_paths: [{ hops: ["work"], latency: 100 }],
      failed_items: [{ id: "broken", reason: "connect_timeout" }, { id: "odd", reason: "brand_new_slug" }],
    },
    {
      depth: 2,
      success_paths: [{ hops: ["work", "rescue"], latency: 300 }],
      failed_items: [{ id: "broken", reason: "connect_timeout" }],
    },
    { depth: 1 },
  ],
};

describe("filter vocabularies come from the job snapshot", () => {
  it("depths: the levels' depths, deduped, ascending, never 0", () => {
    expect(resultsDepthChoices(vocabJob)).toEqual([1, 2]);
    expect(resultsDepthChoices(undefined)).toEqual([]);
    expect(resultsDepthChoices({ levels: [{ depth: 0 }] })).toEqual([]);
  });
  it("reasons: every labelled slug plus the job's unlabelled ones, by label", () => {
    const choices = resultsReasonChoices(vocabJob);
    const values = choices.map((c) => c.value);
    // The union: known labels AND the newer engine's slug this build has no
    // word for — offered labelled with the slug itself.
    for (const slug of Object.keys(REASON_LABELS)) expect(values).toContain(slug);
    expect(choices.find((c) => c.value === "brand_new_slug")).toEqual({
      value: "brand_new_slug",
      label: "brand_new_slug",
    });
    expect(choices.find((c) => c.value === "connect_timeout")?.label).toBe(REASON_LABELS.connect_timeout);
    const labels = choices.map((c) => c.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
    expect(new Set(values).size).toBe(values.length);
  });
  it("hops: failed-item ids plus success-path hops, deduped and sorted", () => {
    expect(resultsHopChoices(vocabJob)).toEqual(["broken", "odd", "rescue", "work"]);
    expect(resultsHopChoices(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Apply: form construction and the pool-mode preview
// ---------------------------------------------------------------------------

describe("buildApplySpec", () => {
  it("an untouched inbounds-mode form sends {} — byte-identical to the old page", () => {
    // The load-bearing contract: an older engine's decoder rejects unknown
    // fields outright, so mode/pool_id/selector must not exist on the wire
    // in the default mode — not even as empty strings.
    expect(buildApplySpec("inbounds", INITIAL_APPLY_FIELDS)).toEqual({});
  });

  it("the default mode never carries the pool fields, even when filled in", () => {
    const f = { ...INITIAL_APPLY_FIELDS, poolId: "my-pool", selector: "sticky" };
    const spec = buildApplySpec("inbounds", f);
    expect(spec).not.toHaveProperty("mode");
    expect(spec).not.toHaveProperty("pool_id");
    expect(spec).not.toHaveProperty("selector");
  });

  it("trims and omits the shared knobs", () => {
    const f = {
      ...INITIAL_APPLY_FIELDS,
      protocol: " http ",
      listenPrefix: " 127.0.0.1 ",
      port: 1080,
      idPrefix: " fp ",
    };
    expect(buildApplySpec("inbounds", f)).toEqual({
      protocol: "http",
      listen_prefix: "127.0.0.1",
      port: 1080,
      id_prefix: "fp",
    });
    expect(buildApplySpec("inbounds", { ...f, port: 0 })).not.toHaveProperty("port");
    expect(buildApplySpec("inbounds", { ...f, port: 1.5 })).not.toHaveProperty("port");
  });

  it("pool mode names the mode and always the selector the form shows", () => {
    expect(buildApplySpec("pool", INITIAL_APPLY_FIELDS)).toEqual({
      mode: "pool",
      selector: { type: "roundrobin" },
    });
    const spec = buildApplySpec("pool", { ...INITIAL_APPLY_FIELDS, poolId: " my-pool ", selector: "leastlatency" });
    expect(spec.mode).toBe("pool");
    expect(spec.pool_id).toBe("my-pool");
    expect(spec.selector).toEqual({ type: "leastlatency" });
  });

  it("an empty pool id stays omitted — the engine derives <id_prefix>-pool", () => {
    expect(buildApplySpec("pool", INITIAL_APPLY_FIELDS)).not.toHaveProperty("pool_id");
  });
});

describe("allPathsFastest", () => {
  it("dedupes by hop-join in level order, then sorts fastest first", () => {
    const j: FullProbeJob = {
      levels: [
        { depth: 1, success_paths: [{ hops: ["a"], latency: 300 }, { hops: ["b"], latency: 100 }] },
        { depth: 2, success_paths: [{ hops: ["a"], latency: 50 }, { hops: ["b", "c"], latency: 200 }] },
      ],
    };
    // The level-2 "a" is the same path as level-1's: the first occurrence
    // (latency 300) is what the engine's seen-map keeps before its sort.
    expect(allPathsFastest(j).map((p) => p.hops)).toEqual([["b"], ["b", "c"], ["a"]]);
  });
  it("latency ties keep the shallower path first", () => {
    const j: FullProbeJob = {
      levels: [
        { depth: 2, success_paths: [{ hops: ["a", "b"], latency: 100 }] },
        { depth: 1, success_paths: [{ hops: ["c"], latency: 100 }] },
      ],
    };
    expect(allPathsFastest(j).map((p) => p.hops)).toEqual([["c"], ["a", "b"]]);
  });
  it("no job, no paths", () => {
    expect(allPathsFastest(undefined)).toEqual([]);
  });
});

describe("poolApplyPreview", () => {
  it("counts the deduped paths and promises the one inbound", () => {
    expect(poolApplyPreview(vocabJob)).toBe(
      "2 proved paths → pool members (fastest first, cap 256) · 1 inbound",
    );
  });
  it("caps the member count at the engine's 256", () => {
    const many: FullProbeJob = {
      levels: [
        {
          depth: 1,
          success_paths: Array.from({ length: FULL_PROBE_APPLY_POOL_CAP + 40 }, (_, i) => ({
            hops: [`o${i}`],
            latency: i,
          })),
        },
      ],
    };
    expect(poolApplyPreview(many)).toContain(`${FULL_PROBE_APPLY_POOL_CAP} proved paths`);
  });
  it("says singular for one path and zero for none", () => {
    expect(poolApplyPreview({ levels: [{ success_paths: [{ hops: ["a"] }] }] })).toContain("1 proved path →");
    expect(poolApplyPreview(undefined)).toContain("0 proved paths");
  });
});

describe("poolApplyCapable", () => {
  it("only a positive capability probe unlocks pool mode", () => {
    expect(poolApplyCapable("ok")).toBe(true);
    expect(poolApplyCapable("unknown")).toBe(false);
    expect(poolApplyCapable("old")).toBe(false);
  });
});

describe("appliedForCard", () => {
  const state: AppliedState = {
    engine: "http://a",
    job: "fp-1",
    mode: "pool",
    results: [{ chain_id: "c1" }],
    poolId: "p1",
  };
  it("shows the state only under the engine + job it names", () => {
    expect(appliedForCard(state, "http://a", "fp-1")).toBe(state);
  });
  it("an engine or job switch hides it even before the clearing effects run", () => {
    expect(appliedForCard(state, "http://b", "fp-1")).toBeNull();
    expect(appliedForCard(state, "http://a", "fp-2")).toBeNull();
    expect(appliedForCard(state, "http://a", undefined)).toBeNull();
    expect(appliedForCard(null, "http://a", "fp-1")).toBeNull();
  });
});
