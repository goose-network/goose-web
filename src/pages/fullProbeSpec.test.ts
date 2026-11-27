// src/pages/fullProbeSpec.test.ts — the full-probe page's pure logic: the
// form's validation and wire mapping, the progress math over a job's levels,
// and the default path selection a no-body apply builds from (the browser's
// mirror of the engine's BestPaths — they must agree, or the page would
// promise inbounds the engine builds differently).

import { describe, expect, it } from "vitest";
import {
  bestPaths,
  buildFullProbeRequest,
  FULL_PROBE_CAPS,
  fullProbeFormProblems,
  fullProbeProgress,
  fullProbeRunning,
  INITIAL_FULL_PROBE_FIELDS,
  levelSummaries,
  pathLabel,
  statePill,
} from "./fullProbeSpec";
import type { FullProbeJob } from "../fullProbeApi";

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