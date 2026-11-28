// src/fullProbeApi.ts — the full active probing endpoints: start a
// multi-level sweep, watch its progress, cancel it, and turn its successful
// paths into chains + inbounds.
//
// Newer than the SDK this app pins, so the wire types are declared here and
// the calls go through the SDK's own transport client (`goose.client`),
// keeping base URL, bearer token and error shaping in the one place they
// already live — the same arrangement as runApi.ts.

import { GooseApiError, type Goose } from "@goose-network/goose-sdk";
import { apiMessage, type HTTPProbe } from "./runApi";

/** One successful path (`core.FullProbePath`): the ordered outbound IDs of a
 *  chain that proxied a request to the target. "local" is the implicit first
 *  node and the target the implicit last. Fields are optional the way the
 *  engine's are: it omits empty values. */
export interface FullProbePath {
  hops?: string[];
  /** Go time.Duration — nanoseconds, like every duration on the wire */
  latency?: number;
  status?: number;
}

/** One level's failures aggregated by the outbound that was the appended
 *  (last) hop (`core.FullProbeFailedItem`) — the candidate set the next level
 *  retries behind its successful prefixes. */
export interface FullProbeFailedItem {
  id?: string;
  address?: string;
  count?: number;
  reason?: string;
  error?: string;
}

/** One depth's sweep (`core.FullProbeLevel`). While the level runs,
 *  done/success/failed are live counters. */
export interface FullProbeLevel {
  depth?: number;
  prefixes?: number;
  candidates?: number;
  /** planned attempt count after the fan-out caps */
  total?: number;
  /** prefix×candidate pairs cut without an attempt — fan-out caps, a
   *  cancel, or the settling tail's expired bound (depth-1 pairs are
   *  single outbounds) */
  skipped?: number;
  done?: number;
  success?: number;
  failed?: number;
  /** successful paths, fastest first — what inbound creation builds from */
  success_paths?: FullProbePath[] | null;
  failed_items?: FullProbeFailedItem[] | null;
  startedAt?: string;
  finishedAt?: string;
}

/** The effective spec a job runs (`core.FullProbeSpec`): every numeric field
 *  defaulted and capped by the engine, durations in nanoseconds. */
export interface FullProbeSpec {
  target?: string;
  method?: string;
  headers?: Record<string, string> | null;
  body?: string;
  timeout?: number;
  max_depth?: number;
  rps?: number;
  concurrency?: number;
  max_attempts_per_level?: number;
  max_paths_per_level?: number;
  max_total_attempts?: number;
  /** Settling-tail bound in seconds: after the sweep, keep probing outbounds
   *  that register late (depth 1) until the fleet is quiet or this expires.
   *  0/unset = engine default (600); -1 = opt out (one final pass still runs).
   *  Additive: an engine older than the settling tail never sends it. */
  catchup_seconds?: number;
}

/** One full active probing job (`core.FullProbeJob`). */
export interface FullProbeJob {
  id?: string;
  spec?: FullProbeSpec;
  /** "running" | "done" | "canceled" | "error" — plain string, a newer
   *  engine could add a state */
  state?: string;
  error?: string;
  levels?: FullProbeLevel[] | null;
  total_attempts?: number;
  startedAt?: string;
  finishedAt?: string;
  /** The job's durable attempt rows (GET .../results) were pruned — a
   *  retention budget cut them or the job's row bucket was evicted. The
   *  attempt counts stay exact; only the row detail is partial. Additive:
   *  an engine older than per-job attempt storage never sends it. */
  rows_pruned?: boolean;
}

/** `POST /api/probes/full` body (`api.fullProbeRunRequest`): the sweep to
 *  run, with the API's seconds-based timeout convention. Every omitted
 *  numeric field takes the engine's default (depth 5, rps 100, timeout 10s). */
export interface FullProbeRunRequest {
  target: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_seconds?: number;
  max_depth?: number;
  rps?: number;
  concurrency?: number;
  max_attempts_per_level?: number;
  max_paths_per_level?: number;
  max_total_attempts?: number;
  /** Settling-tail bound in seconds (engine default 600 when omitted; -1
   *  opts out, one final pass still runs). Additive: OMIT it for engines
   *  older than the settling tail — their JSON decoder rejects unknown
   *  fields outright (400), it does not ignore them. */
  catchup_seconds?: number;
}

