// src/runApi.ts — the on-demand task endpoints, plus the probe config section
// of the engine resource.
//
// All of it is newer than the SDK this app pins (a GitHub SHA whose generated
// schema predates these), so the wire types are declared here and the calls go
// through the SDK's own transport client — `goose.client` — keeping base URL,
// bearer token and error shaping in the one place they already live.
//
// An older engine answers 404 rather than 400, which is why apiMessage spells
// that case out: the UI can be pointed at any engine build, and a bare
// "API error 404" sends the reader hunting in the wrong place.

import { GooseApiError } from "@goose-network/goose-sdk";
import type { Engine, ExitCheck, Goose } from "@goose-network/goose-sdk";

// ---------------------------------------------------------------------------
// Observed network path
// ---------------------------------------------------------------------------
//
// Every persisted record — a `core.RequestMetric` row and a `core.HTTPProbe`
// result — carries the network path it actually took, as an adjacency list
// (`core.PathGraph`). Nodes are the engine host ("local"), each proxy server
// the request dialed, and the target; edges are the legs the engine observed
// between them, each with its own span, outcome and failure classification.
// These types are newer than the pinned SDK, so they are declared here (the
// same reason HTTPProbe below is hand-declared). Every field is optional: the
// engine omits empty values, a partial graph omits what it could not observe,
// and an older engine omits `path` entirely — so a reader gets `undefined`
// rather than a crash, and the view layer in pages/pathGraph.ts decides what
// an absent field means.

/** One vertex of the path (`core.PathNode`). `id` is the node's identity and
 *  the shape the engine emits is stable: `"local"`, `"target"`,
 *  `"proxy:<outboundID>"`, `"proxy:<outboundID>#<n>"` for failover attempt
 *  n>1, or `"server:<host:port>"` for a server reached with no outbound behind
 *  it. `kind` is one of `"local"`/`"proxy"`/`"target"` — declared a plain
 *  string, not a union, because a newer engine could add a kind (the same
 *  reason HTTPProbe.phase is a plain string). `addressSource` says how
 *  trustworthy `address` is: `"socket"` means the engine read it off the
 *  connection it actually made, `"configured"` means it is what the config
 *  claims and a proxy may sit in front of it. A tunnel-protocol hop
 *  (psiphon/tor/geph) has no dialable socket address, so `address` is absent —
 *  not observable is not the same as empty. `attempt` is a 1-based failover
 *  attempt number, absent when the node was not one of several. */
export interface PathNode {
  id?: string;
  kind?: string;
  outboundID?: string;
  address?: string;
  addressSource?: string;
  host?: string;
  /** the requested destination port, on the target node only; a JSON string,
   *  matching the engine's `Port string` field */
  port?: string;
  attempt?: number;
}

/** One observed leg between two nodes (`core.PathEdge`). `kind` is
 *  `"dial"`/`"tunnel"`/`"stack"` on current engines (plain string, as above;
 *  an unknown slug — including the legacy `"pass-through"` an older engine may
 *  still send — renders through `legLabel`'s humanization).
 *  `duration` is a Go time.Duration in nanoseconds; it is OMITTED — not zero —
 *  when the leg was not separately timed (its handshake happened inside the
 *  same bracketed call as the leg before it), so a reader must treat absent
 *  and 0 alike as "not timed", never as "instantaneous". `observed` is true on
 *  every leg the engine records — a leg it could not bracket is omitted and
 *  flagged via the graph's `partial`, never sent with `observed: false`; the
 *  only producer of false is this repo's `synthesizePathFromChain`. `collapsed`
 *  marks a chained hop that threw the
 *  previous tunnel away and re-dialed from the engine host. On failure,
 *  `error` is the raw Go string and `phase`/`reason` the classification (the
 *  same vocabulary HTTPProbe uses); a leg whose phase the classifier bounded
 *  away keeps `reason` and an empty `phase`. */
