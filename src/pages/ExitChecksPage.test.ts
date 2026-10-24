// src/pages/ExitChecksPage.test.ts — derivations behind the exit-IP page:
// latest-per-outbound (history is newest-first) and the outbound id index.

import { describe, expect, it } from "vitest";
import type { ExitCheck } from "@goose-network/goose-sdk";
import { latestPerOutbound, outboundIDs } from "./ExitChecksPage";

// latency arrives on the wire as a nanosecond count, but the generated schema
// type models time.Duration as an enum — tests build checks with a plain
// number and widen, the same workaround MetricsPage uses.
type CheckInput = Partial<Omit<ExitCheck, "latency">> & {
  latency?: number;
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
