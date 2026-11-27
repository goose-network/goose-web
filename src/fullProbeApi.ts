// src/fullProbeApi.ts — the full active probing endpoints: start a
// multi-level sweep, watch its progress, cancel it, and turn its successful
// paths into chains + inbounds.
//
// Newer than the SDK this app pins, so the wire types are declared here and
// the calls go through the SDK's own transport client (`goose.client`),
// keeping base URL, bearer token and error shaping in the one place they
// already live — the same arrangement as runApi.ts.

import type { Goose } from "@goose-network/goose-sdk";
import { apiMessage } from "./runApi";

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
  /** pairs the caps (or a cancel) cut */
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
}

/** `POST /api/probes/full/{id}/inbounds` body (`core.FullProbeApplySpec`):
 *  which successful paths to build and how to name/listen them. An empty
 *  object applies the fastest path per depth. */
export interface FullProbeApplySpec {
  paths?: string[][];
  protocol?: string;
  listen_prefix?: string;
  port?: number;
  id_prefix?: string;
}

/** One generated chain + inbound pair (`core.FullProbeApplyResult`). */
export interface FullProbeApplyResult {
  chain_id?: string;
  inbound_id?: string;
  listen?: string;
  protocol?: string;
  path?: FullProbePath;
}

/** The 201 body of the apply endpoint. */
export interface FullProbeApplyResponse {
  job_id?: string;
  results?: FullProbeApplyResult[] | null;
}

async function friendly<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
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

/** One job's current snapshot (live while running, durable after). */
export async function getFullProbe(
  goose: Goose,
  id: string,
): Promise<FullProbeJob> {
  return friendly(
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
 *  local→A→C→E, ... — one inbound per path. */
export async function applyFullProbe(
  goose: Goose,
  id: string,
  spec: FullProbeApplySpec = {},
): Promise<FullProbeApplyResponse> {
  return friendly(
    goose.client.send<FullProbeApplyResponse>(
      "POST",
      `/api/probes/full/${encodeURIComponent(id)}/inbounds`,
      spec,
    ),
  );
}