/** `POST /api/probes/full/{id}/inbounds` body (`core.FullProbeApplySpec`):
 *  which successful paths to build and how to name/listen them. An empty
 *  object applies the fastest path per depth.
 *
 *  The mode/pool_id/selector fields are additive: the DEFAULT mode omits
 *  them entirely (buildApplySpec enforces that), so a request an older
 *  engine can still read stays byte-identical — its JSON decoder rejects
 *  unknown fields outright, and sending `mode: ""` would 400 a build that
 *  would happily serve the default apply. */
export interface FullProbeApplySpec {
  paths?: string[][];
  protocol?: string;
  listen_prefix?: string;
  port?: number;
  id_prefix?: string;
  /** "" / "inbounds" = one inbound per path (the default, omitted on the
   *  wire); "pool" = one pool load-balancing over the proved paths behind
   *  a single inbound. */
  mode?: string;
  /** pool mode only: the generated pool's id; empty means "<id_prefix>-pool" */
  pool_id?: string;
  /** pool mode only: the pool's selection strategy; nil means roundrobin */
  selector?: FullProbeSelectorSpec;
}

/** The apply request's selector (`core.FullProbeSelectorSpec`) — a core-local
 *  mirror of config.SelectorSpec, since core cannot import config. */
export interface FullProbeSelectorSpec {
  /** "random" | "roundrobin" | "sticky" | "leastlatency" */
  type: string;
  params?: Record<string, unknown>;
}

/** One generated chain + inbound pair (`core.FullProbeApplyResult`). In pool
 *  mode each entry names a member chain and the inbound fields are empty —
 *  the one listener is described by the response's top-level fields. */
export interface FullProbeApplyResult {
  chain_id?: string;
  inbound_id?: string;
  listen?: string;
  protocol?: string;
  path?: FullProbePath;
}

/** The 201 body of the apply endpoint. The pool-mode fields are additive
 *  (omitempty on the engine): an inbounds-mode answer never carries them. */
export interface FullProbeApplyResponse {
  job_id?: string;
  results?: FullProbeApplyResult[] | null;
  /** pool mode only: the generated pool */
  pool_id?: string;
  /** pool mode only: the single inbound routed through the pool */
  inbound_id?: string;
  /** pool mode only: that inbound's listen address */
  listen?: string;
  /** pool mode only: that inbound's listener protocol */
  protocol?: string;
  /** pool mode only: the pool's selection strategy */
  selector?: FullProbeSelectorSpec;
}

async function friendly<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw new Error(apiMessage(err));
  }
}

/** True when an item-route call failed with 404: the job is gone (pruned
 *  from history, or an engine restart lost it) — not "this engine has no
 *  such endpoint". The page stops following a gone job instead of polling
 *  it forever. */
export function fullProbeJobGone(err: unknown): boolean {
  return err instanceof GooseApiError && err.status === 404;
}

/** The missing-job wording, shared by every 404 rewrap below and the
 *  results card's gone notice — one string so the parent's notice and the
 *  card's can never drift apart. */
export function fullProbeGoneMessage(id: string): string {
  return `No full-probe job "${id}" on this engine — it was pruned from history or lost in a restart.`;
}

/** Like friendly, but for /api/probes/full/{id} routes: a 404 there means
 *  the job is missing, so it keeps the GooseApiError (status intact for
 *  fullProbeJobGone) with job-specific wording rather than apiMessage's
 *  endpoint-level "needs a newer engine build". */
async function friendlyJob<T>(id: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (fullProbeJobGone(err)) {
      throw new GooseApiError(
        404,
        (err as GooseApiError).body,
        fullProbeGoneMessage(id),
      );
    }
    throw new Error(apiMessage(err));
  }
}

