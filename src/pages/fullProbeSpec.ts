// src/pages/fullProbeSpec.ts — the full-probe page's pure logic: form →
// wire spec, progress math over a job's levels, the default path selection
// the apply step builds from, and the attempt-results card's query/merge/
// reset rules. No DOM, no fetch — vitest covers it directly.

import type {
  FullProbeApplyResult,
  FullProbeApplySpec,
  FullProbeJob,
  FullProbePath,
  FullProbeResultsQuery,
  FullProbeRunRequest,
  FullProbeSelectorSpec,
} from "../fullProbeApi";
import type { HTTPProbe } from "../runApi";
import { httpUrl } from "../validate";
import { REASON_LABELS } from "./probeSpec";

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

/** Validation problems with the form, keyed by field. Empty object = ok.
 *  NumberField emits Number(raw), so a fractional knob ("2.5") or a NaN can
 *  reach here; Number.isInteger rejects both (and Infinity) — bare range
 *  comparisons would let NaN through, since NaN < 0 and NaN > max are both
 *  false. The engine's wire fields are ints, so fractions must not pass. */
export function fullProbeFormProblems(
  f: FullProbeFields,
): Partial<Record<keyof FullProbeFields, string>> {
  const out: Partial<Record<keyof FullProbeFields, string>> = {};
  const target = httpUrl(f.target, "Use an absolute http(s) URL");
  if (target !== null) out.target = target;
  if (
    !Number.isInteger(f.timeoutSec) ||
    f.timeoutSec < 0 ||
    f.timeoutSec > FULL_PROBE_CAPS.maxTimeoutSec
  ) {
    out.timeoutSec = `Whole seconds 0–${FULL_PROBE_CAPS.maxTimeoutSec} (0 = default ${FULL_PROBE_DEFAULTS.timeoutSec})`;
  }
  if (
    !Number.isInteger(f.maxDepth) ||
    f.maxDepth < 0 ||
    f.maxDepth > FULL_PROBE_CAPS.maxDepth
  ) {
    out.maxDepth = `Whole number 0–${FULL_PROBE_CAPS.maxDepth} (0 = default ${FULL_PROBE_DEFAULTS.depth})`;
  }
  if (
    !Number.isInteger(f.rps) ||
    f.rps < 0 ||
    f.rps > FULL_PROBE_CAPS.maxRPS
  ) {
    out.rps = `Whole number 0–${FULL_PROBE_CAPS.maxRPS} (0 = default ${FULL_PROBE_DEFAULTS.rps})`;
  }
  if (
    !Number.isInteger(f.concurrency) ||
    f.concurrency < 0 ||
    f.concurrency > FULL_PROBE_CAPS.maxConcurrency
  ) {
    out.concurrency = `Whole number 0–${FULL_PROBE_CAPS.maxConcurrency} (0 = derive from rps)`;
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

/** How often the live card re-reads a running job. The engine snapshots
 *  about once a second, so faster polling would only re-serve the same
 *  numbers. */
export const FULL_PROBE_POLL_MS = 1_500;

/** Cap on the error-retry backoff: a long outage must not hammer the
 *  engine, but the chain must keep retrying — one transient blip stopping
 *  it would freeze the live card until a manual watch click. */
export const FULL_PROBE_POLL_MAX_MS = 12_000;

/** Delay before re-polling after `failures` consecutive errors: doubles
 *  from the normal cadence, capped at FULL_PROBE_POLL_MAX_MS. */
export function fullProbePollDelay(failures: number): number {
  const n = Math.max(0, Math.floor(failures));
  return Math.min(FULL_PROBE_POLL_MS * 2 ** n, FULL_PROBE_POLL_MAX_MS);
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

// ---------------------------------------------------------------------------
// Attempt results: query, merge, reset
// ---------------------------------------------------------------------------

/** Page sizes the attempt-results card offers. The default must be one of
 *  them (a select whose value matches no option renders blank); the engine
 *  defaults 200 and caps 10000, so every choice is a legal `n`. */
export const RESULTS_PAGE_OPTIONS = [100, 200, 500, 1000] as const;
export const RESULTS_PAGE_DEFAULT = 200;

/** The attempt-results card's filter state. Empty strings and depth 0 mean
 *  "no filter" — the same convention the wire uses, so buildResultsQuery can
 *  take these fields verbatim. */
export interface ResultsFilterFields {
  outcome: string;
  depth: number;
  reason: string;
  route: string;
  hop: string;
  lastHop: string;
}

export const INITIAL_RESULTS_FILTERS: ResultsFilterFields = {
  outcome: "",
  depth: 0,
  reason: "",
  route: "",
  hop: "",
  lastHop: "",
};

/** True when any filter is set — a filtered view pauses the head-refresh
 *  poll (the reader is studying a slice, not watching the newest rows). */
export function resultsFiltersActive(f: ResultsFilterFields): boolean {
  return (
    f.outcome !== "" ||
    f.depth > 0 ||
    f.reason !== "" ||
    f.route !== "" ||
    f.hop !== "" ||
    f.lastHop !== ""
  );
}

/** The wire query for one results fetch: the filter fields mapped onto the
 *  endpoint's parameter names (lastHop → last_hop), plus the page size and
 *  cursor. Pure — the card's fetch and vitest build the same thing. */
export function buildResultsOpts(
  f: ResultsFilterFields,
  n: number,
  before: string,
): FullProbeResultsQuery {
  return {
    n,
    before,
    outcome: f.outcome,
    depth: f.depth,
    reason: f.reason,
    route: f.route,
    hop: f.hop,
    last_hop: f.lastHop,
  };
}

/** The cursor for the next page: the last loaded row's id. Rows arrive
 *  newest first, so the tail is the oldest row in hand and `before` it walks
 *  strictly older. Empty (no rows) means there is nothing to page from. */
export function nextCursor(rows: HTTPProbe[]): string {
  return rows[rows.length - 1]?.id ?? "";
}

/** Whether an in-flight older page still appends contiguously: it was
 *  fetched against the window's tail (before = that tail's id). If a head
 *  fold RESET the window while the fetch was in flight, the tail moved and
 *  the page would append below an unreachable gap — drop it. The reset head
 *  owns the view; the next Load-more click pages from the new tail. An empty
 *  cursor or an id-less tail proves no contiguity and drops too. */
export function olderPageContiguous(prevRows: HTTPProbe[], before: string): boolean {
  return before !== "" && nextCursor(prevRows) === before;
}

/** The Load-more click's decision, pure so vitest pins the re-fetch path.
 *
 *  Normally the click walks the cursor strictly older: the window's tail
 *  becomes the next `before`, and the deps change refetches. But while a
 *  job RUNS, an older page can come back EMPTY without moving the tail —
 *  row ids are minted at attempt START yet recorded async at completion,
 *  so no strictly-older row is recorded YET below the cursor. The running
 *  fold keeps exhausted=false (late rows can still land), so the button
 *  stays visible; setting `before` to the cursor it already equals would
 *  be a NO-OP — useAsync's deps never change, no refetch runs, and the
 *  enabled button is inert until the reader discovers Refresh.
 *  `refetch: true` tells the card to bump useAsync's tick instead (the
 *  same mechanism refresh() uses at the head), re-querying the SAME older
 *  page so late-landed rows can fold in. null = nothing to page from (an
 *  empty window or an id-less tail): the click is a no-op. */
export function loadMoreAction(
  rows: HTTPProbe[],
  before: string,
): { cursor: string; refetch: boolean } | null {
  const cursor = nextCursor(rows);
  if (cursor === "") return null;
  return { cursor, refetch: cursor === before };
}

/** Merge a fresh head page into the rows already loaded, by row id.
 *
 *  The head refresh (before="") re-serves the newest rows, which overlap the
 *  loaded window; a Load-more page (before=cursor) can also overlap it when
 *  retention pruned the cursor row and the engine re-seeks from a newer
 *  position. Either way: head first (it is the newer read), then the tail
 *  rows the head does not already name. A row without an id cannot be
 *  deduped and is kept — dropping it would silently lose an attempt. */
export function mergeRowsById(head: HTTPProbe[], tail: HTTPProbe[]): HTTPProbe[] {
  const seen = new Set<string>();
  const out: HTTPProbe[] = [];
  for (const p of [...head, ...tail]) {
    const id = p.id ?? "";
    if (id !== "") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(p);
  }
  return out;
}

/** Whether the newest head page (before="") may fold into the loaded window
 *  contiguously — pure so vitest pins the exhausted latch's every outcome.
 *
 *  Rows arrive newest first and Load-more walks strictly older, so the window
 *  is a contiguous slice only while every head refresh still OVERLAPS it. At
 *  high attempt rates more than pageSize new rows can land between head
 *  refreshes: the head page then sits entirely ABOVE the window, and the rows
 *  between them were never fetched. Merging that head anyway would keep an
 *  unreachable hole — Load-more pages from the window's oldest id and can
 *  never walk back up into it — while a proven end (exhausted) stayed latched
 *  and hid Load more entirely. So a non-overlapping full head RESETS the
 *  window to the head alone: the hole is honestly dropped, exhausted clears,
 *  and Load more pages older rows from the head's oldest again.
 *
 *  A short page only proves the end of the stored set once the job is
 *  TERMINAL (`jobRunning` false). Row ids are minted at attempt START but
 *  rows are recorded asynchronously at completion, so a running job's store
 *  can still grow BELOW any walked cursor — a slow attempt that started
 *  early lands a row sorting under a tail an earlier short page already
 *  "proved" was the end. While running, every branch therefore forces
 *  exhausted=false. A terminal job's rows are all enqueued before its
 *  terminal snapshot (the runner waits for its attempts), and the batched
 *  flush settles within the parent's poll cadence before the terminal head
 *  refresh lands — so a terminal short page really is the whole stored set.
 *
 *  `reset` true = the window becomes the head page alone. It never means a
 *  scope reset: filter/job/engine switches own that (resultsViewReset); this
 *  is the within-scope decision the fold makes on every landed head page. */
export function foldHeadPage(
  prevRows: HTTPProbe[],
  prevExhausted: boolean,
  headRows: HTTPProbe[],
  pageSize: number,
  jobRunning = false,
): { rows: HTTPProbe[]; exhausted: boolean; reset: boolean } {
  // A short head page spans the ENTIRE stored (filtered) set as of now — the
  // engine ran out of rows before filling it. The window collapses to the
  // head whatever the old window held: any older row it named beyond the
  // head has since been pruned, and keeping it would show rows no longer
  // stored. The end is proven only for a terminal job; while running, late
  // completions can still land rows below this tail.
  if (headRows.length < pageSize) {
    return { rows: headRows, exhausted: !jobRunning, reset: true };
  }
  // Full head over an empty window: the first page. Nothing older is proven
  // yet — the cursor must stay walkable.
  if (prevRows.length === 0) {
    return { rows: headRows, exhausted: false, reset: true };
  }
  const prevIds = new Set<string>();
  for (const p of prevRows) {
    const id = p.id ?? "";
    if (id !== "") prevIds.add(id);
  }
  let overlap = false;
  for (const p of headRows) {
    const id = p.id ?? "";
    if (id !== "" && prevIds.has(id)) {
      overlap = true;
      break;
    }
  }
  if (overlap) {
    // Contiguous: the head reaches into the window, so head-over-window
    // stays one unbroken slice. A proven end stays proven only for a
    // TERMINAL job — no row older than the walked cursor can appear once
    // every attempt is recorded. While running, start-time ids mean late
    // rows can still land below the cursor, so jobRunning suppresses the
    // latch.
    return {
      rows: mergeRowsById(headRows, prevRows),
      exhausted: jobRunning ? false : prevExhausted,
      reset: false,
    };
  }
  // Full head, no overlap: a gap is possible between the head's oldest row
  // and the window's newest. Keep only the head — an unreachable hole must
  // not masquerade as loaded rows, and the exhausted latch must clear so
  // Load more returns (and the pruning banner cannot fire on the hole).
  // Id-less rows can't prove overlap either way; they take this safe branch.
  return { rows: headRows, exhausted: false, reset: true };
}

/** The Load-more fold (before=cursor): append an older page below the loaded
 *  window. Deliberately NOT the head rule — the cursor walked strictly older
 *  than the window's tail, so the page extends the slice downward and a
 *  short page proves the end: exhausted = the fetched page came back short,
 *  exactly the semantics the card always had — but only once the job is
 *  TERMINAL. While running, late completions can still land rows below the
 *  fetched page's tail (see foldHeadPage), so `jobRunning` keeps the cursor
 *  walkable. Merge order is window-first here (the window is the newer read
 *  of any overlap a re-seek produced). */
export function foldOlderPage(
  prevRows: HTTPProbe[],
  pageRows: HTTPProbe[],
  pageSize: number,
  jobRunning = false,
): { rows: HTTPProbe[]; exhausted: boolean } {
  return {
    rows: mergeRowsById(prevRows, pageRows),
    exhausted: !jobRunning && pageRows.length < pageSize,
  };
}

/** Whether the results view must reset to a fresh first page.
 *
 *  A job or engine switch always resets — the loaded rows belong to the old
 *  job/engine and must not render under the new card. A filter change resets
 *  too: the cursor walked the OLD filter's rows and means nothing under the
 *  new one. A poll tick never resets the SCOPE: the head refresh folds into
 *  the loaded window (foldHeadPage — which may drop a non-overlapping window
 *  to keep the slice contiguous, but that is a within-scope fold, not this
 *  reset), and a scope reset would collapse a reader's Load-more view every
 *  cadence. `prev` undefined is the first load, not a reset. */
export function resultsViewReset(
  prev: { engine: string; job: string; filters: ResultsFilterFields } | undefined,
  next: { engine: string; job: string; filters: ResultsFilterFields },
): boolean {
  if (prev === undefined) return false;
  if (prev.engine !== next.engine || prev.job !== next.job) return true;
  return !sameResultsFilters(prev.filters, next.filters);
}

function sameResultsFilters(a: ResultsFilterFields, b: ResultsFilterFields): boolean {
  return (
    a.outcome === b.outcome &&
    a.depth === b.depth &&
    a.reason === b.reason &&
    a.route === b.route &&
    a.hop === b.hop &&
    a.lastHop === b.lastHop
  );
}

/** The honesty banner's gate: the cursor walked to the end (a page came
 *  back shorter than asked, or empty) yet fewer rows are loaded than the job
 *  says it attempted — but the shortfall may only be CALLED retention pruning
 *  when it is proven, never when a filter alone explains it.
 *
 *  Unfiltered: the end of ALL stored rows is proven, so loaded < total can
 *  only mean the engine dropped the difference — the pruning claim stands
 *  even without the job's rows_pruned flag (older engines never send it).
 *
 *  Filtered: the filter narrows the count, so loaded < total says nothing
 *  about retention — a filter matching fewer rows than the job ran is NOT
 *  pruning, and the banner must stay silent (rows_pruned=false jobs were
 *  firing the pruning banner purely from filtering). Only the job's own
 *  rows_pruned flag can justify the claim under a filter.
 *
 *  The separate rows_pruned notice is unconditional and unaffected: a pruned
 *  job says so even when the loaded window matches the attempt count. */
export function resultsExhaustedShort(
  exhausted: boolean,
  loaded: number,
  totalAttempts: number | undefined,
  filtersActive = false,
  rowsPruned = false,
): boolean {
  if (!exhausted || loaded >= (totalAttempts ?? 0)) return false;
  if (filtersActive) return rowsPruned;
  return true;
}

/** The retention sentence the banner shows, mirroring the engine's budgets
 *  (metrics/store.go: fullProbeRowsPerJob=500000, fullProbeRowJobs=8,
 *  fullProbeRowsTotal=500000). Kept here so vitest pins the numbers the UI
 *  promises against the engine's constants. */
export const RESULTS_RETENTION_NOTE =
  "Engine retains newest 500000 attempts/job (8 recent jobs, global 500000-row budget); older rows pruned.";

// ---------------------------------------------------------------------------
// Filter vocabularies: from the job snapshot, never from the returned rows
// ---------------------------------------------------------------------------
//
// The dropdowns offer what the JOB knows (its levels, failed items and
// success paths), not what the current page of rows happens to contain —
// a server-side filter over a 200-row window would otherwise offer only the
// values already on screen, and the reader could never narrow to anything
// the first page missed.

/** Depth choices: the levels the job snapshot names, ascending, deduped.
 *  Depth 0 never appears — the engine's rows are all depth >= 1. */
export function resultsDepthChoices(j: FullProbeJob | undefined): number[] {
  const seen = new Set<number>();
  for (const l of j?.levels ?? []) {
    const d = l.depth ?? 0;
    if (d > 0) seen.add(d);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Reason choices: the classified slugs the page knows words for
 *  (REASON_LABELS) plus whatever the job's failed items actually reported —
 *  a newer engine can classify a slug this build has no label for, and the
 *  filter must still offer it (labelled with the slug itself). Sorted by
 *  label so the menu reads as words, not slugs. */
export function resultsReasonChoices(
  j: FullProbeJob | undefined,
): Array<{ value: string; label: string }> {
  const seen = new Set<string>(Object.keys(REASON_LABELS));
  for (const l of j?.levels ?? []) {
    for (const fi of l.failed_items ?? []) {
      const r = fi.reason ?? "";
      if (r !== "") seen.add(r);
    }
  }
  return [...seen]
    .map((value) => ({ value, label: REASON_LABELS[value] ?? value }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

/** Hop choices: every outbound the job touched — the failed items' ids
 *  (the candidates each level retried) plus the success paths' hops. Feeds
 *  the Hop input's datalist and the LastHop select. Sorted, deduped. */
export function resultsHopChoices(j: FullProbeJob | undefined): string[] {
  const seen = new Set<string>();
  for (const l of j?.levels ?? []) {
    for (const fi of l.failed_items ?? []) {
      const id = fi.id ?? "";
      if (id !== "") seen.add(id);
    }
    for (const p of l.success_paths ?? []) {
      for (const h of p.hops ?? []) {
        if (h !== "") seen.add(h);
      }
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Apply: the two modes and the pool-mode selection preview
// ---------------------------------------------------------------------------

/** What apply builds: one inbound per proved path (the default), or one
 *  pool load-balancing over the proved paths behind a single inbound. */
export type ApplyMode = "inbounds" | "pool";

/** The apply form's fields. Empty strings / 0 mean "the engine's default" —
 *  the same convention the sweep form uses, and what keeps an untouched form
 *  sending `{}`. */
export interface ApplyFields {
  protocol: string;
  listenPrefix: string;
  port: number;
  idPrefix: string;
  /** pool mode only: the generated pool's id; empty = "<id_prefix>-pool" */
  poolId: string;
  /** pool mode only: the pool's selection strategy */
  selector: string;
}

export const INITIAL_APPLY_FIELDS: ApplyFields = {
  protocol: "",
  listenPrefix: "",
  port: 0,
  idPrefix: "",
  poolId: "",
  selector: "roundrobin",
};

/** The strategies the pool-mode select offers, in menu order. roundrobin is
 *  the default (the engine's own); leastlatency's cost is an approximation
 *  (sum of hop latencies, unmeasured hops counted as 1s), which the form
 *  says out loud rather than implying a measured ranking. */
export const APPLY_SELECTOR_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "roundrobin", label: "roundrobin (default)" },
  { value: "random", label: "random" },
  { value: "sticky", label: "sticky" },
  { value: "leastlatency", label: "leastlatency (approximate path cost)" },
];

export const APPLY_SELECTOR_HINT =
  "leastlatency ranks members by approximate path cost — the sum of hop latencies, with unmeasured hops counted as 1s — not a measured end-to-end ranking.";

/** The engine's pool-mode member cap (core.FullProbeMaxApplyPoolMembers). */
export const FULL_PROBE_APPLY_POOL_CAP = 256;

/** Form → apply body. The DEFAULT mode omits mode/pool_id/selector entirely
 *  — an older engine's decoder rejects unknown fields outright, so the
 *  inbounds-mode request must stay byte-identical to what this page always
 *  sent (vitest pins that contract). Pool mode names the mode and carries
 *  the pool fields; empty knobs are omitted so the engine's defaults apply. */
export function buildApplySpec(
  mode: ApplyMode,
  f: ApplyFields,
): FullProbeApplySpec {
  const spec: FullProbeApplySpec = {};
  const protocol = f.protocol.trim();
  if (protocol !== "") spec.protocol = protocol;
  const listen = f.listenPrefix.trim();
  if (listen !== "") spec.listen_prefix = listen;
  if (Number.isInteger(f.port) && f.port > 0) spec.port = f.port;
  const prefix = f.idPrefix.trim();
  if (prefix !== "") spec.id_prefix = prefix;
  if (mode === "pool") {
    spec.mode = "pool";
    const poolId = f.poolId.trim();
    if (poolId !== "") spec.pool_id = poolId;
    // Always named: the form's select always holds a strategy, and sending
    // it keeps the created pool's selector exactly what the reader saw.
    spec.selector = { type: f.selector };
  }
  return spec;
}

/** Every successful path across all levels, deduped by hop-join and ordered
 *  fastest first — the browser's mirror of the engine's AllPathsFastest(),
 *  so the pool-mode preview promises the same members the engine builds.
 *  Ties on latency keep the shallower path first (fewer hops for the same
 *  cost); the dedupe keeps the first occurrence in level order, which is
 *  what the engine's seen-map does before its stable sort. */
export function allPathsFastest(j: FullProbeJob | undefined): FullProbePath[] {
  const seen = new Set<string>();
  const out: FullProbePath[] = [];
  for (const l of j?.levels ?? []) {
    for (const p of l.success_paths ?? []) {
      const key = (p.hops ?? []).join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  // Array.prototype.sort is stable (ES2019+), matching sort.SliceStable.
  return out.sort((a, b) => {
    const la = a.latency ?? 0;
    const lb = b.latency ?? 0;
    if (la !== lb) return la - lb;
    return (a.hops?.length ?? 0) - (b.hops?.length ?? 0);
  });
}

/** The pool-mode preview line: how many proved paths become members (the
 *  engine caps at 256) behind the one inbound. */
export function poolApplyPreview(j: FullProbeJob | undefined): string {
  const all = allPathsFastest(j);
  const members = Math.min(all.length, FULL_PROBE_APPLY_POOL_CAP);
  return `${members} proved path${members === 1 ? "" : "s"} → pool members (fastest first, cap ${FULL_PROBE_APPLY_POOL_CAP}) · 1 inbound`;
}

/** What a successful apply created, tagged with the engine and job it
 *  belongs to so a deferred answer (or a job/engine switch) can never paint
 *  the previous job's inbounds under the new card. */
export interface AppliedState {
  engine: string;
  job: string;
  mode: ApplyMode;
  results: FullProbeApplyResult[];
  poolId?: string;
  inboundId?: string;
  listen?: string;
  protocol?: string;
  selector?: FullProbeSelectorSpec;
}

/** The applied block to render under a card: the state only when its tags
 *  name THIS engine and THIS job, else null. Pure so vitest pins the
 *  engine-switch/job-switch clear even before the state-clearing effects
 *  run (a render can race them). */
export function appliedForCard(
  applied: AppliedState | null,
  engine: string,
  job: string | undefined,
): AppliedState | null {
  if (applied === null || job === undefined) return null;
  return applied.engine === engine && applied.job === job ? applied : null;
}

/** What the results endpoint's capability probe concluded: unknown until
 *  the first fetch lands, ok when it answers rows (or an empty 200), old
 *  when a KNOWN-LIVE job's results 404 — the engine predates the endpoint. */
export type ResultsCapability = "unknown" | "ok" | "old";

/** The card's verdict transition for one landed results page (after its
 *  scope tag matched). Three outcomes, and the recovery rule is load-bearing:
 *
 *  - gone (the job left the engine's history): surface the notice, latch
 *    NOTHING about the engine — capability null means "no verdict". An
 *    evicted job says nothing about the build, and mislabeling the engine
 *    "old" here would disable pool-mode apply on a perfectly capable one.
 *  - unsupported (snapshot loads, /results 404s): the engine truly predates
 *    the endpoint — latch "old".
 *  - success: ALWAYS re-probe positive, whatever was latched before. An
 *    engine upgraded while the page is open (or any earlier mislatch) is
 *    recovered by the next positive answer: the unsupported latch clears
 *    and capability reports "ok", re-enabling the pool toggle without a
 *    remount. */
export function resultsLandingState(d: {
  unsupported: boolean;
  gone: string | null;
}): { unsupported: boolean; capability: ResultsCapability | null } {
  if (d.gone !== null) return { unsupported: false, capability: null };
  if (d.unsupported) return { unsupported: true, capability: "old" };
  return { unsupported: false, capability: "ok" };
}

/** The pool-mode apply toggle's gate: the same engine build ships the
 *  results endpoint and pool apply, so only a POSITIVE probe unlocks it —
 *  unknown (still probing) must not offer a mode the engine may reject. */
export function poolApplyCapable(cap: ResultsCapability): boolean {
  return cap === "ok";
}