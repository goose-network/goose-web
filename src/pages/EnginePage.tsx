// src/pages/EnginePage.tsx — overview: what the engine is running right now,
// what's configured, and the engine-level config editor.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { PageHeader } from "../components/PageHeader";
import { Notice } from "../components/Notice";
import { SelectField, TextField } from "../components/fields";
import { TableSkeleton } from "../components/DataTable";
import type { Engine } from "@goose-network/goose-sdk";

export function EnginePage() {
  return (
    <>
      <PageHeader
        title="Overview"
        sub="What the engine is running right now, and the configuration behind it. Changes apply live."
      />
      <EngineStatusCard />
      <ResourcesCard />
      <EngineCard />
    </>
  );
}

/** Read-only facts about the live engine, straight from GET /api/engine. */
function EngineStatusCard() {
  const { goose, connection, connectionError, connecting } = useSdk();
  const { data, error, loading } = useAsync(() => goose.getEngine(), [goose]);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Engine</h2>
        <div className="spacer" />
        <span className={`pill ${connectionError === null ? "ok" : "fail"}`}>
          {connecting
            ? "connecting…"
            : connectionError === null
              ? "connected"
              : "unreachable"}
        </span>
      </div>
      {error !== null ? (
        <Notice>
          Failed to load engine: {error}{" "}
          <span className="hint" style={{ margin: 0 }}>
            {connection.baseUrl === "" ? "same-origin" : connection.baseUrl}
          </span>
        </Notice>
      ) : data === undefined ? (
        loading ? (
          <TableSkeleton cols={4} rows={2} />
        ) : null
      ) : (
        <dl className="def-grid">
          <div>
            <dt>Network stack</dt>
            <dd>{data.stack || "default"}</dd>
          </div>
          <div>
            <dt>Admin API</dt>
            <dd className="mono">{data.api?.listen || "—"}</dd>
          </div>
          <div>
            <dt>Admin auth</dt>
            <dd>
              {data.api?.token ? (
                <span className="pill ok">token required</span>
              ) : (
                <span className="pill warn">open</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Metrics database</dt>
            <dd className="mono">{data.db || "—"}</dd>
          </div>
          <div>
            <dt>Geo database</dt>
            <dd className="mono">
              {data.geo?.type ? `${data.geo.type} ${data.geo.path ?? ""}` : "disabled"}
            </dd>
          </div>
          <div>
            <dt>Scheduled exit checks</dt>
            <dd>
              {data.exit_checks?.enabled === true ? (
                <span className="pill ok">
                  {data.exit_checks.cron || `every ${data.exit_checks.interval_seconds ?? 0}s`}
                </span>
              ) : (
                <span className="pill">off</span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

/** Counts per resource, so the overview answers "what is configured?". */
function ResourcesCard() {
  const { goose } = useSdk();
  const { data, loading } = useAsync(
    () =>
      Promise.all([
        goose.listInbounds(),
        goose.listOutbounds(),
        goose.listPools(),
        goose.listChains(),
        goose.listProviders(),
      ]),
    [goose],
  );

  const rows: Array<{ to: string; label: string; count: number | undefined; hint: string }> =
    [
      { to: "/inbounds", label: "Inbounds", count: data?.[0].length, hint: "client listeners" },
      { to: "/outbounds", label: "Outbounds", count: data?.[1].length, hint: "proxy servers" },
      { to: "/pools", label: "Pools", count: data?.[2].length, hint: "outbound sets" },
      { to: "/chains", label: "Chains", count: data?.[3].length, hint: "multi-hop routes" },
      { to: "/providers", label: "Providers", count: data?.[4].length, hint: "dynamic sources" },
    ];

  return (
    <div className="card">
      <h2>Configured resources</h2>
      {loading && data === undefined ? (
        <TableSkeleton cols={5} rows={1} />
      ) : (
        <div className="count-grid">
          {rows.map((r) => (
            <Link className="count-tile" to={r.to} key={r.to}>
              <span className="count-value">{r.count ?? "—"}</span>
              <span className="count-label">{r.label}</span>
              <span className="count-hint">{r.hint}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function EngineCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(
    () => goose.getEngine(),
    [goose],
  );
  const [draft, setDraft] = useState<Engine | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load the draft whenever fresh data arrives and no edit is in progress.
  useEffect(() => {
    if (data !== undefined && draft === null) setDraft(normalize(data));
  }, [data, draft]);

  if (loading && data === undefined)
    return (
      <div className="card">
        <h2>Engine configuration</h2>
        <TableSkeleton cols={3} rows={2} />
      </div>
    );
  if (error !== null)
    return <Notice>Failed to load engine: {error}</Notice>;
  if (draft === null) return null;

  const set = (patch: Partial<Engine>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await goose.setEngine(draft);
      setDraft(null); // fall back to server-confirmed state on next render
      reload();
    } catch (err) {
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h2>Engine configuration</h2>
      <div className="row">
        <SelectField
          id="engine-stack"
          label="Network stack"
          value={draft.stack ?? ""}
          emptyOption="(default)"
          options={["system", "gvisor"]}
          onChange={(stack) => set({ stack })}
        />
        <TextField
          id="engine-db"
          label="Metrics database"
          mono
          value={draft.db ?? ""}
          onChange={(db) => set({ db })}
        />
        <TextField
          id="engine-api-listen"
          label="Admin API listen"
          mono
          value={draft.api?.listen ?? ""}
          onChange={(listen) => set({ api: { ...(draft.api ?? {}), listen } })}
        />
      </div>
      <div className="row">
        <TextField
          id="engine-api-token"
          label="Admin API token"
          hint="Empty disables auth."
          type="password"
          autoComplete="new-password"
          value={draft.api?.token ?? ""}
          onChange={(token) => set({ api: { ...(draft.api ?? {}), token } })}
        />
        <SelectField
          id="engine-geo-type"
          label="Geo database type"
          value={draft.geo?.type ?? ""}
          emptyOption="(disabled)"
          options={["mmdb", "qqwry", "zxinc"]}
          onChange={(type) => set({ geo: { ...(draft.geo ?? {}), type } })}
        />
        <TextField
          id="engine-geo-path"
          label="Geo database path"
          mono
          value={draft.geo?.path ?? ""}
          onChange={(path) => set({ geo: { ...(draft.geo ?? {}), path } })}
        />
      </div>
      {saveError !== null && <Notice onDismiss={() => setSaveError(null)}>{saveError}</Notice>}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={saving || loading}
        >
          {saving ? "Saving…" : "Save engine config"}
        </button>
        <button type="button" onClick={() => data !== undefined && setDraft(normalize(data))}>
          Reset
        </button>
      </div>
    </div>
  );
}

/** Deep-copy with all optional containers materialized, so edits don't have
 *  to guard undefined at every field. */
function normalize(e: Engine): Engine {
  return {
    ...e,
    api: e.api ?? {},
    geo: e.geo ?? {},
  };
}