export interface PathEdge {
  from?: string;
  to?: string;
  kind?: string;
  /** the dial string handed to this leg (the address the plugin was asked to
   *  reach), which is not necessarily either endpoint's recorded address */
  target?: string;
  duration?: number;
  observed?: boolean;
  collapsed?: boolean;
  success?: boolean;
  error?: string;
  phase?: string;
  reason?: string;
}

/** The whole adjacency list (`core.PathGraph`). `partial` is true when the
 *  graph may be missing legs — a plugin dialed where the engine could not see,
 *  a cycle was refused, or a cap cut something; it is NOT "some leg was
 *  untimed" (that is every successful hop). `dropped` counts nodes a cap cut.
 *  Both are absent on a complete graph. */
export interface PathGraph {
  nodes?: PathNode[];
  edges?: PathEdge[];
  partial?: boolean;
  dropped?: number;
}

// ---------------------------------------------------------------------------
// HTTP reachability probes
// ---------------------------------------------------------------------------

/** One recorded probe (`core.HTTPProbe`). Fields are optional the way the
 *  SDK's generated types are: the engine omits empty maps, and a reader on an
 *  older engine gets `undefined` rather than a crash. */
export interface HTTPProbe {
  id?: string;
  /** the route reference probed: "outbound:a", "pool:x", "chain:y", "direct" */
  route?: string;
  target?: string;
  method?: string;
  /** response status; 0 when no response arrived at all */
  status?: number;
  /** response headers, one value per name (repeats joined with ", ") */
  headers?: Record<string, string>;
  /** response body, capped at max_body_bytes */
  body?: string;
  /** the body hit the cap, so a regex over it may miss a later match */
  truncated?: boolean;
  success?: boolean;
  error?: string;
  /** the leg a failure broke on: "dns"/"connect" are local→proxy (local→target
   *  on a direct route), "proxy" is the proxy's handshake after its TCP port
   *  was reached, "tls"/"headers"/"body" are beyond it on the proxy→target
   *  leg, "request" is a malformed spec. Empty on success and on older
   *  engines. */
  phase?: string;
  /** stable slug classifying the failure (`dns_timeout`, `connect_refused`,
   *  `proxy_timeout`, `body_timeout`, `tls_cert`, ... — the same slug lands on
   *  the probe's metrics row). Empty on success and on older engines. */
  reason?: string;
  /** address the first hop actually connected to — the proxy server for a
   *  proxy route, the target for a direct one. Absent when the dial was not
   *  observable (a stack that bypasses `net.Dialer`, an in-memory tunnel). */
  dialAddr?: string;
  /** the outbound that served the route's dial: a pool or chain route names
   *  the member picked at dial time, an `outbound:<id>` route repeats the id.
   *  Empty for a direct route. */
  dialVia?: string;
  /** Per-phase durations in Go time.Duration nanoseconds, measured from the
   *  request start; absent when a phase did not run or was not observable.
   *  `routeDial` spans the whole route dial (local→proxy connect plus the
   *  proxy's handshake toward the target) and is the one timing every stack
   *  provides; `dns`/`connect` break out the first hop's resolution and TCP
   *  connect where the trace hooks fire; `tls` is the handshake with the
   *  target; `ttfb` is when the first response byte arrived. */
  routeDial?: number;
  dns?: number;
  connect?: number;
  tls?: number;
  ttfb?: number;
  /** Go time.Duration — nanoseconds, like every other duration on the wire */
  latency?: number;
  startedAt?: string;
  /** the observed network path of this probe's route (`core.PathGraph`): the
   *  engine host, each proxy server the route rode and the target as nodes, one
   *  edge per leg with that leg's own span and outcome. Unlike `phase`/`reason`
   *  above — which name where the WHOLE request broke — the graph names the leg
   *  that broke, and a pool failover keeps one edge per attempt. Absent on rows
   *  from an engine older than path observation and on a job the round's budget
   *  canceled before it ran. */
  path?: PathGraph;
  /** the full-probe job this attempt belongs to (`core.HTTPProbe.FullProbeID`).
   *  Set only on rows served by GET /api/probes/full/{id}/results — the shared
   *  probes bucket keeps only full-probe SUCCESSES and never sends this, so a
   *  row from the history below has it absent. */
  full_probe_id?: string;
  /** the chain length this attempt probed (`core.HTTPProbe.Depth`): 1 for a
   *  single outbound, 2 for a rescued pair, ... Set only alongside
   *  full_probe_id; absent (not 0) on every other row and on engines older
   *  than per-job attempt storage. */
  depth?: number;
}

