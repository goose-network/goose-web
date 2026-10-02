// src/pages/MetricsPage.tsx — recent request metrics: KPI row, request-volume
// trend, latency trend, per-inbound volume, target leaderboard, raw table.
//
// Dataviz rules applied: sequential/one-hue defaults for magnitude forms
// (volume uses one series color; the bars are one series so slot 1 only),
// crosshair + one-tooltip-per-x on lines, per-mark hover on bars, table-view
// twins on every chart, one filter row above everything it scopes, and a
// held (reduced-opacity) render during refresh instead of a skeleton.

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
import { LineChart } from "../charts/LineChart";
import { BarChart } from "../charts/BarChart";
import { StatTile } from "../charts/StatTile";
import { compact, formatDuration, formatTime } from "../format";
import type { RequestMetric } from "@goose-network/goose-sdk";
import "../charts/charts.css";

// Time buckets offered to the reader, newest window default.
const WINDOWS = [
  { label: "Last 15 min", ms: 15 * 60_000 },
  { label: "Last hour", ms: 60 * 60_000 },
  { label: "Last 6 hours", ms: 6 * 60 * 60_000 },
  { label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { label: "All", ms: Number.POSITIVE_INFINITY },
] as const;

const ROW_CHOICES = [100, 500, 1000, 5000] as const;

export function MetricsPage() {
  return (
    <>
      <h1 className="page-title">Metrics</h1>
      <p className="page-sub">
        Recent proxied requests served by the engine, newest first.
      </p>
      <MetricsCard />
    </>
  );
}

function MetricsCard() {
  const { goose } = useSdk();
  const [rows, setRows] = useState<number>(500);
  const [windowIdx, setWindowIdx] = useState<number>(0);

  const { data, error, loading, reload } = useAsync(
    () => goose.listMetrics(rows),
    [goose, rows],
  );

  const metrics = data ?? [];
  const now = Date.now();
  const windowMs = WINDOWS[windowIdx]?.ms ?? WINDOWS[0]!.ms;
  const scoped = useMemo(
    () =>
      windowMs === Number.POSITIVE_INFINITY
        ? metrics
        : metrics.filter(
            (m) =>
              now - new Date(m.finishedAt ?? m.startedAt ?? 0).getTime() <=
              windowMs,
          ),
    [metrics, windowMs, now],
  );

  const buckets = useMemo(() => timeBuckets(scoped, windowMs), [scoped, windowMs]);
  const successRate =
    scoped.length === 0
      ? 0
      : scoped.filter((m) => m.success === true).length / scoped.length;
  const avgLatency =
    scoped.length === 0
      ? 0
      : scoped.reduce((s, m) => s + (m.latency ?? 0), 0) / scoped.length / 1e6;

  return (
    <>
      <div className="metrics-filters">
        <div className="field">
          <label htmlFor="metric-window">Time range</label>
          <select
            id="metric-window"
            value={windowIdx}
            onChange={(e) => setWindowIdx(Number(e.target.value))}
          >
            {WINDOWS.map((w, i) => (
              <option key={w.label} value={i}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="metric-rows">Rows fetched</label>
          <select
            id="metric-rows"
            value={rows}
            onChange={(e) => setRows(Number(e.target.value))}
          >
            {ROW_CHOICES.map((r) => (
              <option key={r} value={r}>
                last {r}
              </option>
            ))}
          </select>
        </div>
        <div className="spacer" />
        <button onClick={reload} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error !== null && (
        <div className="error-box">Failed to load metrics: {error}</div>
      )}
      {error === null && metrics.length === 0 && !loading && (
        <div className="empty">No metrics recorded yet.</div>
      )}

      {metrics.length > 0 && (
        <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity 0.2s" }}>
          <div className="kpi-row">
            <StatTile label="Requests in range" value={compact(scoped.length)} />
            <StatTile
              label="Success rate"
              value={`${(successRate * 100).toFixed(1)}%`}
            />
            <StatTile label="Avg latency" value={formatDuration(avgLatency * 1e6)} />
          </div>

          <div className="card">
            <LineChart
              title="Requests over time"
              xLabels={buckets.labels}
              series={[
                {
                  name: "all",
                  points: buckets.counts,
                  color: "var(--series-1)",
                },
                {
                  name: "failed",
                  points: buckets.failures,
                  color: "var(--series-2)",
                },
              ]}
              format={(v) => compact(v)}
            />
          </div>

          <div className="card">
            <LineChart
              title="Average latency over time"
              xLabels={buckets.labels}
              series={[
                {
                  name: "avg latency",
                  points: buckets.latencies,
                  color: "var(--series-1)",
                },
              ]}
              format={(v) => formatDuration(v * 1e6)}
            />
          </div>

          <div className="card">
            <BarChart
              title="Requests by inbound"
              data={byKey(scoped, (m) => m.inboundID ?? "(unknown)")}
              format={compact}
            />
          </div>

          <div className="card">
            <BarChart
              title="Top targets"
              data={byKey(scoped, (m) => targetHost(m.target))}
              format={compact}
            />
          </div>

          <div className="card">
            <h2>Recent requests</h2>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Inbound</th>
                    <th>User</th>
                    <th>Net</th>
                    <th>Target</th>
                    <th>Chain</th>
                    <th className="num">Latency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scoped.slice(0, 100).map((m) => (
                    <MetricRow key={m.id} m={m} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MetricRow({ m }: { m: RequestMetric }) {
  return (
    <tr>
      <td>{formatTime(m.finishedAt ?? m.startedAt)}</td>
      <td className="mono">{m.inboundID || "—"}</td>
      <td>{m.user || "—"}</td>
      <td>{m.network || "—"}</td>
      <td className="mono" style={{ maxWidth: 260 }}>
        {m.target || "—"}
      </td>
      <td className="mono" style={{ maxWidth: 200 }}>
        {(m.chain ?? []).join(" → ") || "—"}
      </td>
      <td className="num">{formatDuration(m.latency ?? 0)}</td>
      <td>
        {m.success === true ? (
          <span className="pill ok">ok</span>
        ) : (
          <span className="pill fail" title={m.error ?? ""}>
            failed
          </span>
        )}
      </td>
    </tr>
  );
}

interface Buckets {
  labels: string[];
  counts: number[];
  failures: number[];
  latencies: number[]; // avg ms per bucket
}

/** Bucket the window into ~16 time slices, oldest -> newest. */
export function timeBuckets(
  metrics: RequestMetric[],
  windowMs: number,
): Buckets {
  if (metrics.length === 0)
    return { labels: [], counts: [], failures: [], latencies: [] };

  const times = metrics.map((m) =>
    new Date(m.finishedAt ?? m.startedAt ?? 0).getTime(),
  );
  const now = Math.max(...times, Date.now() - 1000);
  const span = windowMs === Number.POSITIVE_INFINITY ? now - Math.min(...times) : windowMs;
  const start = now - span;
  const n = span <= 0 ? 1 : Math.min(16, Math.max(4, Math.round(span / 60_000)));
  const size = span / n;

  const labels: string[] = [];
  const counts = new Array<number>(n).fill(0);
  const failures = new Array<number>(n).fill(0);
  const latSum = new Array<number>(n).fill(0);

  for (let i = 0; i < metrics.length; i++) {
    const t = times[i]!;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((t - start) / size)));
    counts[idx] = (counts[idx] ?? 0) + 1;
    if (metrics[i]?.success !== true) failures[idx] = (failures[idx] ?? 0) + 1;
    latSum[idx] = (latSum[idx] ?? 0) + (metrics[i]?.latency ?? 0) / 1e6;
  }

  for (let i = 0; i < n; i++) {
    const t = new Date(start + (i + 0.5) * size);
    labels.push(
      t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    );
  }
  return {
    labels,
    counts,
    failures,
    latencies: counts.map((c, i) => (c === 0 ? 0 : (latSum[i] ?? 0) / c)),
  };
}

export function byKey(
  metrics: RequestMetric[],
  key: (m: RequestMetric) => string,
) {
  const counts = new Map<string, number>();
  for (const m of metrics) {
    const k = key(m);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([label, value]) => ({ label, value }));
}

export function targetHost(target: string | undefined): string {
  if (target === undefined || target === "") return "(unknown)";
  // strip scheme; keep host:port
  const t = target.replace(/^[a-z0-9+.-]+:\/\//i, "");
  return t.split("/")[0] ?? t;
}
