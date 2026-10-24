// src/pages/ExitChecksPage.tsx — exit-IP checks: per-outbound latest exit IP,
// check history (per site + time — the exit varies by both), the engine's
// scheduler config (cron / interval / sites / load spreading), and an
// on-demand "Check now" trigger.
//
// A proxy's connect address is NOT its exit address, and the exit can vary
// by target site and over time — so this page shows the (outbound, site,
// exit IP, time) tuples the engine records rather than a single "the" IP.

import { useEffect, useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { Notice, useToast } from "../components/Notice";
import { CheckField, NumberField, SelectField, TextField } from "../components/fields";
import { StringList } from "../components/StringList";
import { formatDuration, formatTime } from "../format";
import type { Engine, ExitCheck } from "@goose-network/goose-sdk";

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

const ROW_OPTIONS = [100, 500, 1000, 5000];
const PAGE = 50;

export function ExitChecksPage() {
  return (
    <>
      <PageHeader
        title="Exit IP"
        sub="The public IP observed at each outbound's exit — checked through the proxy itself, recorded over time, on a cron schedule."
      />
      <ExitChecksCard />
    </>
  );
}

function ExitChecksCard() {
  const { goose } = useSdk();
  const { toast } = useToast();
  const [rows, setRows] = useState<number>(200);
  const [outboundFilter, setOutboundFilter] = useState<string>("");

  const checks = useAsync(() => goose.listExitChecks({ n: rows }), [goose, rows]);
  const engine = useAsync(() => goose.getEngine(), [goose]);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const items = checks.data ?? [];
  const outbounds = useMemo(() => outboundIDs(items), [items]);
  const latestByOutbound = useMemo(() => latestPerOutbound(items), [items]);

  const runNow = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await goose.runExitChecks();
      toast("Exit checks started — results arrive in a few seconds");
      // Results land in the background; poll shortly after.
      setTimeout(() => checks.reload(), 1500);
      setTimeout(() => checks.reload(), 4000);
    } catch (err) {
      setRunError(errMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const filtered =
    outboundFilter === ""
      ? items
      : items.filter((c) => c.outboundID === outboundFilter);

  return (
    <>
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
        <button
          type="button"
          className="primary"
          onClick={() => void runNow()}
          disabled={running}
        >
          {running ? "Starting…" : "Check now"}
        </button>
      </div>

      {runError !== null && (
        <Notice onDismiss={() => setRunError(null)}>{runError}</Notice>
      )}

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

      <ExitCheckConfigCard engine={engine} />
    </>
  );
}

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

  const columns: Array<Column<ExitCheck>> = [
    { key: "when", header: "Time", className: "nowrap", render: (c) => formatTime(c.startedAt ?? "") },
    { key: "ob", header: "Outbound", className: "mono", render: (c) => c.outboundID || "—" },
    { key: "site", header: "Site", className: "mono", render: (c) => c.site || "—" },
    {
      key: "ip",
      header: "Exit IP",
      className: "mono",
      render: (c) => (c.success === true ? c.exitIP || "—" : "—"),
    },
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

  return (
    <div className="card">
      <h2>History</h2>
      <DataTable
        caption="Exit-IP check history"
        columns={columns}
        rows={visible}
        rowKey={(c) => `${c.id ?? ""}-${c.startedAt ?? ""}-${c.outboundID ?? ""}`}
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={
          total === 0 ? (
            <EmptyState
              title="No exit-IP checks recorded yet"
              hint="Press “Check now” to probe every outbound, or enable the schedule below."
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

// ExitCheckConfigCard edits engine.exit_checks (the scheduler). Saving
// round-trips through the engine resource; the API validates the cron
// expression (400 on garbage).
function ExitCheckConfigCard({
  engine,
}: {
  engine: ReturnType<typeof useAsync<Engine>>;
}) {
  const { goose } = useSdk();
  const { toast } = useToast();
  type ExitCheckCfg = NonNullable<Engine["exit_checks"]>;
  const [draft, setDraft] = useState<ExitCheckCfg | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (engine.data !== undefined && draft === null) {
      setDraft({ ...(engine.data.exit_checks ?? {}) });
    }
  }, [engine.data, draft]);

  if (engine.error !== null)
    return <Notice>Failed to load engine config: {engine.error}</Notice>;
  if (draft === null) return null;

  const set = (patch: Partial<ExitCheckCfg>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    if (engine.data === undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      await goose.setEngine({ ...engine.data, exit_checks: draft });
      toast("Exit-check schedule saved");
      setDraft(null);
      engine.reload();
    } catch (err) {
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h2>Scheduled checks</h2>
      <p className="hint">
        The engine dials each outbound and asks a check site for the exit IP.
        Batches rotate round-robin across the site list so large tests spread
        load instead of hammering (or DDoSing) a single site.
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
          hint="5-field; overrides the interval when set."
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
          value={draft.interval_seconds ?? 0}
          onChange={(interval_seconds) => set({ interval_seconds })}
        />
        <NumberField
          id="exit-timeout"
          label="Per-check timeout (s)"
          min={1}
          placeholder="10"
          value={draft.timeout_seconds ?? 0}
          onChange={(timeout_seconds) => set({ timeout_seconds })}
        />
        <NumberField
          id="exit-concurrency"
          label="Concurrency"
          min={1}
          placeholder="4"
          value={draft.concurrency ?? 0}
          onChange={(concurrency) => set({ concurrency })}
        />
      </div>
      <StringList
        id="exit-sites"
        label="Check sites"
        hint="Plain-text IP echoers; empty uses the built-in defaults."
        values={draft.sites ?? []}
        placeholder="https://ifconfig.me"
        onChange={(sites) => set({ sites })}
      />
      {saveError !== null && (
        <Notice onDismiss={() => setSaveError(null)}>{saveError}</Notice>
      )}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          onClick={() => setDraft({ ...(engine.data?.exit_checks ?? {}) })}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