/** Starts a full active probing job (201 with the running snapshot). */
export async function startFullProbe(
  goose: Goose,
  req: FullProbeRunRequest,
): Promise<FullProbeJob> {
  return friendly(
    goose.client.send<FullProbeJob>("POST", "/api/probes/full", req),
  );
}

/** Job snapshots, newest first: live progress plus the durable history. */
export async function listFullProbes(
  goose: Goose,
  n?: number,
): Promise<FullProbeJob[]> {
  const suffix = n === undefined ? "" : `?n=${n}`;
  const res = await friendly(
    goose.client.get<FullProbeJob[] | null>(`/api/probes/full${suffix}`),
  );
  return res ?? [];
}

/** One job's current snapshot (live while running, durable after). A 404
 *  rejects with a GooseApiError (see fullProbeJobGone) worded as a missing
 *  job, not a missing endpoint. */
export async function getFullProbe(
  goose: Goose,
  id: string,
): Promise<FullProbeJob> {
  return friendlyJob(
    id,
    goose.client.get<FullProbeJob>(
      `/api/probes/full/${encodeURIComponent(id)}`,
    ),
  );
}

/** Cancels a running job. Resolves false when the engine no longer knows it
 *  (404); a job that already finished is a 409 the transport throws — the
 *  caller surfaces it like any other refusal. */
export async function cancelFullProbe(
  goose: Goose,
  id: string,
): Promise<boolean> {
  try {
    return await goose.client.delete(
      `/api/probes/full/${encodeURIComponent(id)}`,
    );
  } catch (err) {
    throw new Error(apiMessage(err));
  }
}

/** Turns a finished job's successful paths into chains + inbounds. `{}`
 *  applies the fastest successful path per depth — local→A, local→A→C,
 *  local→A→C→E, ... — one inbound per path. `mode: "pool"` instead builds
 *  one pool over the proved paths behind a single inbound (see
 *  buildApplySpec, which keeps the default mode's body byte-identical).
 *
 *  An older engine's decoder rejects unknown fields outright, so pool mode
 *  against it comes back 400 "unknown field" — reworded here as the upgrade
 *  it actually is (status kept, so callers can still classify it). */
