// src/pages/MetricsPage.test.ts — bucketing + grouping helpers used by the
// metrics dashboard (pure functions; no component render in these tests).

import { describe, expect, it } from "vitest";
import type { RequestMetric } from "@goose-network/goose-sdk";
import { byKey, targetHost, timeBuckets } from "./MetricsPage";

// latency arrives on the wire as a nanosecond count, but the generated schema
// type models time.Duration as an enum — so tests build metrics with a plain
// number and widen at the call sites the helpers accept.
type MetricInput = Partial<Omit<RequestMetric, "latency">> & {
  latency?: number;
};

function metric(over: MetricInput): RequestMetric {
  return {
    id: over.id ?? "m1",
    inboundID: "in-1",
    user: "",
    network: "tcp",
    target: "",
    chain: [],
    success: true,
    error: "",
    latency: 0,
    startedAt: "",
    finishedAt: "",
    ...over,
  } as RequestMetric;
}

describe("targetHost", () => {
  it("strips the scheme but keeps host:port and path is dropped", () => {
    expect(targetHost("http://example.com:8080/a/b?q=1")).toBe("example.com:8080");
    expect(targetHost("https://api.example.com/v1")).toBe("api.example.com");
    expect(targetHost("socks5://10.0.0.1:1080")).toBe("10.0.0.1:1080");
  });

  it("returns (unknown) for missing values", () => {
    expect(targetHost(undefined)).toBe("(unknown)");
    expect(targetHost("")).toBe("(unknown)");
  });
});

describe("byKey", () => {
  it("counts occurrences per key", () => {
    const ms = [
      metric({ inboundID: "a" }),
      metric({ inboundID: "b" }),
      metric({ inboundID: "a" }),
    ];
    expect(
      byKey(ms, (m) => m.inboundID ?? "?").sort((x, y) =>
        x.label.localeCompare(y.label),
      ),
    ).toEqual([
      { label: "a", value: 2 },
      { label: "b", value: 1 },
    ]);
  });

  it("handles an empty list", () => {
    expect(byKey([], () => "?")).toEqual([]);
  });
});

describe("timeBuckets", () => {
  const HOUR = 60 * 60_000;
  // The helper uses Date.now() internally, so pin wall-clock expectations
  // loosely — bucket counts and averages only.
  const recent = (minutesAgo: number, m: MetricInput) =>
    metric({
      finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ...m,
    });

  it("returns empty arrays for no data", () => {
    expect(timeBuckets([], HOUR)).toEqual({
      labels: [],
      counts: [],
      failures: [],
      latencies: [],
    });
  });

  it("buckets every request, counts failures, and averages latency", () => {
    const ms = [
      recent(5, { latency: 100e6, success: true }),
      recent(5, { latency: 300e6, success: false }),
      recent(20, { latency: 200e6, success: true }),
    ];
    const b = timeBuckets(ms, HOUR);
    const counted = b.counts.reduce((s: number, c: number) => s + c, 0);
    const failed = b.failures.reduce((s: number, c: number) => s + c, 0);
    expect(counted).toBe(3);
    expect(failed).toBe(1);
    // per-bucket latency is an average in ms
    const nonzero = b.latencies.filter((v) => v > 0);
    expect(nonzero).toContain(200); // (100+300)/2
    expect(nonzero).toContain(200); // 200 alone
  });

  it("labels, counts, failures and latencies stay index-aligned", () => {
    const b = timeBuckets([recent(1, { latency: 50e6 })], 15 * 60_000);
    expect(b.labels.length).toBe(b.counts.length);
    expect(b.counts.length).toBe(b.failures.length);
    expect(b.failures.length).toBe(b.latencies.length);
    expect(b.labels.length).toBeGreaterThan(0);
  });
});