/** `POST /api/probes/run` body (`api.probeRunRequest`). */
export interface ProbeRunRequest {
  targets: string[];
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** route references to probe through; empty means every built outbound */
  routes?: string[];
  timeout_seconds?: number;
  max_body_bytes?: number;
}

/** `engine.probes.http` (`config.HTTPProbeConfig`) — the scheduled round's
 *  spec, the same shape as a manual run's.
 *
 *  The Go struct has no `omitempty` on any field, so a stored schedule serves
 *  every one of them back: the slices and the map as `null` when they were
 *  never set, the numbers as `0`. Typed as nullable for the same reason — an
 *  `?: string[]` would let a reader index a `null` the type says cannot
 *  arrive. */
export interface HTTPProbeConfig {
  targets?: string[] | null;
  method?: string;
  headers?: Record<string, string> | null;
  body?: string;
  routes?: string[] | null;
  timeout_seconds?: number;
  max_body_bytes?: number;
}

/** `engine.probes` with the HTTP section the pinned schema lacks. Additive and
 *  optional, so an `Engine` read from any engine build satisfies it — and
 *  `http` may be set back to `undefined`, which is how the schedule drops the
 *  HTTP probe while keeping the dial sweep. It stays assignable to
 *  `Engine["probes"]`, so a PUT of `{ ...engine, probes: draft }` typechecks. */
export interface ProbeEngineProbes extends NonNullable<Engine["probes"]> {
  http?: HTTPProbeConfig | undefined;
}

/** The 202 body of `POST /api/probes/run` when the round outlived the engine's
 *  wait window: it is still running detached, and its rows appear in
 *  `GET /api/probes/results` as they are recorded. A front proxy's 504 is
 *  converted to this same shape — the response was lost, but the round is still
 *  going, so polling is the right response. */
export interface ProbeRunAccepted {
  status?: string;
  message?: string;
}

/** A probe run's answer: the records when the round finished within the
 *  engine's wait window (a bare array, `null` when it had nothing in it), or
 *  the accepted shape when it is still running and the caller must poll
 *  `listProbeResults` for them. */
export type ProbeRunResponse = HTTPProbe[] | ProbeRunAccepted | null;

/** Runs one probe round now. A fast round answers with its records, in
 *  targets-then-routes order; a target that fails to answer is a record with
 *  `success: false`, not an error — that is what a probe is for. A round over a
 *  whole fleet outlives the engine's 25s wait and answers `accepted` instead,
 *  its rows landing in the history a moment later (see `stillProbing`). */
export async function runProbes(
  goose: Goose,
  req: ProbeRunRequest,
): Promise<ProbeRunResponse> {
  try {
    // 200 is a JSON array (null when the round had nothing in it); 202 is the
    // accepted object. Both are 2xx, so the transport decodes either.
    return await goose.client.send<ProbeRunResponse>(
      "POST",
      "/api/probes/run",
      req,
    );
  } catch (err) {
    // A front proxy's read timeout (504) cuts the response, not the round: on
    // the fixed engine the round runs detached and its rows still land, so
    // treat it as accepted and poll. A 502 is NOT this — it means the engine
    // refused or reset the connection (a crash or restart), a real failure to
    // surface rather than mask behind a poll that would find nothing.
    if (err instanceof GooseApiError && err.status === 504) {
      return { status: "accepted" };
    }
    throw new Error(apiMessage(err));
  }
}

