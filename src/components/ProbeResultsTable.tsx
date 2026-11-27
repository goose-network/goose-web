// src/components/ProbeResultsTable.tsx — the result columns every HTTP-probe
// table shares: the run card's results, the probe history, and the full-probe
// page's per-job attempt rows all render the same `core.HTTPProbe` model, so
// the columns (and the folded Response detail) live here once.
//
// The builder is a plain function returning DataTable columns over HTTPProbe;
// a caller with a richer row (the run card's probe + verdicts) maps the render
// through its own row shape and splices in whatever extra column it owns.
// `depth` adds the full-probe chain-length column, which only the per-job
// attempt rows carry.

import type { Column } from "./DataTable";
import { PathStrip } from "./PathStrip";
import { formatDuration, formatTime } from "../format";
import type { HTTPProbe } from "../runApi";
import { byteLength, failureLabel, phaseLeg } from "../pages/probeSpec";

/** The shared result columns, in table order: Time / Route / Target / Path /
 *  Method / Status / Failure / Latency / Body / Response, with Depth after
 *  Time when the rows carry it (full-probe attempt rows). */
export function probeResultColumns(
  opts: { depth?: boolean } = {},
): Array<Column<HTTPProbe>> {
  const columns: Array<Column<HTTPProbe>> = [
    { key: "when", header: "Time", className: "nowrap", render: (p) => formatTime(p.startedAt ?? "") },
  ];
  if (opts.depth === true) {
    columns.push({
      key: "depth",
      header: "Depth",
      className: "num",
      // Absent on rows an older engine recorded: "—", not 0 — 0 is not a
      // depth the engine stores, and printing it would invent a measurement.
      render: (p) => (p.depth !== undefined && p.depth > 0 ? p.depth : "—"),
    });
  }
  columns.push(
    { key: "route", header: "Route", className: "mono", render: (p) => p.route || "—" },
    { key: "target", header: "Target", className: "mono", render: (p) => p.target || "—" },
    {
      key: "path",
      header: "Path",
      className: "path",
      render: (p) => (
        <PathStrip
          path={p.path}
          chain={p.route === undefined || p.route === "" ? undefined : [p.route]}
          target={p.target}
        />
      ),
    },
    { key: "method", header: "Method", render: (p) => p.method || "—" },
    {
      key: "status",
      header: "Status",
      className: "nowrap",
      render: (p) =>
        p.success === true ? (
          <span className="pill ok">{p.status ?? 0}</span>
        ) : (
          <span className="pill fail" title={p.error ?? ""}>
            {p.status === undefined || p.status === 0 ? "no response" : p.status}
          </span>
        ),
    },
    {
      // The engine's own attribution: what kind of failure this was, with the
      // leg it broke on and the raw error in the tooltip. "—" on a success and
      // on rows an older engine recorded before classification existed.
      key: "failure",
      header: "Failure",
      className: "nowrap",
      render: (p) => {
        if (p.success === true || (p.error ?? "") === "") return "—";
        const leg = phaseLeg(p.phase, p.route);
        const title = [leg !== undefined ? `broke on the ${leg} leg` : "", p.error ?? ""]
          .filter((s) => s !== "")
          .join(" — ");
        return (
          <span className="pill fail" title={title}>
            {failureLabel(p.phase, p.reason)}
          </span>
        );
      },
    },
    {
      key: "latency",
      header: "Latency",
      className: "num",
      render: (p) => (p.success === true ? formatDuration(p.latency ?? 0) : "—"),
    },
    {
      key: "size",
      header: "Body",
      className: "num",
      render: (p) =>
        p.body === undefined || p.body === ""
          ? "—"
          : `${byteLength(p.body)}${p.truncated === true ? "+ (cut)" : ""}`,
    },
    { key: "response", header: "Response", render: (p) => <ResponseDetail probe={p} /> },
  );
  return columns;
}

/** The response itself, folded away until asked for: bodies are up to a
 *  megabyte and a table of them would bury the verdicts. What is always worth
 *  showing, though, is *where* the request got to: the observed path and the leg
 *  of it that broke, the first-hop address the engine dialed, the outbound that
 *  served it, and the per-phase timings — the strip says which leg gave up, the
 *  timings say how long each phase took, and `Dialed … via …` stays the
 *  one-line answer. */
export function ResponseDetail({ probe }: { probe: HTTPProbe }) {
  const body = probe.body ?? "";
  const error = probe.error ?? "";
  const headers = probe.headers ?? {};
  const names = Object.keys(headers);
  const timings = phaseTimingRows(probe);
  const leg = phaseLeg(probe.phase, probe.route);
  const dialed = probe.dialAddr ?? "";

  if (
    body === "" &&
    error === "" &&
    names.length === 0 &&
    timings.length === 0 &&
    dialed === "" &&
    probe.path === undefined
  ) {
    return <span className="hint">empty</span>;
  }

  return (
    <details className="probe-detail">
      <summary>
        {error !== ""
          ? "error"
          : `${body.length} char${body.length === 1 ? "" : "s"}${
              probe.truncated === true ? " (truncated)" : ""
            }`}
      </summary>
      {/* The observed path first: it names the node and the leg, where the
          phase attribution below names only where the request as a whole gave
          up. The row's configured route goes along so that when the engine
          sent no path the strip synthesizes the ROUTE, not a direct hop that
          contradicts the row's own Route column. */}
      <PathStrip
        path={probe.path}
        chain={
          probe.route === undefined || probe.route === ""
            ? undefined
            : [probe.route]
        }
        target={probe.target}
      />
      {error !== "" && (
        <div className="status-bad probe-error">
          {/* The classified failure first — which leg broke, and how — with
              the engine's raw error under it as the full diagnostic. */}
          <div>
            <strong>{failureLabel(probe.phase, probe.reason)}</strong>
            {leg !== undefined && <span className="hint"> — broke on the {leg} leg</span>}
          </div>
          <div>{error}</div>
        </div>
      )}
      {(dialed !== "" || timings.length > 0) && (
        <dl className="def-grid">
          {dialed !== "" && (
            <div>
              <dt>Dialed</dt>
              <dd className="mono">
                {dialed}
                {probe.dialVia !== undefined && probe.dialVia !== "" && (
                  <span className="hint"> via {probe.dialVia}</span>
                )}
              </dd>
            </div>
          )}
          {timings.map(([label, ns]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{formatDuration(ns)}</dd>
            </div>
          ))}
        </dl>
      )}
      {names.length > 0 && (
        <pre className="probe-body mono">
          {names.map((n) => `${n}: ${headers[n] ?? ""}`).join("\n")}
        </pre>
      )}
      {body !== "" && <pre className="probe-body mono">{body}</pre>}
    </details>
  );
}

/** The engine's per-phase durations in path order, dropping the phases that
 *  did not run or were not observable (an omitted or zero duration — under
 *  gvisor only the route dial is ever present). */
export function phaseTimingRows(p: HTTPProbe): Array<[string, number]> {
  const rows: Array<[string, number | undefined]> = [
    ["route dial", p.routeDial],
    ["DNS", p.dns],
    ["connect", p.connect],
    ["TLS", p.tls],
    ["first byte", p.ttfb],
  ];
  return rows.filter((r): r is [string, number] => r[1] !== undefined && r[1] > 0);
}
