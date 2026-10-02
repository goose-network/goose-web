// src/format.ts — display helpers for engine values.

/** Formats a Go time.Duration (JSON-encoded as nanoseconds) for humans. */
export function formatDuration(ns: number | undefined): string {
  if (ns === undefined || Number.isNaN(ns)) return "—";
  if (ns < 1_000) return `${ns}ns`;
  const us = ns / 1_000;
  if (us < 1_000) return `${round(us)}µs`;
  const ms = us / 1_000;
  if (ms < 1_000) return `${round(ms)}ms`;
  const s = ms / 1_000;
  if (s < 60) return `${round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${round(s - m * 60)}s`;
}

function round(v: number): string {
  return v >= 100 ? Math.round(v).toString() : v.toFixed(v >= 10 ? 0 : 1);
}

/** Compact count: 1,284 / 12.9K / 4.2M. Proportional figures (stat-tile use). */
export function compact(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return `${trim(n / 1_000)}K`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(v: number): string {
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1);
}

/** Localized HH:MM:SS for a metric timestamp. */
export function formatTime(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