export async function applyFullProbe(
  goose: Goose,
  id: string,
  spec: FullProbeApplySpec = {},
): Promise<FullProbeApplyResponse> {
  try {
    return await goose.client.send<FullProbeApplyResponse>(
      "POST",
      `/api/probes/full/${encodeURIComponent(id)}/inbounds`,
      spec,
    );
  } catch (err) {
    if (fullProbeJobGone(err)) {
      throw new GooseApiError(
        404,
        (err as GooseApiError).body,
        fullProbeGoneMessage(id),
      );
    }
    if (
      spec.mode === "pool" &&
      err instanceof GooseApiError &&
      err.status === 400 &&
      /unknown field/i.test(err.message)
    ) {
      throw new GooseApiError(
        400,
        err.body,
        "This engine does not understand pool-mode apply (mode/pool_id/selector) — it needs a newer engine build. Switch to \"Inbound per path\" to create listeners on this engine.",
      );
    }
    throw new Error(apiMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Attempt results: every issued attempt of one job, newest first
// ---------------------------------------------------------------------------

/** `GET /api/probes/full/{id}/results` query options. Filters narrow
 *  SERVER-side (the engine walks the job's row bucket); `before` is the
 *  pagination cursor — the previous page's last row id, returning only rows
 *  strictly older than it. Empty strings and zero numbers mean "unset" and
 *  are omitted from the query (depth 0 is not a depth the engine stores). */
export interface FullProbeResultsQuery {
  /** page size; the engine defaults 200 and caps 10000 */
  n?: number;
  /** row id cursor: only rows strictly older than this id */
  before?: string;
  /** "success" | "failed" */
  outcome?: string;
  /** exact chain length (>= 1) */
  depth?: number;
  /** exact failure reason slug */
  reason?: string;
  /** exact hop-join route ("a>b") */
  route?: string;
  /** an outbound at any position of the route */
  hop?: string;
  /** the route's final outbound */
  last_hop?: string;
}

/** The query suffix for the results endpoint — "" when nothing is set, so
 *  the bare URL keeps the engine's own defaults. Pure: vitest asserts the
 *  exact wire form (URLSearchParams encodes, and unset fields must not
 *  travel as empty strings — an empty `outcome=` is still a filter key to
 *  a stricter future engine). */
export function buildResultsQuery(opts: FullProbeResultsQuery): string {
  const q = new URLSearchParams();
  if (opts.n !== undefined && opts.n > 0) q.set("n", String(opts.n));
  if (opts.before !== undefined && opts.before !== "") q.set("before", opts.before);
  if (opts.outcome !== undefined && opts.outcome !== "") q.set("outcome", opts.outcome);
  if (opts.depth !== undefined && opts.depth > 0) q.set("depth", String(opts.depth));
  if (opts.reason !== undefined && opts.reason !== "") q.set("reason", opts.reason);
  if (opts.route !== undefined && opts.route !== "") q.set("route", opts.route);
  if (opts.hop !== undefined && opts.hop !== "") q.set("hop", opts.hop);
  if (opts.last_hop !== undefined && opts.last_hop !== "") q.set("last_hop", opts.last_hop);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/** True when a results call failed with 404. Ambiguous by itself: either the
 *  ENGINE predates the per-job results endpoint, or the JOB was evicted from
 *  the 64-job history (a terminal job whose parent poll stopped can be pushed
 *  out by newer sweeps; a restart does NOT lose finished jobs — history is
 *  persisted). The page must not read this as a capability answer on its
 *  own: classifyFullProbeResults404 disambiguates against the job snapshot,
 *  or an evicted job on a capable engine permanently latches it "old". */
export function fullProbeResultsMissing(err: unknown): boolean {
  return err instanceof GooseApiError && err.status === 404;
}

/** What a results-route 404 actually means, once the job snapshot has been
 *  consulted. "gone": the job left the engine's history — stop following it,
 *  never a capability verdict. "unsupported": the snapshot loads but /results
 *  404s — the engine predates the endpoint (old engines serve the snapshot).
 *  "transient": the snapshot could not be read (network blip, 5xx) — nothing
 *  is proven, retry later rather than latch either verdict. */
export type FullProbeResults404Kind = "gone" | "unsupported" | "transient";

/** Disambiguates a results-route 404 BEFORE any capability latch: fetch the
 *  job snapshot (GET /api/probes/full/{id} — the same route the parent poll
 *  uses). Snapshot 404 → the job is gone from history, not an old engine.
 *  Snapshot loads → the endpoint truly is missing. Snapshot unreadable →
 *  transient; the caller retries instead of guessing. Pure orchestration
 *  over the two calls, so vitest pins every classification. */
export async function classifyFullProbeResults404(
  goose: Goose,
  id: string,
): Promise<FullProbeResults404Kind> {
  try {
    await getFullProbe(goose, id);
    return "unsupported";
  } catch (err) {
    return fullProbeJobGone(err) ? "gone" : "transient";
  }
}

/** One job's durable attempt rows, newest first — every issued attempt,
 *  success and failure alike, in the same model as GET /api/probes/results.
 *  A known job with no (or pruned) rows answers 200 []; an unknown job — or
 *  an engine without this endpoint — answers 404, which keeps its status
 *  (fullProbeResultsMissing) and apiMessage's "needs a newer engine build"
 *  wording: the page distinguishes the two via classifyFullProbeResults404
 *  (does the job snapshot load?), not by this call's message. */
export async function listFullProbeResults(
  goose: Goose,
  id: string,
  opts: FullProbeResultsQuery = {},
): Promise<HTTPProbe[]> {
  const suffix = buildResultsQuery(opts);
  try {
    const res = await goose.client.get<HTTPProbe[] | null>(
      `/api/probes/full/${encodeURIComponent(id)}/results${suffix}`,
    );
    return res ?? [];
  } catch (err) {
    if (err instanceof GooseApiError) {
      throw new GooseApiError(err.status, err.body, apiMessage(err));
    }
    throw new Error(apiMessage(err));
  }
}