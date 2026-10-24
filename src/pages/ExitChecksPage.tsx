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

export function ExitChecksPage() {
  return (
    <>
      <h1 className="page-title">Exit IP</h1>
      <p className="page-sub">
        The public IP observed at each outbound's exit — checked through the
        proxy itself, recorded over time, on a cron schedule.
      </p>
      <ExitChecksCard />
    </>
  );
}

function ExitChecksCard() {
  const { goose } = useSdk();
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
      <div className="metrics-filters">
        <div className="field">
          <label htmlFor="exit-outbound">Outbound</label>
          <select
            id="exit-outbound"
            value={outboundFilter}
            onChange={(e) => setOutboundFilter(e.target.value)}
          >
            <option value="">All</option>
            {outbounds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="exit-rows">Rows fetched</label>
          <select
            id="exit-rows"
            value={rows}
            onChange={(e) => setRows(Number(e.target.value))}
          >
            {[100, 500, 1000, 5000].map((r) => (
              <option key={r} value={r}>
                last {r}
              </option>
            ))}
          </select>
        </div>
        <div className="spacer" />
        <button onClick={runNow} disabled={running}>
          {running ? "Starting…" : "Check now"}
        </button>
        <button onClick={checks.reload} disabled={checks.loading}>
          {checks.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {runError !== null && <div className="error-box">{runError}</div>}
      {checks.error !== null && (
        <div className="error-box">Failed to load exit checks: {checks.error}</div>
      )}

      <LatestExits latest={latestByOutbound} />

      <ExitHistory checks={filtered} loading={checks.loading} />

      <ExitCheckConfigCard engine={engine} />
    </>
  );
}

// LatestExits summarizes the most recent exit IP per outbound.
function LatestExits({
  latest,
}: {
  latest: Map<string, ExitCheck>;
}) {
  const rows = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return null;
  return (
    <div className="card">
      <h2>Latest exit IP per outbound</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Outbound</th>
            <th>Exit IP</th>
            <th>Site</th>
            <th>Checked</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, c]) => (
            <tr key={id}>
              <td>{id}</td>
              <td className={c.success === true ? "ok" : "bad"}>
                {c.success === true ? c.exitIP : `failed: ${c.error ?? "error"}`}
              </td>
              <td>{c.site ?? ""}</td>
              <td>{formatTime(c.startedAt ?? "")}</td>
              <td>{formatDuration(c.latency ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ExitHistory is the full per-check record list.
function ExitHistory({
  checks,
  loading,
}: {
  checks: ExitCheck[];
  loading: boolean;
}) {
  return (
    <div className="card" style={loading ? { opacity: 0.5 } : undefined}>
      <h2>History</h2>
      {checks.length === 0 ? (
        <div className="empty">
          No exit-IP checks recorded yet. Enable scheduled checks below or
          press “Check now”.
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Outbound</th>
              <th>Site</th>
              <th>Exit IP</th>
              <th>Result</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c, i) => (
              <tr key={c.id ?? i}>
                <td>{formatTime(c.startedAt ?? "")}</td>
                <td>{c.outboundID ?? ""}</td>
                <td>{c.site ?? ""}</td>
                <td className={c.success === true ? "ok" : "bad"}>
                  {c.success === true ? c.exitIP : "—"}
                </td>
                <td className={c.success === true ? "ok" : "bad"}>
                  {c.success === true ? "ok" : c.error ?? "failed"}
                </td>
                <td>{formatDuration(c.latency ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
  type ExitCheckCfg = NonNullable<Engine["exit_checks"]>;
  const [draft, setDraft] = useState<ExitCheckCfg | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (engine.data !== undefined && draft === null) {
      setDraft({ ...(engine.data.exit_checks ?? {}) });
    }
  }, [engine.data, draft]);

  if (engine.error !== null)
    return (
      <div className="error-box">Failed to load engine config: {engine.error}</div>
    );
  if (draft === null) return null;

  const set = (patch: Partial<NonNullable<Engine["exit_checks"]>>) =>
    setDraft({ ...draft, ...patch });

  const save = async () => {
    if (engine.data === undefined) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await goose.setEngine({ ...engine.data, exit_checks: draft });
      setSaved(true);
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
        Batches rotate round-robin across the site list so large tests
        spread load instead of hammering (or DDoSing) a single site.
      </p>
      <div className="row">
        <div className="field">
          <label htmlFor="exit-enabled">Enabled</label>
          <input
            id="exit-enabled"
            type="checkbox"
            checked={draft.enabled === true}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
        </div>
        <div className="field">
          <label htmlFor="exit-cron">Cron (5-field, overrides interval)</label>
          <input
            id="exit-cron"
            type="text"
            placeholder="*/15 * * * *"
            value={draft.cron ?? ""}
            onChange={(e) => set({ cron: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="exit-interval">Interval (seconds)</label>
          <input
            id="exit-interval"
            type="number"
            min={60}
            value={draft.interval_seconds ?? 0}
            onChange={(e) => set({ interval_seconds: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="exit-timeout">Per-check timeout (s)</label>
          <input
            id="exit-timeout"
            type="number"
            min={1}
            value={draft.timeout_seconds ?? 0}
            onChange={(e) => set({ timeout_seconds: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="exit-concurrency">Concurrency</label>
          <input
            id="exit-concurrency"
            type="number"
            min={1}
            value={draft.concurrency ?? 0}
            onChange={(e) => set({ concurrency: Number(e.target.value) })}
          />
        </div>
      </div>
      <StringList
        id="exit-sites"
        label="Check sites (plain-text IP echoers; empty = built-in defaults)"
        values={draft.sites ?? []}
        placeholder="https://ifconfig.me"
        onChange={(sites) => set({ sites })}
      />
      {saveError !== null && <div className="error-box">{saveError}</div>}
      {saved && <div className="hint">Saved.</div>}
      <button className="primary" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save schedule"}
      </button>
    </div>
  );
}
