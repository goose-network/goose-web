// src/pages/ExitChecksPage.test.ts — derivations behind the exit-IP page:
// latest-per-outbound (history is newest-first), the outbound id index, and the
// row attribution that lets a detached round's polling recognize its own rows.

import { describe, expect, it } from "vitest";
import type { ExitCheck } from "@goose-network/goose-sdk";
import { latestPerOutbound, outboundIDs, rowsSince } from "./ExitChecksPage";

// latency arrives on the wire as a nanosecond count, but the generated schema
// type models time.Duration as an enum — tests build checks with a plain
// number and widen, the same workaround MetricsPage uses.
type CheckInput = Partial<Omit<ExitCheck, "latency" | "outboundID">> & {
  latency?: number;
  outboundID?: string | undefined;
};

function check(over: CheckInput): ExitCheck {
  return {
    id: over.id ?? "c",
    outboundID: over.outboundID ?? "ob",
    site: over.site ?? "ifconfig.me",
    exitIP: over.exitIP ?? "",
    success: over.success ?? false,
    error: over.error ?? "",
    latency: 0,
    startedAt: over.startedAt ?? "",
    ...over,
  } as ExitCheck;
}

describe("latestPerOutbound", () => {
  it("keeps the first (newest) record per outbound", () => {
    const checks = [
      check({ id: "c3", outboundID: "a", exitIP: "5.6.7.8", success: true }),
      check({ id: "c2", outboundID: "b", exitIP: "", success: false, error: "timeout" }),
      check({ id: "c1", outboundID: "a", exitIP: "1.2.3.4", success: true }),
    ];
    const latest = latestPerOutbound(checks);
    expect(latest.get("a")?.id).toBe("c3");
    expect(latest.get("b")?.id).toBe("c2");
    expect(latest.size).toBe(2);
  });

  it("keeps a failed latest rather than hunting for an older success", () => {
    const checks = [
      check({ id: "new", outboundID: "a", success: false, error: "refused" }),
      check({ id: "old", outboundID: "a", exitIP: "1.2.3.4", success: true }),
    ];
    expect(latestPerOutbound(checks).get("a")?.id).toBe("new");
  });

  it("ignores records without an outbound id", () => {
    const checks = [check({ id: "x", outboundID: undefined })];
    expect(latestPerOutbound(checks).size).toBe(0);
  });
});

describe("outboundIDs", () => {
  it("deduplicates and sorts", () => {
    const checks = [
      check({ outboundID: "b" }),
      check({ outboundID: "a" }),
      check({ outboundID: "b" }),
    ];
    expect(outboundIDs(checks)).toEqual(["a", "b"]);
  });

  it("returns an empty list for no data", () => {
    expect(outboundIDs([])).toEqual([]);
  });
});

describe("rowsSince", () => {
  // A run started at 05:09; the engine's own timestamps are only used in the
  // no-baseline fallback, so the exact value here does not matter.
  const started = Date.parse("2026-11-08T05:09:00Z");

  it("takes the rows newer than the pre-run baseline", () => {
    const rows = [check({ id: "c3" }), check({ id: "c2" }), check({ id: "c1" })];
    expect(rowsSince(rows, "c1", started).map((c) => c.id)).toEqual(["c3", "c2"]);
  });

  it("reads a baseline that is still the newest as nothing recorded yet", () => {
    const rows = [check({ id: "c2" }), check({ id: "c1" })];
    expect(rowsSince(rows, "c2", started)).toEqual([]);
  });

  it("does not invent rows for a baseline it cannot find", () => {
    // Pushed out of the fetched window, or a round that has written nothing:
    // either way, attributing the whole page to this run would be a guess.
    expect(rowsSince([check({ id: "c9" })], "gone", started)).toEqual([]);
  });

  it("falls back to timestamps when there is no baseline", () => {
    const rows = [
      check({ id: "new", startedAt: "2026-11-08T05:09:30Z" }),
      check({ id: "old", startedAt: "2026-11-08T04:00:00Z" }),
    ];
    expect(rowsSince(rows, undefined, started).map((c) => c.id)).toEqual(["new"]);
  });

  it("skips a row with no parseable timestamp in the fallback", () => {
    expect(rowsSince([check({ id: "x", startedAt: "" })], undefined, started)).toEqual([]);
  });
});
