// src/charts/LineChart.tsx — trend line chart (SVG, no deps).
//
// Implements the dataviz mark specs: 2px lines with round joins, >=8px
// end-markers with a 2px surface ring, hairline solid gridlines, a crosshair
// that snaps to the nearest X with a tooltip that follows it, and a
// table-view twin rendered below (also the accessible fallback).

import { useMemo, useState } from "react";
import { usePlotWidth } from "./usePlotWidth";

export interface Series {
  /** series name; also the legend / tooltip label */
  name: string;
  /** one value per x-tick */
  points: number[];
  /** CSS color (var(--series-1) etc.) */
  color: string;
}

export interface LineChartProps {
  /** x-axis tick labels, one per index */
  xLabels: string[];
  series: Series[];
  /** chart title (also the <figcaption>) */
  title: string;
  /** value formatter for tooltips/labels */
  format?: (v: number) => string;
  height?: number;
}

const PAD = { top: 12, right: 18, bottom: 26, left: 48 };
/** x labels are drawn at most this often; both ends always are */
const MAX_X_LABELS = 6;
/** min plot width per x label, so labels never collide on narrow cards */
const PX_PER_X_LABEL = 90;

export function LineChart({
  xLabels,
  series,
  title,
  format = (v) => String(v),
  height = 220,
}: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  /** pointer x as a fraction of the plot width, for tooltip placement */
  const [pointer, setPointer] = useState(0.5);
  /** viewBox width == rendered width, so axis text keeps its true size */
  const { ref: plotRef, width: WIDTH } = usePlotWidth();

  const n = xLabels.length;

  const { xs, ys, ticks, paths, labelIdx } = useMemo(() => {
    const innerW = WIDTH - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const max = Math.max(1, ...series.flatMap((s) => s.points));
    const maxTick = niceCeil(max);
    const x = (i: number) =>
      PAD.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
    const y = (v: number) => PAD.top + innerH - (innerH * v) / maxTick;
    const ticks = tickValues(maxTick).map((v) => ({ v, y: y(v) }));
    const paths = series.map((s) =>
      s.points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" "),
    );
    const maxLabels = Math.max(
      2,
      Math.min(MAX_X_LABELS, Math.floor(innerW / PX_PER_X_LABEL)),
    );
    return { xs: x, ys: y, ticks, paths, labelIdx: labelIndices(n, maxLabels) };
  }, [xLabels, series, height, n, WIDTH]);

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
    setPointer(rect.width === 0 ? 0.5 : (e.clientX - rect.left) / rect.width);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(xs(i) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <figure className="chart-figure">
      <figcaption>
        {title}
        {series.length >= 2 && (
          <span className="chart-legend" aria-hidden="true">
            {series.map((s) => (
              <span key={s.name} className="chart-legend-item">
                <span className="chart-key" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="chart-plot" ref={plotRef}>
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          role="img"
          aria-label={title}
          style={{ width: "100%", height: "auto", display: "block" }}
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
        >
          {/* gridlines + y ticks (hairline, recessive) */}
          {ticks.map((t) => (
            <g key={t.v}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={t.y}
                y2={t.y}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 7}
                y={t.y + 3.5}
                textAnchor="end"
                className="axis-text"
              >
                {format(t.v)}
              </text>
            </g>
          ))}
          {/* baseline */}
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={height - PAD.bottom}
            y2={height - PAD.bottom}
            stroke="var(--baseline)"
            strokeWidth={1}
          />
          {/* x labels: evenly spaced, first anchored start / last anchored end
              so neither is clipped by the plot edge */}
          {labelIdx.map((i) => (
            <text
              key={i}
              x={xs(i)}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className="axis-text"
            >
              {xLabels[i]}
            </text>
          ))}
          {/* crosshair */}
          {hover !== null && (
            <line
              x1={xs(hover)}
              x2={xs(hover)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
          )}
          {/* series lines + end markers */}
          {series.map((s, si) => (
            <g key={s.name}>
              <path
                d={paths[si]}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {n > 0 && (
                <circle
                  cx={xs(n - 1)}
                  cy={ys(s.points[n - 1] ?? 0)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              )}
              {hover !== null && (
                <circle
                  cx={xs(hover)}
                  cy={ys(s.points[hover] ?? 0)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              )}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            style={{
              left: `${Math.min(0.85, Math.max(0.15, pointer)) * 100}%`,
              top: 8,
            }}
          >
            <div className="chart-tooltip-title">{xLabels[hover]}</div>
            {series.map((s) => (
              <div key={s.name} className="chart-tooltip-row">
                <span className="chart-key" style={{ background: s.color }} />
                <span className="chart-tooltip-name">{s.name}</span>
                <span className="chart-tooltip-val">
                  {format(s.points[hover] ?? 0)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <ChartTable xLabels={xLabels} series={series} format={format} />
    </figure>
  );
}

/** Evenly spaced label indices, always including the first and last. */
export function labelIndices(n: number, max: number): number[] {
  if (n <= 0) return [];
  const k = Math.min(n, max);
  if (k <= 1) return [0];
  const out: number[] = [];
  for (let j = 0; j < k; j++) {
    const i = Math.round((j * (n - 1)) / (k - 1));
    if (out[out.length - 1] !== i) out.push(i);
  }
  return out;
}

function ChartTable({
  xLabels,
  series,
  format,
}: {
  xLabels: string[];
  series: Series[];
  format: (v: number) => string;
}) {
  return (
    <details className="chart-table">
      <summary>Table view</summary>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Data behind the chart</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {series.map((s) => (
                <th key={s.name} className="num" scope="col">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {xLabels
              .map((l, i) => ({ l, i }))
              .reverse()
              .map(({ l, i }) => (
                <tr key={i}>
                  <td>{l}</td>
                  {series.map((s) => (
                    <td key={s.name} className="num">
                      {format(s.points[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function niceCeil(v: number): number {
  if (v <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}

function tickValues(max: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
}
