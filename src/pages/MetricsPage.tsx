// src/pages/MetricsPage.tsx — recent request metrics: KPI row, request-volume
// trend, latency trend, per-inbound volume, target leaderboard, raw table.
//
// Dataviz rules applied: sequential/one-hue defaults for magnitude forms
// (volume uses one series color; the bars are one series so slot 1 only),
// crosshair + one-tooltip-per-x on lines, per-mark hover on bars, table-view
// twins on every chart, one filter row above everything it scopes, and a
// held (reduced-opacity) render during refresh instead of a skeleton.

import { useEffect, useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
import { LineChart } from "../charts/LineChart";
import { BarChart } from "../charts/BarChart";
import { StatTile } from "../charts/StatTile";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { Notice } from "../components/Notice";
import { SelectField } from "../components/fields";
import { SearchInput, matches } from "../components/SearchInput";
import { compact, formatDuration, formatTime } from "../format";
import type { RequestMetric } from "@goose-network/goose-sdk";
import "../charts/charts.css";

// Time buckets offered to the reader, newest window default. `short` names
// the previous window in KPI deltas ("+12% vs previous 15 min").
const WINDOWS = [
  { label: "Last 15 min", short: "15 min", ms: 15 * 60_000 },
  { label: "Last hour", short: "hour", ms: 60 * 60_000 },
  { label: "Last 6 hours", short: "6 h", ms: 6 * 60 * 60_000 },
  { label: "Last 24 hours", short: "24 h", ms: 24 * 60 * 60_000 },
  { label: "All", short: "window", ms: Number.POSITIVE_INFINITY },
] as const;

const ROW_CHOICES = [100, 500, 1000, 5000] as const;
const PAGE = 50;

export function MetricsPage() {
  return (
    <>
      <PageHeader
        title="Metrics"
        sub="Recent proxied requests served by the engine, newest first."
      />
      <MetricsCard />
    </>
  );
}

function MetricsCard() {
  const { goose } = useSdk();
  const [rows, setRows] = useState<number>(500);
  const [windowIdx, setWindowIdx] = useState<number>(0);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const { data, error, loading, reload } = useAsync(
    () => goose.listMetrics(rows),
    [goose, rows],
  );

  const metrics = data ?? [];
  const now = Date.now();
  const win = WINDOWS[windowIdx] ?? WINDOWS[0]!;
  const windowMs = win.ms;

  const scoped = useMemo(
    () =>
      windowMs === Number.POSITIVE_INFINITY
        ? metrics
        : metrics.filter((m) => now - stamp(m) <= windowMs),
    [metrics, windowMs, now],
  );

  // The equally-sized window just before it, for KPI deltas.
  const previous = useMemo(
    () =>
      windowMs === Number.POSITIVE_INFINITY
        ? []
        : metrics.filter((m) => {
            const age = now - stamp(m);
            return age > windowMs && age <= windowMs * 2;
          }),
    [metrics, windowMs, now],
  );

  const buckets = useMemo(() => timeBuckets(scoped, windowMs), [scoped, windowMs]);
  const cur = stats(scoped);
  const prev = stats(previous);
  const hasPrev = windowMs !== Number.POSITIVE_INFINITY && previous.length > 0;

  const searched = useMemo(
    () =>
      scoped.filter((m) =>
        matches(
          `${m.inboundID ?? ""} ${m.user ?? ""} ${m.target ?? ""} ${(m.chain ?? []).join(" ")} ${m.error ?? ""}`,
          query,
        ),
      ),
    [scoped, query],
  );
  useEffect(() => setLimit(PAGE), [query, windowIdx, rows]);
  const visible = searched.slice(0, limit);

  const columns: Array<Column<RequestMetric>> = [
    {
      key: "time",
      header: "Time",
      className: "nowrap",
      render: (m) => formatTime(m.finishedAt ?? m.startedAt),
    },
    { key: "inbound", header: "Inbound", className: "mono", render: (m) => m.inboundID || "—" },
    { key: "user", header: "User", render: (m) => m.user || "—" },
    { key: "net", header: "Net", render: (m) => m.network || "—" },
    {
      key: "target",
      header: "Target",
      className: "mono ellipsis",
      render: (m) => <span title={m.target ?? ""}>{m.target || "—"}</span>,
    },
    {
      key: "chain",
      header: "Chain",
      className: "mono ellipsis",
      render: (m) => {
        const chain = (m.chain ?? []).join(" → ");
        return <span title={chain}>{chain || "—"}</span>;
      },
    },
    {
      key: "latency",
      header: "Latency",
      className: "num",
      render: (m) => formatDuration(m.latency ?? 0),
    },
    {
      key: "status",
      header: "Status",
      render: (m) =>
        m.success === true ? (
          <span className="pill ok">ok</span>
        ) : (
          <span className="pill fail" title={m.error ?? ""}>
            failed
          </span>
        ),
    },
  ];

  return (
    <>
      <div className="filter-bar sticky">
        <SelectField
          id="metric-window"
          label="Time range"
          value={String(windowIdx)}
          options={WINDOWS.map((w, i) => ({ value: String(i), label: w.label }))}
          onChange={(v) => setWindowIdx(Number(v))}
        />
        <SelectField
          id="metric-rows"
          label="Rows fetched"
          value={String(rows)}
          options={ROW_CHOICES.map((r) => ({ value: String(r), label: `last ${r}` }))}
          onChange={(v) => setRows(Number(v))}
        />
        <div className="spacer" />
        <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
          {scoped.length} in range · {metrics.length} fetched
        </span>
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error !== null && <Notice onDismiss={reload}>Failed to load metrics: {error}</Notice>}

      {error === null && (
        <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity 0.2s" }}>
          {/* The KPI frame stays put even with no data: a dashboard that
              disappears entirely tells the reader nothing. */}
          <div className="kpi-row">
            <StatTile
              label="Requests in range"
              value={compact(cur.n)}
              delta={hasPrev ? pctDelta(cur.n, prev.n, win.short) : undefined}
              spark={buckets.counts}
            />
            <StatTile
              label="Success rate"
              value={`${(cur.rate * 100).toFixed(1)}%`}
              delta={
                hasPrev
                  ? `${ptsDelta(cur.rate, prev.rate)} vs previous ${win.short}`
                  : undefined
              }
              deltaTone={cur.rate >= prev.rate ? "good" : "bad"}
              spark={rateSeries(buckets)}
            />
            <StatTile
              label="Avg latency"
              value={formatDuration(cur.lat * 1e6)}
              delta={hasPrev ? pctDelta(cur.lat, prev.lat, win.short) : undefined}
              deltaTone={cur.lat <= prev.lat ? "good" : "bad"}
              spark={buckets.latencies}
            />
            <StatTile
              label="Failed"
              value={compact(cur.failed)}
              delta={hasPrev ? pctDelta(cur.failed, prev.failed, win.short) : undefined}
              deltaTone={cur.failed <= prev.failed ? "good" : "bad"}
              spark={buckets.failures}
            />
          </div>

          {metrics.length === 0 ? (
            <div className="card">
              <EmptyState
                title="No metrics recorded yet"
                hint="Send traffic through an inbound and it shows up here within a second."
              />
            </div>
          ) : (
            <>
            <div className="card">
              <LineChart
                title="Requests over time"
                xLabels={buckets.labels}
                series={[
                  { name: "all", points: buckets.counts, color: "var(--series-1)" },
                  { name: "failed", points: buckets.failures, color: "var(--series-2)" },
                ]}
                format={(v) => compact(v)}
              />
            </div>

            <div className="grid-2">
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
                  height={200}
                />
              </div>

              <div className="card">
                <BarChart
                  title="Requests by inbound"
                  data={byKey(scoped, (m) => m.inboundID ?? "(unknown)")}
                  format={compact}
                />
              </div>
            </div>

            <div className="card">
              <BarChart
                title="Top targets"
                data={byKey(scoped, (m) => targetHost(m.target))}
                format={compact}
                maxBars={10}
              />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Recent requests</h2>
                <div className="spacer" />
                <SearchInput
                  id="metric-search"
                  value={query}
                  onChange={setQuery}
                  placeholder="Filter by target, inbound, user, error…"
                />
              </div>
              <DataTable
                caption="Recent proxied requests"
                columns={columns}
                rows={visible}
                rowKey={(m) => m.id ?? `${m.startedAt ?? ""}-${m.target ?? ""}`}
                loading={loading}
                empty={
                  scoped.length === 0 ? (
                    <EmptyState
                      title="No requests in this range"
                      hint={`Nothing recorded in the ${win.label.toLowerCase()}.`}
                    />
                  ) : (
                    <EmptyState
                      title="No requests match"
                      hint={`Nothing matches “${query}”.`}
                      action={
                        <button type="button" className="ghost" onClick={() => setQuery("")}>
                          Clear filter
                        </button>
                      }
                    />
                  )
                }
                foot={
                  searched.length > 0 ? (
                    <div className="table-foot">
                      <span>
                        Showing {visible.length} of {searched.length}
                        {searched.length !== scoped.length
                          ? ` (filtered from ${scoped.length})`
                          : ""}
                      </span>
                      <div className="spacer" />
                      {searched.length > visible.length && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => setLimit(limit + PAGE)}
                        >
                          Load {Math.min(PAGE, searched.length - visible.length)} more
                        </button>
                      )}
                    </div>
                  ) : undefined
                }
              />
            </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Wall-clock ms for a metric (finished when known, else started). */
function stamp(m: RequestMetric): number {
  return new Date(m.finishedAt ?? m.startedAt ?? 0).getTime();
}

interface Stats {
  n: number;
  failed: number;
  /** 0..1 */
  rate: number;
  /** average latency in ms */
  lat: number;
}

function stats(ms: RequestMetric[]): Stats {
  const n = ms.length;
  const failed = ms.filter((m) => m.success !== true).length;
  return {
    n,
    failed,
    rate: n === 0 ? 0 : (n - failed) / n,
    lat: n === 0 ? 0 : ms.reduce((s, m) => s + (m.latency ?? 0), 0) / n / 1e6,
  };
}

/** Signed percent change against the previous window. */
function pctDelta(cur: number, prev: number, windowLabel: string): string {
  if (prev === 0)
    return cur === 0
      ? `no change vs previous ${windowLabel}`
      : `new vs previous ${windowLabel}`;
  const d = ((cur - prev) / prev) * 100;
  return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(0)}% vs previous ${windowLabel}`;
}

/** Signed percentage-point change for rates. */
function ptsDelta(cur: number, prev: number): string {
  const d = (cur - prev) * 100;
  return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} pts`;
}

/** Per-bucket success rate, for the success-rate sparkline. */
function rateSeries(b: { counts: number[]; failures: number[] }): number[] {
  return b.counts.map((c, i) => (c === 0 ? 0 : (c - (b.failures[i] ?? 0)) / c));
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
