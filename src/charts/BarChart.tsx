// src/charts/BarChart.tsx — horizontal bar chart for magnitude comparison.
//
// Mark specs: <=24px-thick bars with a 4px rounded data-end and square
// baseline, one series = one color (slot 1), 2px surface gap between
// adjacent bars, direct value labels in ink (never the series color),
// per-mark hover with a tooltip, and a table-view twin.
//
// The label gutter is measured from the data, not fixed: hostnames and
// inbound ids vary wildly in length and a fixed 120px clipped the long ones.

import { useState } from "react";
import { usePlotWidth } from "./usePlotWidth";

export interface BarDatum {
  label: string;
  value: number;
}

export interface BarChartProps {
  data: BarDatum[];
  title: string;
  format?: (v: number) => string;
  /** max bars shown; the rest fold into "Other" */
  maxBars?: number;
  height?: number;
}

const BAR = 18; // < 24px cap
const GAP = 2; // surface gap between adjacent bars
const ROW_STEP = BAR + GAP + 8;
const PAD = { top: 8, right: 16, bottom: 8, left: 16 };
/** ~6.2px per character at the 11px axis size, plus breathing room */
const CHAR_W = 6.2;
const MAX_GUTTER = 210;

export function BarChart({
  data,
  title,
  format = (v) => String(v),
  maxBars = 8,
  height,
}: BarChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  /** viewBox width == rendered width, so axis text keeps its true size */
  const { ref: wrapRef, width: WIDTH } = usePlotWidth();

  const { rows, total } = barRows(data, maxBars);
  const h = height ?? PAD.top + PAD.bottom + Math.max(1, rows.length) * ROW_STEP;

  // Gutters sized to the content: labels on the left, values on the right.
  // The cap also shrinks with the card, so a narrow column keeps room for
  // the bars themselves instead of spending half of it on the gutter.
  const gutter = Math.min(
    MAX_GUTTER,
    Math.floor(WIDTH * 0.45),
    Math.max(64, Math.ceil(Math.max(0, ...rows.map((r) => r.label.length)) * CHAR_W) + 12),
  );
  const valueW =
    Math.ceil(Math.max(0, ...rows.map((r) => format(r.value).length)) * CHAR_W) + 10;
  const left = PAD.left + gutter;
  const innerW = Math.max(40, WIDTH - left - PAD.right - valueW);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const maxChars = Math.max(6, Math.floor((gutter - 10) / CHAR_W));

  const track = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const hovered = hover === null ? undefined : rows[hover];

  return (
    <figure className="chart-figure">
      <figcaption>{title}</figcaption>
      <div className="chart-plot" ref={wrapRef}>
        <svg
          viewBox={`0 0 ${WIDTH} ${h}`}
          role="img"
          aria-label={title}
          style={{ width: "100%", height: "auto", display: "block" }}
          onPointerMove={track}
          onPointerLeave={() => setHover(null)}
        >
          {/* baseline (y axis) */}
          <line
            x1={left}
            x2={left}
            y1={PAD.top - 4}
            y2={h - PAD.bottom + 4}
            stroke="var(--baseline)"
            strokeWidth={1}
          />
          {rows.map((r, i) => {
            const y = PAD.top + i * ROW_STEP;
            const w = (innerW * r.value) / max;
            const isHover = hover === i;
            return (
              <g
                key={r.label}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                role="row"
                aria-label={`${r.label}: ${format(r.value)}`}
                className="chart-hit"
              >
                {/* hit area covers the whole row, not just the bar */}
                <rect x={0} y={y - 4} width={WIDTH} height={BAR + 8} fill="transparent" />
                <rect
                  x={left}
                  y={y}
                  width={Math.max(w, 2)}
                  height={BAR}
                  rx={4}
                  ry={4}
                  fill="var(--series-1)"
                  opacity={hover === null || isHover ? 1 : 0.55}
                />
                <text
                  x={left - 8}
                  y={y + BAR / 2 + 4}
                  textAnchor="end"
                  className={isHover ? "axis-text strong" : "axis-text"}
                >
                  {r.label.length > maxChars ? <title>{r.label}</title> : null}
                  {truncate(r.label, maxChars)}
                </text>
                <text
                  x={left + Math.max(w, 2) + 7}
                  y={y + BAR / 2 + 4}
                  className={isHover ? "axis-text strong" : "axis-text"}
                >
                  {format(r.value)}
                </text>
              </g>
            );
          })}
          {rows.length === 0 && (
            <text x={WIDTH / 2} y={h / 2} textAnchor="middle" className="axis-text">
              no data
            </text>
          )}
        </svg>
        {hovered !== undefined && (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            style={{
              left: `${Math.min(88, Math.max(12, (pos.x / (wrapRef.current?.clientWidth ?? WIDTH)) * 100))}%`,
              top: Math.max(0, pos.y - 12),
            }}
          >
            <div className="chart-tooltip-title">{hovered.label}</div>
            <div className="chart-tooltip-row">
              <span className="chart-key" style={{ background: "var(--series-1)" }} />
              <span className="chart-tooltip-name">requests</span>
              <span className="chart-tooltip-val">{format(hovered.value)}</span>
            </div>
            {total > 0 && (
              <div className="chart-tooltip-row">
                <span className="chart-key" style={{ background: "transparent" }} />
                <span className="chart-tooltip-name">share</span>
                <span className="chart-tooltip-val">
                  {((hovered.value / total) * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      {rows.length === 0 && total === 0 && (
        <div className="empty" style={{ padding: "8px 0" }}>
          No data in range.
        </div>
      )}
      <details className="chart-table">
        <summary>Table view</summary>
        <div className="table-wrap">
          <table className="data">
            <caption className="sr-only">Data behind the chart</caption>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col" className="num">
                  Value
                </th>
                <th scope="col" className="num">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="mono">{r.label}</td>
                  <td className="num">{format(r.value)}</td>
                  <td className="num">
                    {total > 0 ? `${((r.value / total) * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** Clip a label to the gutter, keeping the identifying tail (host:port). */
export function truncate(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label;
  return `…${label.slice(label.length - maxChars + 1)}`;
}

interface Row extends BarDatum {
  other?: boolean;
}

export function barRows(
  data: BarDatum[],
  maxBars: number,
): { rows: Row[]; total: number } {
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, d) => s + d.value, 0);
  if (sorted.length <= maxBars) return { rows: sorted, total };
  const head = sorted.slice(0, maxBars - 1);
  const rest = sorted.slice(maxBars - 1);
  return {
    rows: [
      ...head,
      { label: "Other", value: rest.reduce((s, d) => s + d.value, 0), other: true },
    ],
    total,
  };
}
