// src/pages/ExitChecksPage.tsx — exit-IP checks: a one-off check of any site
// through any outbound, the recorded history, the shared check-site list, and
// the optional schedule.
//
// A proxy's connect address is NOT its exit address, and the exit can vary
// by target site and over time — so this page shows the (outbound, site,
// exit IP, time) tuples the engine records rather than a single "the" IP.
//
// The single run is deliberately independent of the schedule: the engine keeps
// its configured sites, timeout and concurrency even while the scheduler is
// off, so "check this site through this outbound, once" needs nothing turned
// on and writes nothing but the check's own records.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync, useSeededDraft, type AsyncState } from "../useAsync";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { Notice, useToast } from "../components/Notice";
import {
  CheckField,
  FieldGroup,
  NumberField,
  SelectField,
  TextField,
} from "../components/fields";
import { StringList } from "../components/StringList";
import { formatDuration, formatTime } from "../format";
import {
  buildExitRunSpec,
  CHECK_SITE_PRESETS,
  effectiveNumber,
  ENGINE_DEFAULT_CONCURRENCY,
  ENGINE_DEFAULT_SITES,
  ENGINE_DEFAULT_TIMEOUT_SEC,
  firstBadSite,
} from "./checkSites";
import { runExitChecksNow, stillRunning } from "../runApi";
import { cleanList } from "../validate";
import type { Engine, ExitCheck, ExitCheckConfig } from "@goose-network/goose-sdk";

// outboundIDs returns the distinct outbound ids in a check list, sorted.
export function outboundIDs(checks: ExitCheck[]): string[] {
  const s = new Set<string>();
  for (const c of checks) if (c.outboundID !== undefined) s.add(c.outboundID);
  return [...s].sort();
}

// latestPerOutbound maps each outbound to its newest check (checks arrive
// newest-first; a failed latest is honest signal, not something to hide).
export function latestPerOutbound(checks: ExitCheck[]): Map<string, ExitCheck> {
  const latest = new Map<string, ExitCheck>();
  for (const c of checks) {
    const id = c.outboundID ?? "";
    if (id !== "" && !latest.has(id)) latest.set(id, c);
  }
  return latest;
}

/**
 * rowsSince picks a detached round's rows out of the history: everything newer
 * than the row that was newest when the run started. Identity beats timestamps
 * here — the engine's clock is not the browser's, and a skewed host would make
 * a startedAt comparison find nothing or everything. The fallback covers a run
 * started before the history loaded, where there is no baseline to compare to;
 * it is the one path that has to trust a clock, so it allows a little skew.
 *
 * A baseline that is not in the window means the round has written nothing yet
 * (or the window moved past it), which reads as "keep looking".
 */
export function rowsSince(
  rows: ExitCheck[],
  baselineId: string | undefined,
  startedAtMs: number,
): ExitCheck[] {
  if (baselineId !== undefined) {
    const at = rows.findIndex((c) => c.id === baselineId);
    return at === -1 ? [] : rows.slice(0, at);
  }
  return rows.filter((c) => Date.parse(c.startedAt ?? "") >= startedAtMs - 5_000);
}

/** History depths on offer. The default has to be one of them: a select whose
 *  value matches no option renders blank, which reads as "no depth chosen". */
const ROW_OPTIONS = [100, 200, 500, 1000, 5000];
const ROWS_DEFAULT = 200;
const PAGE = 50;

export function ExitChecksPage() {
  return (
    <>
      <PageHeader
        title="Exit IP"
        sub="The public IP observed at each outbound's exit, checked through the proxy itself. Run one check now — no schedule needed — or put it on a cron."
      />
      <ExitChecksCard />
    </>
  );
}

