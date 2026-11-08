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
  /** Go time.Duration — nanoseconds, like every other duration on the wire */
  latency?: number;
  startedAt?: string;
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
 *  spec, the same shape as a manual run's. */
export interface HTTPProbeConfig {
  targets?: string[];
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  routes?: string[];
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

/** Runs one probe round now and returns its records, in targets-then-routes
 *  order. A target that fails to answer is a record with `success: false`,
 *  not an error — that is what a probe is for. */
export async function runProbes(
  goose: Goose,
  req: ProbeRunRequest,
): Promise<HTTPProbe[]> {
  // The engine answers with a JSON array; a round with nothing in it encodes
  // as null, which is still "no results".
  const res = await friendly(
    goose.client.send<HTTPProbe[] | null>("POST", "/api/probes/run", req),
  );
  return res ?? [];
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
