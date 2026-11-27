// src/pages/FullProbesPage.tsx — full active probing: set a target, launch
// the multi-level sweep, watch it discover which proxy paths reach the
// target, and turn the successful paths into inbound listeners.
//
// The sweep is the engine's fan-out search: level 1 probes local → every
// outbound (successes A, failures B); level 2 probes local → a → b for every
// a ∈ A, b ∈ B — a failed outbound relayed through a working one may succeed;
// deeper levels extend the surviving paths with the new failures, up to
// depth 5. This page is the workflow's cockpit: one form to start, a live
// progress card per job, and one button that applies the proved paths
// (local→A, local→A→C, ...) as chains + inbounds the engine starts at once.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { Notice, useToast } from "../components/Notice";
import { NumberField, SelectField, TextField } from "../components/fields";
import { formatDuration, formatTime } from "../format";
import {
  applyFullProbe,
  cancelFullProbe,
  fullProbeJobGone,
  getFullProbe,
  listFullProbes,
  startFullProbe,
  type FullProbeApplyResult,
  type FullProbeJob,
} from "../fullProbeApi";
import {
  bestPaths,
  buildFullProbeRequest,
  FULL_PROBE_CAPS,
  FULL_PROBE_DEFAULTS,
  FULL_PROBE_POLL_MS,
  FULL_PROBE_TARGET_PRESETS,
  fullProbeFormProblems,
  fullProbePollDelay,
  fullProbeProgress,
  fullProbeRunning,
  INITIAL_FULL_PROBE_FIELDS,
  levelSummaries,
  pathLabel,
  statePill,
  type FullProbeFields,
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
  /** Results of the last apply, shown until the next one. */
  const [applied, setApplied] = useState<FullProbeApplyResult[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

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
    setApplying(true);
    setApplyError(null);
    try {
      const res = await applyFullProbe(g, id);
      // An apply resolving after a watch/engine switch must not attribute
      // the old job's created inbounds to the new card.
      if (activeIdRef.current !== id || engineKeyRef.current !== key) return;
      setApplied(res.results ?? []);
      toast(
        `Created ${res.results?.length ?? 0} inbound${(res.results?.length ?? 0) === 1 ? "" : "s"} from the proved paths`,
        "good",
      );
    } catch (err) {
      if (activeIdRef.current !== id || engineKeyRef.current !== key) return;
      setApplyError(errMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const set = (patch: Partial<FullProbeFields>) =>
    setForm((f) => ({ ...f, ...patch }));

  const progress = fullProbeProgress(live);
  const levels = levelSummaries(live);
  const paths = bestPaths(live);
  const pill = statePill(live);
  const finished = live !== undefined && !fullProbeRunning(live);

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

          {paths.length > 0 && (
            <>
              <h3 className="card-sub">Proved paths</h3>
              <ul>
                {paths.map((p, i) => (
                  <li key={i} className="mono">
                    {pathLabel(p)}{" "}
                    <span className="pill ok">
                      {formatDuration(p.latency)}
                      {p.status !== undefined && p.status > 0
                        ? ` · ${p.status}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {live.levels?.some((l) => (l.failed_items?.length ?? 0) > 0) && (
            <>
              <h3 className="card-sub">Failed items (retried behind the successes)</h3>
              <ul>
                {(live.levels ?? []).flatMap((l) =>
                  (l.failed_items ?? []).map((fi) => (
                    <li key={`${l.depth}-${fi.id}`} className="mono">
                      depth {l.depth}: {fi.id} ×{fi.count}
                      {fi.reason !== undefined && fi.reason !== ""
                        ? ` — ${fi.reason}`
                        : ""}
                    </li>
                  )),
                )}
              </ul>
            </>
          )}

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
                    : "Create one chain + inbound per proved depth (fastest path each)."
                }
              >
                {applying ? "Creating…" : "Create inbounds from paths"}
              </button>
            )}
          </div>

          {applied !== null && applied.length > 0 && (
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
                  {applied.map((r) => (
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
          )}
        </div>
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