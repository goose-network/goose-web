// src/pages/FullProbesPage.tsx — full active probing: set a target, launch
// the multi-level sweep, watch it discover which proxy paths reach the
// target, study every attempt it made, and turn the successful paths into
// inbound listeners — one per path, or one pool load-balancing over them.
//
// The sweep is the engine's fan-out search: level 1 probes local → every
// outbound (successes A, failures B); level 2 probes local → a → b for every
// a ∈ A, b ∈ B — a failed outbound relayed through a working one may succeed;
// deeper levels extend the surviving paths with the new failures, up to
// depth 5. This page is the workflow's cockpit: one form to start, a live
// progress card per job, an attempt-results card with server-side filters
// over the job's durable rows, and one button that applies the proved paths
// (local→A, local→A→C, ...) as chains + inbounds the engine starts at once.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Goose } from "@goose-network/goose-sdk";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { Notice, useToast } from "../components/Notice";
import { NumberField, SelectField, TextField } from "../components/fields";
import { probeResultColumns } from "../components/ProbeResultsTable";
import { formatDuration, formatTime } from "../format";
import {
  applyFullProbe,
  cancelFullProbe,
  classifyFullProbeResults404,
  fullProbeGoneMessage,
  fullProbeJobGone,
  fullProbeResultsMissing,
  getFullProbe,
  listFullProbeResults,
  listFullProbes,
  startFullProbe,
  type FullProbeJob,
} from "../fullProbeApi";
import type { HTTPProbe } from "../runApi";
import {
  APPLY_SELECTOR_HINT,
  APPLY_SELECTOR_OPTIONS,
  appliedForCard,
  bestPaths,
  buildApplySpec,
  buildFullProbeRequest,
  buildResultsOpts,
  FULL_PROBE_CAPS,
  FULL_PROBE_DEFAULTS,
  FULL_PROBE_POLL_MS,
  FULL_PROBE_TARGET_PRESETS,
  foldHeadPage,
  foldOlderPage,
  fullProbeFormProblems,
  fullProbePollDelay,
  fullProbeProgress,
  fullProbeRunning,
  INITIAL_APPLY_FIELDS,
  INITIAL_FULL_PROBE_FIELDS,
  INITIAL_RESULTS_FILTERS,
  levelSummaries,
  loadMoreAction,
  nextCursor,
  olderPageContiguous,
  pathLabel,
  poolApplyCapable,
  poolApplyPreview,
  RESULTS_PAGE_DEFAULT,
  RESULTS_PAGE_OPTIONS,
  RESULTS_RETENTION_NOTE,
  resultsDepthChoices,
  resultsExhaustedShort,
  resultsFiltersActive,
  resultsHopChoices,
  resultsLandingState,
  resultsReasonChoices,
  statePill,
  type AppliedState,
  type ApplyFields,
  type ApplyMode,
  type FullProbeFields,
  type ResultsCapability,
  type ResultsFilterFields,
} from "./fullProbeSpec";

