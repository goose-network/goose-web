// src/pages/MetricsPage.test.ts — bucketing + grouping helpers and the row
// filter's search text, all used by the metrics dashboard (pure functions; no
// component render in these tests).

import { describe, expect, it } from "vitest";
import { matches } from "../components/SearchInput";
import type { PathGraph } from "../runApi";
import {
  byKey,
  metricHaystack,
  targetHost,
  timeBuckets,
  type RequestMetric,
} from "./MetricsPage";

// latency arrives on the wire as a nanosecond count, but the generated schema
// type models time.Duration as an enum — so tests build metrics with a plain
// number and widen at the call sites the helpers accept. The row type here is
// the page's own, i.e. the SDK's widened with `reason` and `path`, so a
// fixture can carry an observed path the pinned SDK knows nothing about.
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

describe("metricHaystack", () => {
  // A request that died on its first dial: the router seeds local + target
  // before anything dials, so the target is a node no leg reached. The row
  // itself carries no `reason` — the classifier bounded away from this one —
  // so every classification token below can only have come from the path.
  const DEAD_ON_DIAL: PathGraph = {
    nodes: [
      { id: "local", kind: "local" },
      {
        id: "proxy:relay-1",
        kind: "proxy",
        outboundID: "relay-1",
        address: "203.0.113.9:8443",
        addressSource: "socket",
      },
      {
        id: "target",
        kind: "target",
        address: "example.com:443",
        addressSource: "configured",
        host: "example.com",
        port: "443",
      },
    ],
    edges: [
      {
        from: "local",
        to: "proxy:relay-1",
        kind: "dial",
        target: "203.0.113.9:8443",
        duration: 12_000_000,
        observed: true,
        success: false,
        error: "dial tcp 203.0.113.9:8443: connect: connection refused",
        phase: "connect",
        reason: "connect_refused",
      },
    ],
  };

  // A pool failover that eventually won: attempt 1 was refused, attempt 2
  // carried the request, so the ROW succeeded while its path still holds a
  // failed leg — the case the success gate has to survive.
  const FAILOVER_WON: PathGraph = {
    nodes: [
      { id: "local", kind: "local" },
      {
        id: "proxy:relay-1#1",
        kind: "proxy",
        outboundID: "relay-1",
        address: "203.0.113.9:8443",
        addressSource: "configured",
        attempt: 1,
      },
      {
        id: "proxy:relay-2#2",
        kind: "proxy",
        outboundID: "relay-2",
        address: "198.51.100.7:1080",
        addressSource: "socket",
        attempt: 2,
      },
      {
        id: "target",
        kind: "target",
        address: "example.com:443",
        addressSource: "configured",
        host: "example.com",
        port: "443",
      },
    ],
    edges: [
      {
        from: "local",
        to: "proxy:relay-1#1",
        kind: "dial",
        target: "203.0.113.9:8443",
        duration: 30_000_000_000,
        observed: true,
        success: false,
        error: "dial tcp 203.0.113.9:8443: connect: connection refused",
        phase: "connect",
        reason: "connect_refused",
      },
      {
        from: "local",
        to: "proxy:relay-2#2",
        kind: "dial",
        target: "198.51.100.7:1080",
        duration: 51_000_000,
        observed: true,
        success: true,
      },
      {
        from: "proxy:relay-2#2",
        to: "target",
        kind: "tunnel",
        target: "example.com:443",
        observed: true,
        success: true,
      },
    ],
  };

  it("makes a row findable by the proxy it rode, the address it dialed and the leg's reason", () => {
    const hay = metricHaystack(
      metric({
        target: "https://example.com",
        // The chain names the POOL that was configured; only the path knows
        // which member the request actually rode, so every assertion below is
        // a token the path contributed.
        chain: ["pool:relays"],
        success: false,
        path: DEAD_ON_DIAL,
      }),
    );
    // The proxy the request actually rode, by outbound id and by node id.
    expect(matches(hay, "relay-1")).toBe(true);
    expect(matches(hay, "proxy:relay-1")).toBe(true);
    // The address the leg dialed — the socket peer, which is on no other field.
    expect(matches(hay, "203.0.113.9:8443")).toBe(true);
    // The leg's own classification: slug and raw Go error.
    expect(matches(hay, "connect_refused")).toBe(true);
    expect(matches(hay, "connection refused")).toBe(true);
    // An absent row-level reason still words the status pill as "failed".
    expect(matches(hay, "failed")).toBe(true);
  });

  it("never searches a successful row as failed, even with a failed attempt in its path", () => {
    const hay = metricHaystack(
      metric({
        target: "https://example.com",
        chain: ["pool:relays"],
        success: true,
        path: FAILOVER_WON,
      }),
    );
    expect(matches(hay, "failed")).toBe(false);
    // What the gate removes is the row's STATUS wording, not the losing
    // attempt's detail: it stays findable by id, address and slug.
    expect(matches(hay, "relay-1")).toBe(true);
    expect(matches(hay, "203.0.113.9:8443")).toBe(true);
    expect(matches(hay, "connect_refused")).toBe(true);
    // …and so is the route that won.
    expect(matches(hay, "relay-2")).toBe(true);
    expect(matches(hay, "198.51.100.7:1080")).toBe(true);
  });

  it("adds nothing for a row with no path, and no \"undefined\" token", () => {
    const m = metric({
      target: "https://example.com",
      chain: ["relay-1"],
      success: true,
    });
    const hay = metricHaystack(m);
    expect(hay).not.toContain("undefined");
    // The configured route is still searchable — from the chain, not a path.
    expect(matches(hay, "relay-1")).toBe(true);
    expect(matches(hay, "example.com")).toBe(true);
    // An absent path is exactly an empty graph: nothing extra either way.
    expect(hay).toBe(metricHaystack({ ...m, path: {} }));
  });
});
