// src/pages/fullProbeSpec.ts — the full-probe page's pure logic: form →
// wire spec, progress math over a job's levels, and the default path
// selection the apply step builds from. No DOM, no fetch — vitest covers it
// directly.

import type {
  FullProbeJob,
  FullProbePath,
  FullProbeRunRequest,
} from "../fullProbeApi";
import { httpUrl } from "../validate";

/** The engine's caps (internal/core/fullprobe.go). The form clamps to them
 *  so a reader sees the effective value rather than a silently-capped one. */
export const FULL_PROBE_CAPS = {
  maxDepth: 5,
  maxRPS: 10000,
  maxTimeoutSec: 60,
  maxConcurrency: 16384,
} as const;

/** The engine's defaults for an omitted field. */
export const FULL_PROBE_DEFAULTS = {
  depth: 5,
  rps: 100,
  timeoutSec: 10,
} as const;

/** Target presets: the same connectivity-check URLs the Probe page offers,
 *  minus the rate-limited ones — a sweep at high rps must not lean on a
 *  third party that throttles after a handful of requests. */
export const FULL_PROBE_TARGET_PRESETS: Array<{ url: string; note: string }> = [
  { url: "https://www.gstatic.com/generate_204", note: "empty 204, cheap" },
  { url: "http://connectivitycheck.gstatic.com/generate_204", note: "plain HTTP" },
  { url: "https://example.com", note: "static page" },
];

/** The form's fields. Numbers are 0 for "use the engine default" — the same
 *  convention the engine's spec uses on the wire. */
export interface FullProbeFields {
  target: string;
  timeoutSec: number;
  maxDepth: number;
  rps: number;
  concurrency: number;
}

export const INITIAL_FULL_PROBE_FIELDS: FullProbeFields = {
  target: "",
  timeoutSec: 0,
  maxDepth: 0,
  rps: 0,
  concurrency: 0,
};

/** Validation problems with the form, keyed by field. Empty object = ok. */
export function fullProbeFormProblems(
  f: FullProbeFields,
): Partial<Record<keyof FullProbeFields, string>> {
  const out: Partial<Record<keyof FullProbeFields, string>> = {};
  const target = httpUrl(f.target, "Use an absolute http(s) URL");
  if (target !== null) out.target = target;
  if (f.timeoutSec < 0 || f.timeoutSec > FULL_PROBE_CAPS.maxTimeoutSec) {
    out.timeoutSec = `0–${FULL_PROBE_CAPS.maxTimeoutSec} seconds (0 = default ${FULL_PROBE_DEFAULTS.timeoutSec})`;
  }
  if (f.maxDepth < 0 || f.maxDepth > FULL_PROBE_CAPS.maxDepth) {
    out.maxDepth = `0–${FULL_PROBE_CAPS.maxDepth} (0 = default ${FULL_PROBE_DEFAULTS.depth})`;
  }
  if (f.rps < 0 || f.rps > FULL_PROBE_CAPS.maxRPS) {
    out.rps = `0–${FULL_PROBE_CAPS.maxRPS} (0 = default ${FULL_PROBE_DEFAULTS.rps})`;
  }
  if (f.concurrency < 0 || f.concurrency > FULL_PROBE_CAPS.maxConcurrency) {
    out.concurrency = `0–${FULL_PROBE_CAPS.maxConcurrency} (0 = derive from rps)`;
  }
  return out;
}

/** Form → `POST /api/probes/full` body. Zero fields are omitted so the
 *  engine's own defaults apply (and the job's stored spec shows them). */
export function buildFullProbeRequest(f: FullProbeFields): FullProbeRunRequest {
  const req: FullProbeRunRequest = { target: f.target.trim() };
  if (f.timeoutSec > 0) req.timeout_seconds = f.timeoutSec;
  if (f.maxDepth > 0) req.max_depth = f.maxDepth;
  if (f.rps > 0) req.rps = f.rps;
  if (f.concurrency > 0) req.concurrency = f.concurrency;
  return req;
}

/** True while the job is still sweeping. Absent state (an older engine, a
 *  partial row) is not "running" — polling it would never end. */
export function fullProbeRunning(j: FullProbeJob | undefined): boolean {
  return j?.state === "running";
}

/** The fastest successful path per depth, depth ascending — the browser's
 *  mirror of the engine's BestPaths(), so the page can show what a no-body
 *  apply will build before asking for it. */
export function bestPaths(j: FullProbeJob | undefined): FullProbePath[] {
  const out: FullProbePath[] = [];
  for (const l of j?.levels ?? []) {
    const paths = l.success_paths ?? [];
    if (paths.length === 0) continue;
    let best = paths[0]!;
    for (const p of paths.slice(1)) {
      if ((p.latency ?? 0) < (best.latency ?? 0)) best = p;
    }
    out.push(best);
  }
  return out;
}

/** Whole-job progress: attempts finished over attempts planned so far.
 *  A level's plan is known when the level starts, so this moves while the
 *  sweep runs. Returns null when nothing is planned yet. */
export function fullProbeProgress(
  j: FullProbeJob | undefined,
): { done: number; total: number; pct: number } | null {
  let done = 0;
  let total = 0;
  for (const l of j?.levels ?? []) {
    done += l.done ?? 0;
    total += l.total ?? 0;
  }
  if (total === 0) return null;
  return { done, total, pct: Math.min(100, Math.round((done / total) * 100)) };
}

/** One line per level for the progress table: "depth 2 — 3/4 done, 1 ok,
 *  2 failed". Kept as data so the page renders it and vitest asserts it. */
export interface LevelSummary {
  depth: number;
  done: number;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  finished: boolean;
}

export function levelSummaries(j: FullProbeJob | undefined): LevelSummary[] {
  return (j?.levels ?? []).map((l) => ({
    depth: l.depth ?? 0,
    done: l.done ?? 0,
    total: l.total ?? 0,
    success: l.success ?? 0,
    failed: l.failed ?? 0,
    skipped: l.skipped ?? 0,
    finished: (l.done ?? 0) >= (l.total ?? 0) && (l.total ?? 0) > 0,
  }));
}

/** "local → relay → work → target" for a path's hop list. */
export function pathLabel(p: FullProbePath): string {
  return ["local", ...(p.hops ?? []), "target"].join(" → ");
}

/** The state pill's class + text for a job. */
export function statePill(j: FullProbeJob | undefined): {
  cls: string;
  text: string;
} {
  switch (j?.state) {
    case "running":
      return { cls: "pill warn", text: "running" };
    case "done":
      return { cls: "pill ok", text: "done" };
    case "canceled":
      return { cls: "pill", text: "canceled" };
    case "error":
      return { cls: "pill fail", text: "error" };
    default:
      return { cls: "pill", text: j?.state ?? "unknown" };
  }
}