export function FullProbesPage() {
  const { goose, engineKey } = useSdk();
  const { toast } = useToast();

  const [form, setForm] = useState<FullProbeFields>(INITIAL_FULL_PROBE_FIELDS);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** The job the live card follows, tagged with the engine it lives on;
   *  null shows the newest from history. The tag matters: a watch pinned
   *  on engine A must not poll A's job id against engine B after a switch
   *  (the 404 would masquerade as a pruned job). */
  const [watch, setWatch] = useState<{ id: string; engine: string } | null>(null);
  /** Results of the last apply, tagged with the engine + job they belong
   *  to and shown until the next one (or a job/engine switch). */
  const [applied, setApplied] = useState<AppliedState | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  /** What apply builds: one inbound per path (the default, wire-identical
   *  to what this page always sent) or one pool over the proved paths. */
  const [applyMode, setApplyMode] = useState<ApplyMode>("inbounds");
  const [applyFields, setApplyFields] = useState<ApplyFields>(INITIAL_APPLY_FIELDS);
  /** The results endpoint's capability, probed by the attempt-results
   *  card's first fetch. Reset on every job/engine switch — the new engine
   *  must earn the pool toggle on its own. */
  const [resultsCap, setResultsCap] = useState<ResultsCapability>("unknown");
  const onResultsCapability = useCallback(
    (cap: ResultsCapability) => setResultsCap(cap),
    [],
  );

  // Tag the list with the engine it came from: useAsync keeps the previous
  // data until the new fetch lands, and right after an engine switch that
  // data names the OLD engine's jobs. Following its newest id would poll a
  // foreign job id and surface a bogus "pruned from history" notice.
  const history = useAsync(
    async () => ({ engine: engineKey, jobs: await listFullProbes(goose, 20) }),
    [goose, engineKey],
  );
  const freshJobs = history.data?.engine === engineKey ? history.data.jobs : undefined;

  // The live job: poll while it runs, stop when it lands. A watch pinned on
  // the current engine picks the job explicitly; otherwise follow the newest
  // one the CURRENT engine's history knows (undefined until it loads).
  const watchId = watch !== null && watch.engine === engineKey ? watch.id : undefined;
  const newestId = freshJobs?.[0]?.id;
  const activeId = watchId ?? newestId;
  const [live, setLive] = useState<FullProbeJob | undefined>(undefined);
  const [liveError, setLiveError] = useState<string | null>(null);
  /** A gone-job (404) notice lives outside liveError: the gone branch
   *  itself changes activeId (watch reset / history reload), and the poll
   *  effect clears liveError on every switch — which would wipe the very
   *  message explaining where the sweep went. Dismissable, and cleared
   *  when a new sweep starts. */
  const [goneNotice, setGoneNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  /** Fences the poll chain: bumping it orphans every in-flight fetch and
   *  pending timer from an earlier job/engine, so a stale answer can never
   *  paint the wrong card or double-schedule the chain. */
  const pollEpoch = useRef(0);
  /** Mirrors activeId for async handlers: cancel/apply capture the job at
   *  click time, and their deferred work must not touch the card (or the
   *  poll chain) once the reader has switched jobs or engines. */
  const activeIdRef = useRef<string | undefined>(undefined);
  activeIdRef.current = activeId;
  /** Mirrors the engine identity (URL, not client instance): job ids alone
   *  can't fence an engine switch — a pinned watch can name a job that
   *  exists on both engines, and a stale closure's re-poll would re-anchor
   *  the chain to the old engine. Deferred work also compares the engine
   *  captured at call time against this. Identity is the URL so a
   *  reconnect to the SAME engine (new client instance) doesn't discard
   *  work that landed on the engine still on screen. */
  const engineKeyRef = useRef(engineKey);
  engineKeyRef.current = engineKey;

  const poll = useCallback(
    (id: string, failures = 0) => {
      // One chain per invocation: cancel's manual re-poll must not run
      // alongside the scheduled one.
      const epoch = ++pollEpoch.current;
      window.clearTimeout(timer.current);
      getFullProbe(goose, id)
        .then((j) => {
          if (epoch !== pollEpoch.current) return;
          setLive(j);
          setLiveError(null);
          if (fullProbeRunning(j)) {
            timer.current = window.setTimeout(
              () => poll(id),
              FULL_PROBE_POLL_MS,
            );
          } else {
            history.reload();
          }
        })
        .catch((err: unknown) => {
          if (epoch !== pollEpoch.current) return;
          if (fullProbeJobGone(err)) {
            // The job is gone (pruned from history or lost in a restart):
            // stop following it, surface why, and let Start work again.
            // The implicit job switch must drop the previous job's apply
            // results too, or they would render under the new card.
            setGoneNotice(errMessage(err));
            setLive(undefined);
            setApplied(null);
            setApplyError(null);
            // Match the engine too: job ids can coincide across engines,
            // and this 404 must not unpin a watch pinned on another one.
            setWatch((w) =>
              w !== null && w.id === id && w.engine === engineKey ? null : w,
            );
            history.reload();
            return;
          }
          // Transient failures must not stop live updates: retry with a
          // capped backoff, keeping the last snapshot on screen.
          setLiveError(errMessage(err));
          timer.current = window.setTimeout(
            () => poll(id, failures + 1),
            fullProbePollDelay(failures + 1),
          );
        });
    },
    // history.reload is stable (useAsync's useCallback); listing it would
    // restart the poll chain on every history render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goose],
  );
  /** The latest poll closure, for deferred re-polls (cancel). The fence
   *  guarantees the same engine, but a same-URL reconnect rotates the
   *  client (and maybe the token): the click-time closure would re-anchor
   *  the chain to a superseded client and retry forever on a revoked
   *  token, orphaning the healthy chain the poll effect just restarted. */
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    // Fence + cancel any chain from the previous job/engine before the new
    // one starts; in-flight fetches from it are orphaned by the bump.
    pollEpoch.current++;
    window.clearTimeout(timer.current);
    setLive(undefined);
    setLiveError(null);
    // The followed job changed: the previous job's apply results must not
    // render under the new card (same rule as the Watch handler).
    setApplied(null);
    setApplyError(null);
    if (activeId !== undefined && activeId !== "") poll(activeId);
    return () => {
      pollEpoch.current++;
      window.clearTimeout(timer.current);
    };
  }, [activeId, poll]);

  // Engine switches drop the gone-job notice: it explains a job on the
  // previous engine. Keyed on engineKey alone — the poll effect can't
  // clear it, because the gone branch itself changes activeId and would
  // wipe the fresh notice it just set. (A reconnect to the same engine
  // keeps the notice: the job really is gone from that engine.)
  useEffect(() => {
    setGoneNotice(null);
  }, [engineKey]);

  // The capability probe belongs to one engine + job: a switch re-probes
  // (the results card remounts on its key and fetches again). Until the
  // new probe lands the pool toggle stays gated.
  useEffect(() => {
    setResultsCap("unknown");
  }, [engineKey, activeId]);
  // A capability downgrade (engine switch to an older build) must not leave
  // the form in pool mode: the toggle is disabled there, and submitting a
  // mode the reader can no longer see selected would be a silent surprise.
  useEffect(() => {
    if (resultsCap !== "ok") setApplyMode("inbounds");
  }, [resultsCap]);

  const problems = fullProbeFormProblems(form);
  const canStart =
    Object.keys(problems).length === 0 && !starting && !fullProbeRunning(live);

  const start = async () => {
    const g = goose;
    const key = engineKey;
    setStarting(true);
    setStartError(null);
    setApplied(null);
    setGoneNotice(null);
    try {
      const j = await startFullProbe(g, buildFullProbeRequest(form));
      // The engine may have switched while the POST was in flight: the
      // new job lives on the old engine, so don't pin the card to it.
      if (engineKeyRef.current === key) {
        if (j.id !== undefined) setWatch({ id: j.id, engine: key });
        toast("Full active probing started", "good");
        history.reload();
      }
    } catch (err) {
      if (engineKeyRef.current === key) setStartError(errMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    const id = live?.id;
    const g = goose;
    const key = engineKey;
    if (id === undefined) return;
    try {
      const canceled = await cancelFullProbe(g, id);
      // The DELETE may resolve after a watch/engine switch: touching the
      // card or the poll chain then would orphan the new job's chain and
      // paint the old job over it. The engine check matters even when the
      // id matches — a pinned watch can name a job on both engines, and
      // poll(id) here would re-anchor the chain to the closure's engine.
      if (activeIdRef.current !== id || engineKeyRef.current !== key) return;
      if (canceled) {
        toast("Sweep canceled", "good");
      } else {
        // 404 resolves false: the job is already gone, not canceled now.
        toast("That sweep is no longer on the engine", "bad");
      }
      pollRef.current(id);
    } catch (err) {
      if (activeIdRef.current !== id || engineKeyRef.current !== key) return;
      setLiveError(errMessage(err));
      // A 409 (already finished) leaves a stale "running" card; re-read so
      // the terminal state lands and Start unblocks.
      pollRef.current(id);
    }
  };

  const apply = async () => {
    const id = live?.id;
    const g = goose;
    const key = engineKey;
    if (id === undefined) return;
    const mode = applyMode;
    setApplying(true);
    setApplyError(null);
    try {
      // buildApplySpec keeps the default mode's body byte-identical to the
      // `{}` this page always sent — an older engine rejects unknown fields.
      const res = await applyFullProbe(g, id, buildApplySpec(mode, applyFields));
      // An apply resolving after a watch/engine switch must not attribute
      // the old job's created inbounds to the new card.
      if (activeIdRef.current !== id || engineKeyRef.current !== key) return;
      setApplied({
        engine: key,
        job: id,
        mode,
        results: res.results ?? [],
        // Additive pool-mode fields: absent on an inbounds-mode answer,
        // and exactOptionalPropertyTypes forbids storing undefined.
        ...(res.pool_id !== undefined ? { poolId: res.pool_id } : {}),
        ...(res.inbound_id !== undefined ? { inboundId: res.inbound_id } : {}),
        ...(res.listen !== undefined ? { listen: res.listen } : {}),
        ...(res.protocol !== undefined ? { protocol: res.protocol } : {}),
        ...(res.selector !== undefined ? { selector: res.selector } : {}),
      });
      if (mode === "pool") {
        toast(
          `Created pool ${res.pool_id ?? ""} — ${res.results?.length ?? 0} member chain${(res.results?.length ?? 0) === 1 ? "" : "s"} behind inbound ${res.inbound_id ?? ""}`,
          "good",
        );
      } else {
        toast(
          `Created ${res.results?.length ?? 0} inbound${(res.results?.length ?? 0) === 1 ? "" : "s"} from the proved paths`,
          "good",
        );
      }
    } catch (err) {
      if (activeIdRef.current !== id || engineKeyRef.current !== key) return;
      setApplyError(errMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const set = (patch: Partial<FullProbeFields>) =>
    setForm((f) => ({ ...f, ...patch }));
  const setApply = (patch: Partial<ApplyFields>) =>
    setApplyFields((f) => ({ ...f, ...patch }));

  const progress = fullProbeProgress(live);
  const levels = levelSummaries(live);
  const paths = bestPaths(live);
  const pill = statePill(live);
  const finished = live !== undefined && !fullProbeRunning(live);
  // The applied block only under the card whose engine + job it names: a
  // deferred answer landing after a switch renders nowhere (the effects
  // also clear the state, but a render can race them).
  const shownApplied = appliedForCard(applied, engineKey, activeId);
  const poolCapable = poolApplyCapable(resultsCap);
  const poolPreview = poolApplyPreview(live);
  // The pool id the engine will default to, for the field's placeholder:
  // "<id_prefix>-pool", with the engine's own id-prefix default behind it.
  const defaultPoolId = `${applyFields.idPrefix.trim() !== "" ? applyFields.idPrefix.trim() : `fullprobe-${live?.id ?? ""}`}-pool`;

  const columns: Array<Column<FullProbeJob>> = [
    { key: "id", header: "Job", className: "mono", render: (j) => j.id },
    { key: "target", header: "Target", className: "mono", render: (j) => j.spec?.target },
    {
      key: "state",
      header: "State",
      render: (j) => {
        const p = statePill(j);
        return <span className={p.cls}>{p.text}</span>;
      },
    },
    {
      key: "depth",
      header: "Depth",
      className: "num",
      render: (j) => j.levels?.length ?? 0,
    },
    {
      key: "attempts",
      header: "Attempts",
      className: "num",
      render: (j) => j.total_attempts ?? 0,
    },
    { key: "started", header: "Started", render: (j) => formatTime(j.startedAt) },
    {
      key: "watch",
      header: "",
      render: (j) => (
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setWatch(j.id !== undefined ? { id: j.id, engine: engineKey } : null);
            setApplied(null);
            setApplyError(null);
          }}
        >
          Watch
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Full active probing"
        sub="Discover which proxy paths reach a target — including failed outbounds rescued through working ones — then create inbounds from the proved paths."
      />

      <div className="card">
        <div className="card-head">
          <h2>Sweep</h2>
        </div>
        <TextField
            id="fp-target"
            label="Target"
            type="url"
            mono
            value={form.target}
            onChange={(v) => set({ target: v })}
            placeholder="https://www.gstatic.com/generate_204"
            hint="Every attempt is a real HTTP request toward this URL through a pinned path."
            error={problems.target}
        />
        <div className="row">
          <SelectField
            id="fp-preset"
            label="Preset"
            value=""
            onChange={(v) => v !== "" && set({ target: v })}
            options={FULL_PROBE_TARGET_PRESETS.map((p) => ({
              value: p.url,
              label: `${p.url} (${p.note})`,
            }))}
            emptyOption="(pick a target)"
          />
          <NumberField
            id="fp-depth"
            label="Max depth"
            value={form.maxDepth}
            onChange={(v) => set({ maxDepth: v })}
            min={0}
            max={FULL_PROBE_CAPS.maxDepth}
            placeholder={String(FULL_PROBE_DEFAULTS.depth)}
            hint={`Chain length to explore, 1–${FULL_PROBE_CAPS.maxDepth}.`}
            error={problems.maxDepth}
          />
          <NumberField
            id="fp-rps"
            label="Probe rate (rps)"
            value={form.rps}
            onChange={(v) => set({ rps: v })}
            min={0}
            max={FULL_PROBE_CAPS.maxRPS}
            placeholder={String(FULL_PROBE_DEFAULTS.rps)}
            hint={`Requests per second, up to ${FULL_PROBE_CAPS.maxRPS}.`}
            error={problems.rps}
          />
          <NumberField
            id="fp-timeout"
            label="Timeout (s)"
            value={form.timeoutSec}
            onChange={(v) => set({ timeoutSec: v })}
            min={0}
            max={FULL_PROBE_CAPS.maxTimeoutSec}
            placeholder={String(FULL_PROBE_DEFAULTS.timeoutSec)}
            hint={`Per attempt, up to ${FULL_PROBE_CAPS.maxTimeoutSec}s.`}
            error={problems.timeoutSec}
          />
          <NumberField
            id="fp-concurrency"
            label="Concurrency"
            value={form.concurrency}
            onChange={(v) => set({ concurrency: v })}
            min={0}
            max={FULL_PROBE_CAPS.maxConcurrency}
            placeholder="2×rps"
            hint="In-flight attempts; 0 derives it from the rate."
            error={problems.concurrency}
          />
        </div>
        {startError !== null && (
          <Notice onDismiss={() => setStartError(null)}>{startError}</Notice>
        )}
        <div className="toolbar">
          <button
            type="button"
            className="primary"
            disabled={!canStart}
            onClick={() => void start()}
            title={
              fullProbeRunning(live)
                ? "A sweep is already running on this card — wait for it or cancel it."
                : undefined
            }
          >
            {starting ? "Starting…" : "Full active probing"}
          </button>
        </div>
      </div>

      {goneNotice !== null && (
        <Notice onDismiss={() => setGoneNotice(null)}>{goneNotice}</Notice>
      )}

      {live !== undefined && (
        <div className="card">
          <div className="card-head">
            <h2>
              Job <span className="mono">{live.id}</span>
            </h2>
            <span className={pill.cls}>{pill.text}</span>
          </div>
          {liveError !== null && <Notice>{liveError}</Notice>}
          {live.state === "error" && (
            <Notice>{live.error ?? "The sweep failed to run."}</Notice>
          )}
          <p className="page-sub">
            {live.spec?.target} · depth ≤ {live.spec?.max_depth ?? "?"} ·{" "}
            {live.spec?.rps ?? "?"} rps · started {formatTime(live.startedAt)}
          </p>
          {progress !== null && (
            <p>
              <strong>{progress.done}</strong> / {progress.total} attempts (
              {progress.pct}%)
            </p>
          )}
          {fullProbeRunning(live) && (live.spec?.catchup_seconds ?? 0) > 0 && (
            <p className="page-sub">
              Catch-up bound: {live.spec?.catchup_seconds}s. After the sweep,
              engines with providers keep probing outbounds that register late
              (depth 1) until the fleet goes quiet or this bound expires —
              progress can read 100% while the job stays running. Without
              providers a single final pass covers late arrivals instead.
            </p>
          )}
          {levels.length > 0 && (
            <table className="data">
              <caption className="sr-only">Per-depth progress</caption>
              <thead>
                <tr>
                  <th>Depth</th>
                  <th className="num">Done</th>
                  <th className="num">OK</th>
                  <th className="num">Failed</th>
                  <th className="num">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((l) => (
                  <tr key={l.depth}>
                    <td>
                      local → {l.depth} hop{l.depth === 1 ? "" : "s"}{" "}
                      {l.finished ? "" : "…"}
                    </td>
                    <td className="num">
                      {l.done}/{l.total}
                    </td>
                    <td className="num status-ok">{l.success}</td>
                    <td className="num status-bad">{l.failed}</td>
                    <td className="num">{l.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* The per-attempt results view below (filters + paging over the
              job's durable rows) is the one place every attempt is studied on
              engines that serve it, so the old snapshot summaries are gone
              there. Engines without the endpoint still get them: the snapshot
              is their only pre-apply view of which paths were proved. */}
          {resultsCap === "old" && (
            <>
              {(live?.levels ?? []).some((l) => (l.success_paths?.length ?? 0) > 0) && (
                <>
                  <h3 className="card-sub">Proved paths</h3>
                  <ul>
                    {(live?.levels ?? []).flatMap((l) =>
                      (l.success_paths ?? []).map((p, i) => (
                        <li key={`${l.depth}-${i}`} className="mono">
                          {pathLabel(p)}{" "}
                          <span className="pill ok">
                            {formatDuration(p.latency)}
                            {p.status !== undefined && p.status > 0 ? ` · ${p.status}` : ""}
                          </span>
                        </li>
                      )),
                    )}
                  </ul>
                </>
              )}
              {(live?.levels ?? []).some((l) => (l.failed_items?.length ?? 0) > 0) && (
                <>
                  <h3 className="card-sub">Failed items (retried behind the successes)</h3>
                  <ul>
                    {(live?.levels ?? []).flatMap((l) =>
                      (l.failed_items ?? []).map((fi) => (
                        <li key={`${l.depth}-${fi.id}`} className="mono">
                          depth {l.depth}: {fi.id} ×{fi.count}
                          {fi.reason !== undefined && fi.reason !== "" ? ` — ${fi.reason}` : ""}
                        </li>
                      )),
                    )}
                  </ul>
                </>
              )}
            </>
          )}

          <h3 className="card-sub">Create from the proved paths</h3>
          <div className="field">
            <span className="label" id="fp-apply-mode-label">Mode</span>
            <div className="theme-toggle" role="group" aria-labelledby="fp-apply-mode-label">
              <button
                type="button"
                aria-pressed={applyMode === "inbounds"}
                onClick={() => setApplyMode("inbounds")}
              >
                Inbound per path
              </button>
              <button
                type="button"
                aria-pressed={applyMode === "pool"}
                disabled={!poolCapable}
                title={
                  poolCapable
                    ? "One pool load-balancing over the proved paths, behind a single inbound."
                    : "Pool mode needs a newer engine build — the same one that serves per-job attempt results."
                }
                onClick={() => setApplyMode("pool")}
              >
                Single pool inbound
              </button>
            </div>
            {resultsCap === "old" && (
              <div className="field-hint">
                This engine has no per-job attempt results endpoint, so it
                predates pool-mode apply too — upgrade the engine to use it.
              </div>
            )}
          </div>

          <div className="row">
            <SelectField
              id="fp-apply-protocol"
              label="Protocol"
              value={applyFields.protocol}
              options={["socks5", "http"]}
              emptyOption="(default socks5)"
              onChange={(protocol) => setApply({ protocol })}
            />
            <TextField
              id="fp-apply-listen"
              label="Listen prefix"
              mono
              value={applyFields.listenPrefix}
              onChange={(listenPrefix) => setApply({ listenPrefix })}
              placeholder="127.0.0.1"
              hint="Host the generated inbound(s) listen on."
            />
            <NumberField
              id="fp-apply-port"
              label="Port"
              value={applyFields.port}
              onChange={(port) => setApply({ port })}
              min={0}
              max={65535}
              placeholder="free port"
              hint={
                applyMode === "pool"
                  ? "The one inbound's port; 0 picks a free one."
                  : "First port; each further inbound takes the next. 0 picks a free port per inbound."
              }
            />
            <TextField
              id="fp-apply-prefix"
              label="ID prefix"
              mono
              value={applyFields.idPrefix}
              onChange={(idPrefix) => setApply({ idPrefix })}
              placeholder={`fullprobe-${live.id ?? ""}`}
              hint="Names the generated chains and inbounds."
            />
          </div>

          {applyMode === "pool" && (
            <div className="row">
              <TextField
                id="fp-apply-pool-id"
                label="Pool ID"
                mono
                value={applyFields.poolId}
                onChange={(poolId) => setApply({ poolId })}
                placeholder={defaultPoolId}
                hint="Empty uses <id prefix>-pool. An existing pool of the same id is refused, not merged."
              />
              <SelectField
                id="fp-apply-selector"
                label="Selector"
                value={applyFields.selector}
                options={APPLY_SELECTOR_OPTIONS}
                onChange={(selector) => setApply({ selector })}
                hint={APPLY_SELECTOR_HINT}
              />
            </div>
          )}

          <p className="hint">
            {applyMode === "pool"
              ? poolPreview
              : "One chain + inbound per proved depth (the fastest path each)."}
          </p>

          {applyError !== null && (
            <Notice onDismiss={() => setApplyError(null)}>{applyError}</Notice>
          )}
          <div className="toolbar">
            {fullProbeRunning(live) ? (
              <button type="button" className="danger" onClick={() => void cancel()}>
                Cancel sweep
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={!finished || applying || paths.length === 0}
                onClick={() => void apply()}
                title={
                  paths.length === 0
                    ? "The sweep proved no path to build from."
                    : applyMode === "pool"
                      ? "Create one pool over the proved paths behind a single inbound."
                      : "Create one chain + inbound per proved depth (fastest path each)."
                }
              >
                {applying
                  ? "Creating…"
                  : applyMode === "pool"
                    ? "Create pool inbound"
                    : "Create inbounds from paths"}
              </button>
            )}
          </div>

          {shownApplied !== null && shownApplied.results.length > 0 && (
              shownApplied.mode === "pool" ? (
                <>
                  <h3 className="card-sub">Created pool</h3>
                  <dl className="def-grid">
                    <div>
                      <dt>Pool</dt>
                      <dd className="mono">{shownApplied.poolId ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Inbound</dt>
                      <dd className="mono">{shownApplied.inboundId ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Listen</dt>
                      <dd className="mono">{shownApplied.listen ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Protocol</dt>
                      <dd>{shownApplied.protocol ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Selector</dt>
                      <dd>
                        <span className="pill">{shownApplied.selector?.type ?? "—"}</span>
                      </dd>
                    </div>
                  </dl>
                  <table className="data">
                    <caption className="sr-only">Pool member chains</caption>
                    <thead>
                      <tr>
                        <th>Member chain</th>
                        <th>Path</th>
                        <th>Latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownApplied.results.map((r) => (
                        <tr key={r.chain_id}>
                          <td className="mono">{r.chain_id}</td>
                          <td className="mono">
                            {r.path !== undefined ? pathLabel(r.path) : ""}
                          </td>
                          <td>
                            {r.path !== undefined && (
                              <span className="pill ok">
                                {formatDuration(r.path.latency)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="page-sub">
                    The engine starts the listener at once — point a client at
                    it and each request rides one proved chain, picked by the
                    pool's selector.
                  </p>
                </>
              ) : (
                <>
                  <h3 className="card-sub">Created inbounds</h3>
                  <table className="data">
                    <caption className="sr-only">Generated inbounds</caption>
                    <thead>
                      <tr>
                        <th>Inbound</th>
                        <th>Listen</th>
                        <th>Protocol</th>
                        <th>Path</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownApplied.results.map((r) => (
                        <tr key={r.inbound_id}>
                          <td className="mono">{r.inbound_id}</td>
                          <td className="mono">{r.listen}</td>
                          <td>{r.protocol}</td>
                          <td className="mono">
                            {r.path !== undefined ? pathLabel(r.path) : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="page-sub">
                    The engine starts these listeners at once — point a client at
                    one and its traffic rides the proved chain.
                  </p>
                </>
              )
            )}
        </div>
      )}

      {live !== undefined && activeId !== undefined && activeId !== "" && (
        <AttemptResultsCard
          key={`${engineKey}:${activeId}`}
          goose={goose}
          engineKey={engineKey}
          jobId={activeId}
          job={live}
          onCapability={onResultsCapability}
        />
      )}

      <div className="card">
        <div className="card-head">
          <h2>History</h2>
          <button
            type="button"
            className="ghost"
            onClick={history.reload}
            disabled={history.loading}
          >
            Refresh
          </button>
        </div>
        <DataTable
          caption="Full active probing jobs"
          columns={columns}
          rows={freshJobs ?? []}
          rowKey={(j) => j.id ?? ""}
          loading={history.loading && freshJobs === undefined}
          error={history.error}
          onRetry={history.reload}
          empty={
            <EmptyState
              title="No sweeps yet"
              hint="Set a target above and press Full active probing."
            />
          }
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Attempt results: every issued attempt of the watched job, server-side
// filtered, cursor-paged
// ---------------------------------------------------------------------------
//
// The card is keyed by engine:job in the parent, so a job/engine switch
// remounts it with fresh state — the loaded rows, cursor and filters of the
// previous job can never render under the new card. Inside, every fetched
// payload is ALSO tagged {engine, job, filtersKey, pageSize} and folded only
// on a tag match: useAsync keeps the previous data until the new fetch lands,
// and its landed-watermark lets a slow older fetch land after a newer one was
// started — the tag is what keeps that stale answer out of the view.
//
// Reset rule: a filter/page-size change resets to a fresh first page (the
// cursor walked the OLD filter's rows); a poll tick merges the head refresh
// into the loaded window by row id (foldHeadPage) — unless the head no longer
// overlaps it, which resets the window to the head alone rather than keep an
// unreachable hole. Once the reader has used Load-more or a filter, the
// auto-refresh pauses (they are studying a slice, not watching the newest
// rows) and Refresh is manual.

/** One fetched page, tagged with the scope it was fetched for. */
interface ResultsPage {
  engine: string;
  job: string;
  filtersKey: string;
  pageSize: number;
  before: string;
  rows: HTTPProbe[];
  /** true when /results 404'd AND the job snapshot still loads: the ENGINE
   *  predates the endpoint — the capability probe's negative answer. A 404
   *  whose snapshot ALSO 404s is a gone job instead (gone below), never a
   *  capability verdict: history eviction must not mislabel a capable engine
   *  "old" and disable pool-mode apply. */
  unsupported: boolean;
  /** Non-null when the job left the engine's history (results 404 + snapshot
   *  404): the parent's gone-notice wording, rendered in the card because the
   *  parent's poll has already stopped on this terminal job and will never
   *  discover the eviction itself. */
  gone: string | null;
}

/** The loaded window, tagged the same way. `exhausted` means the cursor
 *  walked to the end: a page came back shorter than asked AND the job is
 *  terminal (while it runs, late completions can still land rows below any
 *  cursor — foldHeadPage/foldOlderPage suppress the latch). A head fold that
 *  loses overlap with the window CLEARS it — a proven end only stands while
 *  the window stays contiguous with the newest rows. */
interface LoadedResults {
  engine: string;
  job: string;
  filtersKey: string;
  rows: HTTPProbe[];
  exhausted: boolean;
}

function AttemptResultsCard({
  goose,
  engineKey,
  jobId,
  job,
  onCapability,
}: {
  goose: Goose;
  engineKey: string;
  jobId: string;
  /** the job snapshot the parent's poll keeps fresh — the filter
   *  vocabularies and the honesty banner read it, never the loaded rows */
  job: FullProbeJob;
  onCapability: (cap: ResultsCapability) => void;
}) {
  const [filters, setFilters] = useState<ResultsFilterFields>(INITIAL_RESULTS_FILTERS);
  const [pageSize, setPageSize] = useState<number>(RESULTS_PAGE_DEFAULT);
  /** The cursor the current fetch asks for: "" = the head (newest page). */
  const [before, setBefore] = useState("");
  const [loaded, setLoaded] = useState<LoadedResults | null>(null);
  /** Load-more or a filter was used: pause the head-refresh poll. A job or
   *  engine switch remounts the card (fresh false); a filter change keeps
   *  the pause — the reader is narrowing, not watching. */
  const [touched, setTouched] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  /** The job left the engine's history (results 404 + snapshot 404). Lives
   *  in the card, not the parent: the parent's poll stopped when this
   *  terminal job landed, so only a results fetch can discover the eviction.
   *  Dismissable like the parent's gone notice; a remount (job/engine switch)
   *  or a successful fetch clears it. */
  const [goneNotice, setGoneNotice] = useState<string | null>(null);

  const filtersKey = JSON.stringify(filters);
  const running = fullProbeRunning(job);

  // Reset to a fresh first page when the scope changes — filters, page size,
  // job or engine. NOT on a poll tick: `job` is a new object every tick, but
  // none of these deps is, so the loaded window survives (the head refresh
  // merges into it). The remount key covers job/engine; listing them here
  // too keeps the rule explicit if the key ever changes.
  useEffect(() => {
    setLoaded(null);
    setBefore("");
  }, [engineKey, jobId, filtersKey, pageSize]);

  const page = useAsync<ResultsPage>(
    async () => {
      try {
        const rows = await listFullProbeResults(
          goose,
          jobId,
          buildResultsOpts(filters, pageSize, before),
        );
        return {
          engine: engineKey,
          job: jobId,
          filtersKey,
          pageSize,
          before,
          rows,
          unsupported: false,
          gone: null,
        };
      } catch (err) {
        if (fullProbeResultsMissing(err)) {
          // A results 404 alone is AMBIGUOUS: the engine may predate the
          // endpoint, or the job may have been evicted from the 64-job
          // history (a restart does NOT lose finished jobs — history is
          // persisted — but newer sweeps push terminal jobs out). Latching
          // "old" on the eviction would disable pool-mode apply on a
          // perfectly capable engine until a remount, so disambiguate
          // against the job snapshot FIRST.
          const kind = await classifyFullProbeResults404(goose, jobId);
          if (kind === "gone") {
            // The job is gone from history — surface the parent's wording,
            // latch NO capability (an evicted job says nothing about the
            // engine build; mislabeling "old" would disable pool-mode apply
            // on a capable engine until a remount).
            return {
              engine: engineKey,
              job: jobId,
              filtersKey,
              pageSize,
              before,
              rows: [],
              unsupported: false,
              gone: fullProbeGoneMessage(jobId),
            };
          }
          if (kind === "unsupported") {
            // The snapshot loads but /results 404s: the endpoint truly is
            // missing (old engines serve the snapshot). Report the
            // capability instead of an error; the parent's job poll
            // continues untouched.
            return {
              engine: engineKey,
              job: jobId,
              filtersKey,
              pageSize,
              before,
              rows: [],
              unsupported: true,
              gone: null,
            };
          }
          // The snapshot itself failed transiently: nothing is proven.
          // Surface a retryable error rather than latch either verdict.
          throw new Error(
            "Could not read the attempt results or confirm the job — retry in a moment.",
          );
        }
        throw err;
      }
    },
    [goose, engineKey, jobId, filtersKey, pageSize, before],
  );

  // Fold each landed page into the loaded window — only on a tag match, so
  // a stale answer from a superseded filter/job/engine can never paint it.
  // The fold is idempotent (merge dedupes by id; a reset re-lands the same
  // head), which makes StrictMode's double-invoked effects harmless.
  useEffect(() => {
    const d = page.data;
    if (d === undefined) return;
    if (
      d.engine !== engineKey ||
      d.job !== jobId ||
      d.filtersKey !== filtersKey ||
      d.pageSize !== pageSize
    ) {
      return;
    }
    // The landing verdict (gone / unsupported / success-with-recovery) is
    // one pure decision — see resultsLandingState. A success ALWAYS clears
    // the unsupported latch and re-probes "ok": an engine upgraded while
    // the page is open re-enables pool mode without a remount.
    const landing = resultsLandingState(d);
    setGoneNotice(d.gone);
    setUnsupported(landing.unsupported);
    if (landing.capability !== null) onCapability(landing.capability);
    if (d.gone !== null || d.unsupported) return;
    setLoaded((prev) => {
      const fresh =
        prev !== null &&
        prev.engine === d.engine &&
        prev.job === d.job &&
        prev.filtersKey === d.filtersKey;
      if (d.before === "") {
        // Head fetch: the newest page. foldHeadPage owns the contiguity
        // rule — an overlapping head merges (a proven end stays proven for
        // a TERMINAL job), a short head spans the whole stored set, and a
        // FULL head with no overlap resets the window to the head alone so
        // an unreachable hole can never hide behind a latched "end of the
        // stored rows". While the job runs, late completions can still land
        // rows below any walked cursor, so `running` suppresses the latch.
        const fold = foldHeadPage(
          fresh ? prev.rows : [],
          fresh ? prev.exhausted : false,
          d.rows,
          d.pageSize,
          running,
        );
        return { engine: d.engine, job: d.job, filtersKey: d.filtersKey, rows: fold.rows, exhausted: fold.exhausted };
      }
      // Older page (Load-more): append below the loaded window. If a scope
      // reset raced the fetch there is no window to append to — the head
      // refetch the reset triggered owns the view now. A within-scope head
      // RESET (full head, no overlap) keeps the scope tags but moves the
      // tail: this page was fetched against the OLD cursor and would append
      // below an unreachable gap, so the contiguity guard drops it too — the
      // next Load-more click pages from the new tail.
      if (!fresh || !olderPageContiguous(prev.rows, d.before)) return prev;
      const fold = foldOlderPage(prev.rows, d.rows, d.pageSize, running);
      return { ...prev, rows: fold.rows, exhausted: fold.exhausted };
    });
  }, [page.data, engineKey, jobId, filtersKey, pageSize, running, onCapability]);

  // Head-refresh poll: while the job runs AND the view is the untouched
  // first page. Load-more/filter use pauses it (manual Refresh); the
  // capability downgrade and the gone verdict stop it for good — polling a
  // job the engine no longer knows would 404 every cadence.
  useEffect(() => {
    if (!running || touched || before !== "" || unsupported || goneNotice !== null) return;
    const t = window.setInterval(() => page.reload(), FULL_PROBE_POLL_MS);
    return () => window.clearInterval(t);
  }, [running, touched, before, unsupported, goneNotice, page.reload]);

  // The tick that lands the terminal state: when the job finishes, take one
  // last head refresh so the final rows are on screen without a manual click.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (
      wasRunning.current && !running && !touched && before === "" &&
      !unsupported && goneNotice === null
    ) {
      page.reload();
    }
    wasRunning.current = running;
  }, [running, touched, before, unsupported, goneNotice, page.reload]);

  // Vocabularies come from the JOB SNAPSHOT, never the returned rows: a
  // server-side filter over one page would otherwise offer only the values
  // already on screen, and the reader could never narrow to anything the
  // first page missed.
  const depthChoices = useMemo(() => resultsDepthChoices(job), [job]);
  const reasonChoices = useMemo(() => resultsReasonChoices(job), [job]);
  const hopChoices = useMemo(() => resultsHopChoices(job), [job]);

  const patchFilters = (patch: Partial<ResultsFilterFields>) => {
    setTouched(true);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const loadMore = () => {
    if (loaded === null) return;
    const action = loadMoreAction(loaded.rows, before);
    if (action === null) return;
    setTouched(true);
    // An empty older page (a running job's late rows are not recorded yet)
    // leaves before === cursor: setBefore would be a no-op — deps unchanged,
    // no refetch, an inert button. Bump the tick to re-query the SAME page
    // instead; the fold appends whatever landed below the cursor since.
    if (action.refetch) page.reload();
    else setBefore(action.cursor);
  };

  const refresh = () => {
    // Back to the head: setting before="" refetches (deps change); when
    // already there, bump the tick. Either way exactly one fetch, merged
    // into the loaded window by the fold above.
    if (before === "") page.reload();
    else setBefore("");
  };

  const rows =
    loaded !== null &&
    loaded.engine === engineKey &&
    loaded.job === jobId &&
    loaded.filtersKey === filtersKey
      ? loaded.rows
      : [];
  const exhausted = loaded?.exhausted ?? false;
  const filtered = resultsFiltersActive(filters);
  const totalAttempts = job.total_attempts ?? 0;
  // The banner may only claim retention pruning it can prove: a filtered
  // view's loaded < total is explained by the filter alone unless the job
  // itself reports rows_pruned (resultsExhaustedShort owns that gate).
  const shortOfTotal = resultsExhaustedShort(
    exhausted,
    rows.length,
    job.total_attempts,
    filtered,
    job.rows_pruned === true,
  );

  const columns = useMemo(() => probeResultColumns({ depth: true }), []);

  if (unsupported) {
    return (
      <div className="card">
        <div className="card-head">
          <h2>Attempt results</h2>
        </div>
        <Notice kind="info">
          This engine has no per-job attempt results endpoint — it needs a
          newer engine build. The sweep's progress and the proved-path /
          failed-item summaries above are unaffected.
        </Notice>
        {/* The latch must be recoverable without a remount: an engine
            upgraded while the page is open answers the next probe, and the
            fold's success branch clears "old" and re-enables pool mode. */}
        <div className="toolbar">
          <button
            type="button"
            className="ghost"
            onClick={page.reload}
            disabled={page.loading}
          >
            {page.loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    );
  }

  if (goneNotice !== null) {
    // The job left the engine's history: stop following it here (the parent's
    // poll already stopped on this terminal job). Dismissable like the
    // parent's notice; no capability verdict was latched, so pool mode stays
    // available for the next job this engine serves.
    return (
      <div className="card">
        <div className="card-head">
          <h2>Attempt results</h2>
        </div>
        <Notice onDismiss={() => setGoneNotice(null)}>{goneNotice}</Notice>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Attempt results</h2>
        <div className="spacer" />
        <span className="pill">
          {rows.length} loaded
        </span>
        <button type="button" className="ghost" onClick={refresh} disabled={page.loading}>
          {page.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="hint">
        Every attempt this job issued — success and failure alike — newest
        first, in the same model as the probe history. Filters narrow on the
        engine; Load more walks older rows.
        {touched && running
          ? " Auto-refresh is paused while you page or filter — press Refresh to re-read the newest rows."
          : ""}
      </p>

      <div className="filter-bar">
        <SelectField
          id="fp-res-outcome"
          label="Outcome"
          value={filters.outcome}
          emptyOption="All outcomes"
          options={[
            { value: "success", label: "Success" },
            { value: "failed", label: "Failed" },
          ]}
          onChange={(outcome) => patchFilters({ outcome })}
        />
        <SelectField
          id="fp-res-depth"
          label="Depth"
          value={filters.depth === 0 ? "" : String(filters.depth)}
          emptyOption="All depths"
          options={depthChoices.map((d) => ({ value: String(d), label: `depth ${d}` }))}
          onChange={(v) => patchFilters({ depth: v === "" ? 0 : Number(v) })}
        />
        <SelectField
          id="fp-res-reason"
          label="Reason"
          value={filters.reason}
          emptyOption="All reasons"
          options={reasonChoices}
          onChange={(reason) => patchFilters({ reason })}
        />
        <div className="field">
          <label htmlFor="fp-res-hop">Hop</label>
          <input
            id="fp-res-hop"
            type="text"
            className="mono"
            list="fp-res-hop-choices"
            value={filters.hop}
            placeholder="any position"
            onChange={(e) => patchFilters({ hop: e.target.value })}
          />
          <datalist id="fp-res-hop-choices">
            {hopChoices.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
          <div className="field-hint">An outbound at any position of the route.</div>
        </div>
        <SelectField
          id="fp-res-lasthop"
          label="Last hop"
          value={filters.lastHop}
          emptyOption="Any last hop"
          options={hopChoices}
          onChange={(lastHop) => patchFilters({ lastHop })}
        />
        <TextField
          id="fp-res-route"
          label="Route"
          mono
          value={filters.route}
          onChange={(route) => patchFilters({ route })}
          placeholder="a>b"
          hint="Exact hop-join, as the Route column shows it."
        />
        <SelectField
          id="fp-res-pagesize"
          label="Page size"
          value={String(pageSize)}
          options={RESULTS_PAGE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(v) => {
            setTouched(true);
            setPageSize(Number(v));
          }}
        />
      </div>

      {job.rows_pruned === true && (
        <Notice kind="info">
          This job's attempt rows were pruned by the engine's retention
          budget — some attempts are no longer stored. {RESULTS_RETENTION_NOTE}
        </Notice>
      )}
      {shortOfTotal && (
        <Notice kind="info">
          {filtered
            ? // Reachable only when rows_pruned is true (the gate suppresses
              // a purely-filtered shortfall): the pruning is the job's own
              // report, and the filters explain the rest of the difference.
              `Showing ${rows.length} loaded attempt${rows.length === 1 ? "" : "s"} matching the filters; the job ran ${totalAttempts} and its rows were pruned. Clear the filters to see the stored rows.`
            : `Showing ${rows.length} loaded of ${totalAttempts} attempts. ${RESULTS_RETENTION_NOTE}`}
        </Notice>
      )}

      <DataTable
        caption="Full-probe attempt results"
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id ?? `${p.startedAt ?? ""}-${p.route ?? ""}`}
        loading={page.loading && loaded === null}
        error={page.error}
        onRetry={page.reload}
        empty={
          <EmptyState
            title={filtered ? "No attempts match these filters" : "No attempt rows stored"}
            hint={
              filtered
                ? "The job may not have issued an attempt with this outcome, depth, reason or route — or retention pruned it."
                : "The job issued no attempts, or its rows were pruned from retention."
            }
            action={
              filtered ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setTouched(true);
                    setFilters(INITIAL_RESULTS_FILTERS);
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        }
        foot={
          rows.length > 0 ? (
            <div className="table-foot">
              <span>
                Showing {rows.length} loaded
                {exhausted ? " — end of the stored rows" : ""}
              </span>
              <div className="spacer" />
              {!exhausted && nextCursor(rows) !== "" && (
                <button
                  type="button"
                  className="ghost"
                  onClick={loadMore}
                  disabled={page.loading}
                >
                  Load more
                </button>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