/** True when the answer says the round is still running: the accepted object
 *  (a 202, or a 504 converted to it). An array is the finished records and a
 *  `null` body is a complete empty round — neither is "still probing". The
 *  null check is load-bearing: `null` is not an array, so a bare
 *  `!Array.isArray` would misread a 200 null as a round in flight. */
export function stillProbing(res: ProbeRunResponse): boolean {
  return res !== null && !Array.isArray(res);
}

/** Recorded probes, newest first (`GET /api/probes/results`). */
export async function listProbeResults(
  goose: Goose,
  opts: { n?: number; route?: string } = {},
): Promise<HTTPProbe[]> {
  const q = new URLSearchParams();
  if (opts.n !== undefined) q.set("n", String(opts.n));
  if (opts.route !== undefined && opts.route !== "") q.set("route", opts.route);
  const suffix = q.toString() === "" ? "" : `?${q.toString()}`;
  const res = await friendly(
    goose.client.get<HTTPProbe[] | null>(`/api/probes/results${suffix}`),
  );
  return res ?? [];
}

// ---------------------------------------------------------------------------
// Exit-IP checks: the single-run task
// ---------------------------------------------------------------------------

/** `POST /api/exit-checks/run` body (`exitip.RunSpec`). Every field is an
 *  override of the engine's configured exit-check settings, so a run needs no
 *  schedule turned on — and an empty body runs exactly what is configured. */
export interface ExitRunSpec {
  sites?: string[];
  /** restrict the round to these outbound ids; empty means every one */
  outbounds?: string[];
  timeout_seconds?: number;
  concurrency?: number;
}

/** The run's outcome. `complete` carries the round's records; `accepted`
 *  means the round outlived the request's patience and its rows will show up
 *  in the history a moment later. */
export interface ExitRunResponse {
  status?: string;
  checks?: ExitCheck[];
  message?: string;
  /** An engine older than this answer sends 202 with
   *  `{"error":"exit-IP check round started"}`: not a failure (202 decodes
   *  fine), just the only text it has, and still a round that is running. */
  error?: string;
}

export async function runExitChecksNow(
  goose: Goose,
  spec?: ExitRunSpec,
): Promise<ExitRunResponse> {
  // `{}` rather than no body: the endpoint accepts either, but an explicit
  // empty object keeps the request inspector readable. An engine that answers
  // with no body at all still gets a usable object back.
  const res = await friendly(
    goose.client.send<ExitRunResponse | null | undefined>(
      "POST",
      "/api/exit-checks/run",
      spec ?? {},
    ),
  );
  return res ?? {};
}

/** True when the response says the round is still going. Two shapes mean that:
 *  `status: "accepted"` from an engine that waited 25s for the run and gave up
 *  on it (leaving the round going in the background), and no `status` at all
 *  from an older engine, which answers 202 to every run — it has no "wait for
 *  it" mode — sending only `{"error":"exit-IP check round started"}`.
 *
 *  Anything else is not "still going": a future `{"status":"error"}` must
 *  surface as the failure it is rather than be polled as a round in flight. */
export function stillRunning(res: ExitRunResponse): boolean {
  return res.status === "accepted" || res.status === undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Message for a failed call, with the two statuses that mean "this engine
 *  build cannot do that" spelled out instead of passed through. */
export function apiMessage(err: unknown): string {
  if (err instanceof GooseApiError) {
    if (err.status === 404) {
      return "This engine has no such endpoint — it needs a newer engine build.";
    }
    if (err.status === 503) {
      return "The engine has not wired a runner for this endpoint.";
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** Rewraps a transport error so every caller — including `useAsync`, which
 *  only keeps `err.message` — shows the readable version. */
async function friendly<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw new Error(apiMessage(err));
  }
}