function ExitChecksCard() {
  const { goose } = useSdk();
  const [rows, setRows] = useState<number>(ROWS_DEFAULT);
  const [outboundFilter, setOutboundFilter] = useState<string>("");
  // A run writes the same rows the history lists, so finishing one refreshes
  // the other.
  const [ranAt, setRanAt] = useState(0);
  const onRan = useCallback(() => setRanAt((n) => n + 1), []);
  // Bumped when the run card saves its site list as the defaults, so the Check
  // sites card re-seeds from what was stored instead of showing a list that is
  // now stale — and would overwrite it if the reader pressed Save there.
  const [sitesVersion, setSitesVersion] = useState(0);
  const onSavedSites = useCallback(() => setSitesVersion((n) => n + 1), []);

  const checks = useAsync(
    () => goose.listExitChecks({ n: rows }),
    [goose, rows, ranAt],
  );
  const engine = useAsync(() => goose.getEngine(), [goose]);

  const items = checks.data ?? [];
  const outbounds = useMemo(() => outboundIDs(items), [items]);
  const latestByOutbound = useMemo(() => latestPerOutbound(items), [items]);

  const filtered =
    outboundFilter === ""
      ? items
      : items.filter((c) => c.outboundID === outboundFilter);

  return (
    <>
      <SingleRunCard
        engine={engine}
        onRan={onRan}
        onSavedSites={onSavedSites}
        newestId={items[0]?.id}
      />

      <div className="filter-bar">
        <SelectField
          id="exit-outbound"
          label="Outbound"
          value={outboundFilter}
          emptyOption="All outbounds"
          options={outbounds}
          onChange={setOutboundFilter}
        />
        <SelectField
          id="exit-rows"
          label="History depth"
          value={String(rows)}
          options={ROW_OPTIONS.map((r) => ({ value: String(r), label: `last ${r}` }))}
          onChange={(v) => setRows(Number(v))}
        />
        <div className="spacer" />
        <button type="button" onClick={checks.reload} disabled={checks.loading}>
          {checks.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <LatestExits latest={latestByOutbound} loading={checks.loading} />

      <ExitHistory
        checks={filtered}
        total={items.length}
        loading={checks.loading}
        error={checks.error}
        onRetry={checks.reload}
        filteredBy={outboundFilter}
        onResetFilter={() => setOutboundFilter("")}
      />

      <CheckSitesCard engine={engine} refreshKey={sitesVersion} />
      <ScheduleCard engine={engine} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Single run
// ---------------------------------------------------------------------------

/**
 * useExitCheckConfig saves a patch of engine.exit_checks, merged into what the
 * engine holds *now* — fetched at save time, not read from a possibly stale
 * load. The merge is the point: the site list and the schedule are edited by
 * separate cards, and a whole-object PUT from either would silently drop the
 * other's fields.
 *
 * It does not make two saves at once safe. The engine's config is one resource
 * with no per-field endpoint, so a second PUT still carries the base it read
 * before the first landed; the window is one round trip, and each card has a
 * single save button.
 */
function useExitCheckConfig(engine: AsyncState<Engine>) {
  const { goose } = useSdk();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (
    patch: Partial<ExitCheckConfig>,
    message: string,
  ): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const current = await goose.getEngine();
      await goose.setEngine({
        ...current,
        exit_checks: { ...(current.exit_checks ?? {}), ...patch },
      });
      toast(message);
      engine.reload();
      return true;
    } catch (err) {
      setError(errMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { save, saving, error, dismiss: () => setError(null) };
}

/** How often, and for how long, to look for a detached round's rows after the
 *  engine answers 202. The engine itself waited 25s; a round that outlives that
 *  is usually stuck on one slow site, so a further half minute catches it
 *  without hammering the API. */
const POLL_EVERY_MS = 3_000;
const POLL_TRIES = 10;

/** Notice text while a detached round is in flight. The engine's own message
 *  ("… results appear in GET /api/exit-checks") is written for an API reader,
 *  so the page says the same thing in its own words. */
const STILL_RUNNING =
  "The round is still running — the engine stopped waiting for it after 25s. This card keeps looking for its rows, and the history below refreshes as they are recorded.";

const GAVE_UP_POLLING =
  "The round recorded nothing in the half minute after the engine handed it back. It may still be waiting on a slow site — press Refresh to look again.";

/** The one-off task: pick sites and outbounds, check them now, read the answer
 *  here. Nothing about it requires the schedule to be enabled. */
function SingleRunCard({
  engine,
  onRan,
  onSavedSites,
  newestId,
}: {
  engine: AsyncState<Engine>;
  onRan: () => void;
  /** the run card just saved the shared site list; the card below must re-seed */
  onSavedSites: () => void;
  /** newest history row when the run started — see rowsSince */
  newestId: string | undefined;
}) {
  const { goose } = useSdk();
  const { toast } = useToast();
  const cfg = useExitCheckConfig(engine);
  const outbounds = useAsync(() => goose.listOutbounds(), [goose]);

  const saved = engine.data?.exit_checks?.sites ?? [];
  const [sites, setSites] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [only, setOnly] = useState<string[]>([]);
  const [timeoutSec, setTimeoutSec] = useState(0);
  const [concurrency, setConcurrency] = useState(0);
  const [results, setResults] = useState<ExitCheck[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Until the reader edits it, the list mirrors the saved one: the first load
  // seeds it, and a save made in the Check sites card below moves it too — so
  // the field never disagrees with the list it would run. An edited list is the
  // reader's own: a load landing mid-edit must not eat it, and `touched` is
  // what tells the two apart. Seeding keys on the engine object itself, not on
  // `touched` flipping: a save turns `touched` back off while its reload is
  // still in flight, and re-seeding from that stale object would revert the
  // list the reader just saved.
  const seededFrom = useRef<Engine | undefined>(undefined);
  useEffect(() => {
    if (engine.data === undefined) return;
    const fresh = seededFrom.current !== engine.data;
    seededFrom.current = engine.data;
    if (fresh && !touched) setSites(engine.data.exit_checks?.sites ?? []);
  }, [engine.data, touched]);

  // Polling timers for a detached round. `alive` and `runSeq` fence the chain:
  // a timer that already fired can resume from an in-flight fetch after the
  // card unmounted or a newer run started, and must neither re-arm nor write
  // into the state that newer run now owns. The setup re-arms `alive` because
  // StrictMode and HMR run the cleanup on a simulated unmount and keep the
  // refs — a cleanup-only effect would leave the card dead for the session.
  const timers = useRef<number[]>([]);
  const alive = useRef(true);
  const runSeq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    };
  }, []);
  const after = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const ids = useMemo(
    () =>
      (outbounds.data ?? [])
        .map((o) => o.id)
        .filter((id): id is string => id !== undefined && id !== "")
        .sort(),
    [outbounds.data],
  );
  const badSite = useMemo(() => firstBadSite(sites), [sites]);
  // "Save as the defaults" only lights up once the reader has edited *this*
  // list. `saved` moves whenever the Check sites card saves, and comparing
  // against it alone would offer to undo that save with this card's older copy.
  const dirty = touched && sites.join("\n") !== saved.join("\n");

  /** Every edit marks the list as the reader's own, which is what lets the save
   *  button tell "edited here" from "changed by the card below". */
  const editSites = (next: string[] | ((v: string[]) => string[])) => {
    setTouched(true);
    setSites(next);
  };

  /** The completed-round path, shared by an inline answer and a polled one. */
  const show = (checks: ExitCheck[]) => {
    setResults(checks);
    setPending(null);
    const ok = checks.filter((c) => c.success === true).length;
    toast(
      `${checks.length} exit check${checks.length === 1 ? "" : "s"}: ${ok} answered`,
      checks.length > 0 && ok === checks.length ? "good" : "bad",
    );
  };

  /** A chain is retired once the card unmounts or a newer run starts: from
   *  there on it must neither re-arm a timer nor write into the state the
   *  newer run (or the next page) owns. */
  const retired = (myRun: number) =>
    !alive.current || myRun !== runSeq.current;

  /** Look for a detached round's rows, refreshing the history each time so the
   *  table below stays live whether or not this card finds them. `myRun` is the
   *  fence: any newer run (or an unmount) retires this chain wherever it is. */
  const poll = (
    myRun: number,
    baseline: string | undefined,
    startedAt: number,
    attempt: number,
  ) => {
    after(POLL_EVERY_MS, () => {
      if (retired(myRun)) return;
      onRan();
      void (async () => {
        try {
          const rows = await goose.listExitChecks({ n: ROWS_DEFAULT });
          if (retired(myRun)) return;
          const mine = rowsSince(rows, baseline, startedAt);
          if (mine.length > 0) {
            show(mine);
            return;
          }
        } catch {
          // The history below surfaces its own load error; keep looking.
        }
        if (retired(myRun)) return;
        if (attempt + 1 < POLL_TRIES) poll(myRun, baseline, startedAt, attempt + 1);
        else setPending(GAVE_UP_POLLING);
      })();
    });
  };

  const run = async () => {
    if (badSite !== undefined) return;
    // Retire any chain still looking for an earlier detached round, or its next
    // tick would read this run's rows as that round's and overwrite the table.
    runSeq.current += 1;
    const myRun = runSeq.current;
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    // Captured before the request: the history this card is handed moves while
    // a round is in flight, and rowsSince needs the pre-run newest row.
    const baseline = newestId;
    const startedAt = Date.now();
    setRunning(true);
    setError(null);
    setResults(null);
    setPending(null);
    try {
      const res = await runExitChecksNow(
        goose,
        buildExitRunSpec({ sites, outbounds: only, timeoutSec, concurrency }),
      );
      // The entry hop needs the same fence as the chain: the engine can hold
      // this request for 25s, and the reader may navigate away mid-flight —
      // an answer landing after the unmount would toast on an unrelated page
      // and arm a timer the cleanup already detached.
      if (retired(myRun)) return;
      if (stillRunning(res)) {
        setPending(STILL_RUNNING);
        toast("Exit checks still running — results will appear below");
        poll(myRun, baseline, startedAt, 0);
      } else {
        show(res.checks ?? []);
        onRan();
      }
    } catch (err) {
      if (retired(myRun)) return;
      setError(errMessage(err));
    } finally {
      if (!retired(myRun)) setRunning(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Run a check now</h2>
        <div className="spacer" />
        <span className="pill">
          {sites.length === 0 ? "engine's sites" : `${sites.length} site${sites.length === 1 ? "" : "s"}`}
        </span>
        <span className="pill">
          {only.length === 0
            ? "every outbound"
            : `${only.length} outbound${only.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          className="primary"
          onClick={() => void run()}
          disabled={running || badSite !== undefined}
          title={
            badSite !== undefined
              ? "Fix the check site first — the engine needs an absolute http(s) URL"
              : undefined
          }
        >
          {running ? "Checking…" : "Check now"}
        </button>
      </div>
      <p className="hint">
        Dials each chosen outbound and asks a check site what IP it sees, once, right now. This
        works with the schedule turned off and changes no configuration. Outbounds with no server
        address (direct, tunnel) have no exit of their own and are skipped.
      </p>

      <StringList
        id="run-sites"
        label="Check sites for this run"
        mono
        values={sites}
        placeholder="https://ifconfig.me"
        addLabel="Add site"
        hint="Empty uses the saved list below, or the engine's built-in defaults when that is empty too. Each outbound is checked against one site, rotating round-robin."
        onChange={editSites}
      />
      <SitePresets
        sites={sites}
        onAdd={(url) => editSites((v) => (v.includes(url) ? v : [...v, url]))}
      />
      {badSite !== undefined && (
        // The engine rejects a site with no scheme, and this page shows sites
        // without theirs everywhere else, so the mistake is easy to make and
        // its failure ("bad site URL") lands a long way from the field.
        <Notice>
          "{badSite}" is not an absolute http(s) URL. A check site needs its
          scheme — https://{badSite.replace(/^https?:\/\//, "")} — or every
          check against it fails.
        </Notice>
      )}

      <div className="row">
        <NumberField
          id="run-timeout"
          label="Per-check timeout (s)"
          min={1}
          // The config resource has no omitempty, so an engine nobody configured
          // reports 0 here; show what it will actually use instead.
          placeholder={effectiveNumber(
            engine.data?.exit_checks?.timeout_seconds,
            ENGINE_DEFAULT_TIMEOUT_SEC,
          )}
          hint="Empty uses the configured timeout — the placeholder is what the engine will use."
          value={timeoutSec}
          onChange={setTimeoutSec}
        />
        <NumberField
          id="run-concurrency"
          label="Concurrency"
          min={1}
          placeholder={effectiveNumber(
            engine.data?.exit_checks?.concurrency,
            ENGINE_DEFAULT_CONCURRENCY,
          )}
          hint="How many outbounds are checked at once."
          value={concurrency}
          onChange={setConcurrency}
        />
      </div>

      <FieldGroup
        id="run-outbounds"
        label="Outbounds"
        hint="Nothing selected checks every outbound that has a server address."
      >
        <div className="chip-grid">
          <label className={`chip${only.length === 0 ? " on" : ""}`}>
            <input
              type="checkbox"
              checked={only.length === 0}
              onChange={() => setOnly([])}
            />
            every outbound
          </label>
          {ids.map((id) => (
            <label key={id} className={`chip${only.includes(id) ? " on" : ""}`}>
              <input
                type="checkbox"
                checked={only.includes(id)}
                onChange={() =>
                  setOnly((v) =>
                    v.includes(id) ? v.filter((x) => x !== id) : [...v, id],
                  )
                }
              />
              <span className="mono">{id}</span>
            </label>
          ))}
        </div>
        {ids.length === 0 && !outbounds.loading && outbounds.error === null && (
          <div className="field-hint">
            No outbounds are configured yet — add one on the Outbounds page first.
          </div>
        )}
      </FieldGroup>

      {error !== null && <Notice onDismiss={() => setError(null)}>{error}</Notice>}
      {cfg.error !== null && (
        <Notice onDismiss={cfg.dismiss}>{cfg.error}</Notice>
      )}
      {outbounds.error !== null && (
        // Without the list the picker shows only "every outbound", so the
        // reader cannot tell an empty config from a failed request.
        <Notice>Could not list outbounds: {outbounds.error}</Notice>
      )}
      {pending !== null && <Notice kind="info">{pending}</Notice>}

      {results !== null && <RunResults checks={results} />}

      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button
          type="button"
          onClick={() =>
            void cfg
              // cleanList, not a bare filter: the engine stores these strings
              // verbatim and rejects one it cannot parse, so a trailing space
              // would be saved into every later round, and a duplicate would
              // double one host's load per round.
              .save({ sites: cleanList(sites) }, "Check sites saved")
              .then((ok) => {
                if (!ok) return;
                setTouched(false);
                onSavedSites();
              })
          }
          disabled={cfg.saving || !dirty || badSite !== undefined}
          title={
            badSite !== undefined
              ? "Fix the check site first — the engine needs an absolute http(s) URL"
              : dirty
                ? "Save this run's site list as the list every run and schedule uses"
                : "Same as the saved list"
          }
        >
          {cfg.saving ? "Saving…" : "Save these sites as the defaults"}
        </button>
      </div>
    </div>
  );
}

/** The curated site list, one click per site. A site already in the list shows
 *  selected rather than being offered twice. */
function SitePresets({
  sites,
  onAdd,
}: {
  sites: string[];
  onAdd: (url: string) => void;
}) {
  return (
    <>
      {CHECK_SITE_PRESETS.map((group) => {
        const id = `site-presets-${group.group.toLowerCase().replace(/\W+/g, "-")}`;
        return (
          <FieldGroup id={id} label={group.group} key={id}>
            <div className="chip-grid">
              {group.sites.map((s) => (
                <button
                  type="button"
                  className={`chip${sites.includes(s.url) ? " on" : ""}`}
                  key={s.url}
                  title={`${s.url} — ${s.note}`}
                  onClick={() => onAdd(s.url)}
                >
                  {s.url.replace(/^https?:\/\//, "")}
                </button>
              ))}
            </div>
          </FieldGroup>
        );
      })}
    </>
  );
}

/** A check record's columns, without the time: a run's table ends with when
 *  it was checked, the history leads with it. */
const checkColumns: Array<Column<ExitCheck>> = [
  { key: "ob", header: "Outbound", className: "mono", render: (c) => c.outboundID || "—" },
  {
    key: "ip",
    header: "Exit IP",
    className: "mono",
    render: (c) => (c.success === true ? c.exitIP || "—" : "—"),
  },
  { key: "site", header: "Site", className: "mono", render: (c) => c.site || "—" },
  {
    key: "result",
    header: "Result",
    render: (c) =>
      c.success === true ? (
        <span className="pill ok">ok</span>
      ) : (
        <span className="pill fail" title={c.error ?? ""}>
          {c.error || "failed"}
        </span>
      ),
  },
  {
    key: "latency",
    header: "Latency",
    className: "num",
    render: (c) => (c.success === true ? formatDuration(c.latency ?? 0) : "—"),
  },
];

const timeColumn: Column<ExitCheck> = {
  key: "when",
  header: "Time",
  className: "nowrap",
  render: (c) => formatTime(c.startedAt ?? ""),
};

// The history is a log, so it leads with the time; a single run's table leads
// with the outbound and puts the time last.
const historyColumns: Array<Column<ExitCheck>> = [timeColumn, ...checkColumns];

/** The records the run returned, in the card that ran it: waiting for the
 *  history to reload before showing an answer would be a slower way to say the
 *  same thing. */
function RunResults({ checks }: { checks: ExitCheck[] }) {
  // Distinct exits is the answer most readers came for: one IP means every
  // outbound left through the same door, which is usually not what a proxy
  // fleet is for.
  const ips = new Set(
    checks.filter((c) => c.success === true && c.exitIP !== "").map((c) => c.exitIP),
  );
  return (
    <>
      <h3 className="card-sub">
        This run — {checks.length} check{checks.length === 1 ? "" : "s"}, {ips.size} distinct exit
        IP{ips.size === 1 ? "" : "s"}
      </h3>
      <DataTable
        caption="Results of the run just made"
        columns={[...checkColumns, { ...timeColumn, header: "Checked" }]}
        rows={checks}
        rowKey={(c) => `${c.id ?? ""}-${c.outboundID ?? ""}-${c.site ?? ""}`}
        empty={
          <EmptyState
            title="No checks ran"
            hint="Every outbound was skipped — none has a server address to dial through."
          />
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const latestColumns: Array<Column<[string, ExitCheck]>> = [
  { key: "id", header: "Outbound", className: "mono", render: ([id]) => id },
  {
    key: "ip",
    header: "Exit IP",
    className: "mono",
    render: ([, c]) =>
      c.success === true ? (
        c.exitIP || "—"
      ) : (
        <span className="status-bad">failed: {c.error || "error"}</span>
      ),
  },
  { key: "site", header: "Site", className: "mono", render: ([, c]) => c.site || "—" },
  { key: "when", header: "Checked", className: "nowrap", render: ([, c]) => formatTime(c.startedAt ?? "") },
  {
    key: "latency",
    header: "Latency",
    className: "num",
    render: ([, c]) => (c.success === true ? formatDuration(c.latency ?? 0) : "—"),
  },
];

// LatestExits summarizes the most recent exit IP per outbound.
function LatestExits({
  latest,
  loading,
}: {
  latest: Map<string, ExitCheck>;
  loading: boolean;
}) {
  const rows = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0 && !loading) return null;
  return (
    <div className="card">
      <h2>Current exit IP per outbound</h2>
      <DataTable
        caption="Latest exit IP per outbound"
        columns={latestColumns}
        rows={rows}
        rowKey={([id]) => id}
        loading={loading}
      />
    </div>
  );
}

// ExitHistory is the full per-check record list, paged so 5000 rows don't
// turn into a 5000-row DOM.
function ExitHistory({
  checks,
  total,
  loading,
  error,
  onRetry,
  filteredBy,
  onResetFilter,
}: {
  checks: ExitCheck[];
  total: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  filteredBy: string;
  onResetFilter: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filteredBy, total]);
  const visible = checks.slice(0, limit);

  return (
    <div className="card">
      <h2>History</h2>
      <DataTable
        caption="Exit-IP check history"
        columns={historyColumns}
        rows={visible}
        rowKey={(c) => `${c.id ?? ""}-${c.startedAt ?? ""}-${c.outboundID ?? ""}`}
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={
          total === 0 ? (
            <EmptyState
              title="No exit-IP checks recorded yet"
              hint="Run a check above — no schedule needed — or turn the schedule on below."
            />
          ) : (
            <EmptyState
              title="No checks for this outbound"
              hint={`Nothing recorded for “${filteredBy}”.`}
              action={
                <button type="button" className="ghost" onClick={onResetFilter}>
                  Show all outbounds
                </button>
              }
            />
          )
        }
        foot={
          checks.length > 0 ? (
            <div className="table-foot">
              <span>
                Showing {visible.length} of {checks.length}
                {filteredBy === "" && total !== checks.length ? ` (filtered from ${total})` : ""}
              </span>
              <div className="spacer" />
              {checks.length > visible.length && (
                <button type="button" className="ghost" onClick={() => setLimit(limit + PAGE)}>
                  Load {Math.min(PAGE, checks.length - visible.length)} more
                </button>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The saved site list, editable on its own: it is the input to both a single
 *  run and the schedule, and neither needs the other. */
function CheckSitesCard({
  engine,
  refreshKey,
}: {
  engine: AsyncState<Engine>;
  /** bumped when another card saved this list; see ExitChecksCard */
  refreshKey: number;
}) {
  const cfg = useExitCheckConfig(engine);
  // refreshKey is the run card's "I just saved this list" signal. Without it
  // this draft keeps showing the previous list, and pressing Save here would
  // put that straight back over the change just made.
  const { draft: sites, setDraft: setSites, refresh } = useSeededDraft<
    Engine,
    string[]
  >(engine.data, (e) => e.exit_checks?.sites ?? [], refreshKey);

  if (sites === null) return null;

  const badSite = firstBadSite(sites);

  return (
    <div className="card">
      <h2>Check sites</h2>
      <p className="hint">
        The sites a check asks for the exit IP, used by every run and by the schedule when they do
        not name their own. Each must answer with nothing but an IP address — the engine reads at
        most 64 bytes of the response and parses it, so a JSON or HTML answer fails the check.
        Batches rotate round-robin across the list so a large test spreads its load instead of
        hammering one site.
      </p>
      <StringList
        id="exit-sites"
        label="Sites"
        mono
        values={sites}
        placeholder="https://ifconfig.me"
        addLabel="Add site"
        hint={`Empty uses the engine's built-in defaults: ${ENGINE_DEFAULT_SITES.join(", ")}.`}
        onChange={setSites}
      />
      <SitePresets
        sites={sites}
        onAdd={(url) =>
          // The state is nullable (null = "show what the engine has"), which
          // the card never renders, but the updater still has to type-check.
          setSites((v) => (v === null || v.includes(url) ? v : [...v, url]))
        }
      />
      {badSite !== undefined && (
        <Notice>
          "{badSite}" is not an absolute http(s) URL. The engine rejects a site
          without a scheme, so every check against it would fail.
        </Notice>
      )}
      {cfg.error !== null && <Notice onDismiss={cfg.dismiss}>{cfg.error}</Notice>}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void cfg
              // cleanList for the same reason as the run card's save: what goes
              // in here is what every later round dials, verbatim.
              .save({ sites: cleanList(sites) }, "Check sites saved")
              .then((ok) => {
                if (ok) refresh();
              })
          }
          disabled={cfg.saving || badSite !== undefined}
        >
          {cfg.saving ? "Saving…" : "Save sites"}
        </button>
        <button
          type="button"
          // Re-seed in place: setting the draft to null would unmount this whole
          // card for a commit, dropping focus and flashing it back.
          onClick={() => setSites(engine.data?.exit_checks?.sites ?? [])}
          disabled={cfg.saving}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

/** The schedule draft: everything in exit_checks but the sites. Sites are the
 *  Check sites card's to save, and leaving them out of this draft is what keeps
 *  a schedule save from touching them. Module scope so the seeding effect's
 *  `seed` dependency is stable across renders. */
function scheduleDraft(e: Engine): ExitCheckConfig {
  const { sites: _sites, ...rest } = e.exit_checks ?? {};
  return rest;
}

/** The schedule alone. Sites moved out to their own card: a schedule is
 *  optional, the site list is not. */
function ScheduleCard({ engine }: { engine: AsyncState<Engine> }) {
  const cfg = useExitCheckConfig(engine);
  const { draft, setDraft, refresh } = useSeededDraft<Engine, ExitCheckConfig>(
    engine.data,
    scheduleDraft,
  );

  if (engine.error !== null) {
    return <Notice>Failed to load engine config: {engine.error}</Notice>;
  }
  if (draft === null) return null;

  const set = (patch: Partial<ExitCheckConfig>) => setDraft({ ...draft, ...patch });

  return (
    <div className="card">
      <h2>Scheduled checks</h2>
      <p className="hint">
        Optional: runs the same check on a cron (or a plain interval) and records every result. The
        single run above works with this switched off, and uses the same site list.
      </p>
      <div className="row">
        <CheckField
          id="exit-enabled"
          label="Enabled"
          checked={draft.enabled === true}
          onChange={(enabled) => set({ enabled })}
        />
        <TextField
          id="exit-cron"
          label="Cron"
          hint="5-field crontab; overrides the interval when set. */5 * * * * every 5 minutes, 0 */6 * * * every 6 hours."
          mono
          placeholder="*/15 * * * *"
          value={draft.cron ?? ""}
          onChange={(cron) => set({ cron })}
        />
        <NumberField
          id="exit-interval"
          label="Interval (seconds)"
          min={60}
          placeholder="900"
          // The engine floors an interval below 10s to 10s rather than treating
          // 0 as "off", so an empty field with the schedule enabled means a
          // round every ten seconds.
          hint="Used when the cron is empty. Zero means the engine's 10s floor, which is rarely what you want."
          value={draft.interval_seconds ?? 0}
          onChange={(interval_seconds) => set({ interval_seconds })}
        />
        <NumberField
          id="exit-timeout"
          label="Per-check timeout (s)"
          min={1}
          // The engine's own defaults (config.ExitCheckConfig treats anything
          // below 1 as 15s, and a concurrency below 1 as 4), not a guess.
          placeholder={String(ENGINE_DEFAULT_TIMEOUT_SEC)}
          hint="Empty uses the engine's default."
          value={draft.timeout_seconds ?? 0}
          onChange={(timeout_seconds) => set({ timeout_seconds })}
        />
        <NumberField
          id="exit-concurrency"
          label="Concurrency"
          min={1}
          placeholder={String(ENGINE_DEFAULT_CONCURRENCY)}
          hint="Empty uses the engine's default."
          value={draft.concurrency ?? 0}
          onChange={(concurrency) => set({ concurrency })}
        />
      </div>
      {cfg.error !== null && <Notice onDismiss={cfg.dismiss}>{cfg.error}</Notice>}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void cfg.save(draft, "Exit-check schedule saved").then((ok) => {
              if (ok) refresh();
            })
          }
          disabled={cfg.saving}
        >
          {cfg.saving ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          // Re-seed in place, like the Check sites card: null would unmount the
          // card for a commit and drop focus with it.
          onClick={() => {
            if (engine.data !== undefined) setDraft(scheduleDraft(engine.data));
          }}
          disabled={cfg.saving}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
