// src/charts/StatTile.tsx — the figure contract: label + value (+ delta).
// Sparkline rides in the de-emphasis hue with the current period accented.

export interface StatTileProps {
  label: string;
  value: string;
  /** signed delta vs a named period, e.g. "+12% vs last hour" */
  delta?: string;
  /** direction × whether up is good; colors the delta */
  deltaGood?: boolean;
  /** optional 12-point sparkline */
  spark?: number[];
}

export function StatTile({ label, value, delta, deltaGood, spark }: StatTileProps) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {delta !== undefined && (
        <div className={deltaGood ? "stat-delta good" : "stat-delta bad"}>
          {delta}
        </div>
      )}
      {spark !== undefined && spark.length > 1 && <Sparkline points={spark} />}
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const w = 120;
  const h = 28;
  const max = Math.max(1, ...points);
  const path = points
    .map((v, i) => {
      const x = (w * i) / (points.length - 1);
      const y = h - (h * v) / max;
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      className="stat-spark"
      preserveAspectRatio="none"
    >
      <path
        d={path}
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={w}
        cy={h - (h * (points[points.length - 1] ?? 0)) / max}
        r={3}
        fill="var(--series-1)"
      />
    </svg>
  );
}
