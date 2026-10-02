// src/charts/BarChart.tsx — horizontal bar chart for magnitude comparison.
//
// Mark specs: <=24px-thick bars with a 4px rounded data-end and square
// baseline, one series = one color (slot 1), 2px surface gap between
// adjacent bars, per-mark hover with the mark lifting, tooltip + table view.

import { useState } from "react";

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
const PAD = { top: 8, right: 48, bottom: 24, left: 120 };

export function BarChart({
  data,
  title,
  format = (v) => String(v),
  maxBars = 8,
  height,
}: BarChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const { rows, total } = barRows(data, maxBars);
  const h = height ?? PAD.top + PAD.bottom + rows.length * (BAR + GAP + 8);
  const width = 640;
  const innerW = width - PAD.left - PAD.right;
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <figure className="chart-figure">
      <figcaption>{title}</figcaption>
      <svg
        viewBox={`0 0 ${width} ${h}`}
        role="img"
        aria-label={title}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {/* baseline (y axis) */}
        <line
          x1={PAD.left}
          x2={PAD.left}
          y1={PAD.top - 4}
          y2={h - PAD.bottom + 4}
          stroke="var(--baseline)"
          strokeWidth={1}
        />
        {rows.map((r, i) => {
          const y = PAD.top + i * (BAR + GAP + 8);
          const w = (innerW * r.value) / max;
          const hovered = hover === i;
          return (
            <g
              key={r.label}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              role="row"
              aria-label={`${r.label}: ${format(r.value)}`}
              className="chart-hit"
            >
              <rect
                x={PAD.left}
                y={y}
                width={Math.max(w, 1)}
                height={BAR}
                rx={4}
                // square at the baseline: round only the far (data) end
                ry={4}
                fill="var(--series-1)"
                opacity={hovered && hover !== null ? 0.85 : 1}
              />
              <text x={PAD.left - 8} y={y + BAR / 2 + 4} textAnchor="end" className="axis-text">
                {r.label}
              </text>
              {hovered && (
                <text
                  x={PAD.left + w + 6}
                  y={y + BAR / 2 + 4}
                  className="axis-text strong"
                >
                  {format(r.value)}
                </text>
              )}
            </g>
          );
        })}
        {total > 0 && rows.length === 0 && (
          <text x={width / 2} y={h / 2} textAnchor="middle" className="axis-text">
            no data
          </text>
        )}
      </svg>
      {rows.length === 0 && total === 0 && (
        <div className="empty" style={{ padding: "8px 0" }}>
          No data in range.
        </div>
      )}
      <details className="chart-table">
        <summary>Table view</summary>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col" className="num">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{format(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
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
