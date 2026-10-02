// src/pages/EnginePage.tsx — overview + engine-level config editor.

import { useEffect, useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import type { Engine } from "@goose-network/goose-sdk";

export function EnginePage() {
  return (
    <>
      <h1 className="page-title">Overview</h1>
      <p className="page-sub">Engine configuration, applied live.</p>
      <EngineCard />
    </>
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

  if (loading && data === undefined) return <div className="loading">Loading…</div>;
  if (error !== null) return <div className="error-box">Failed to load engine: {error}</div>;
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
      <h2>Engine</h2>
      <div className="row">
        <div className="field">
          <label htmlFor="engine-stack">Network stack</label>
          <select
            id="engine-stack"
            value={draft.stack ?? ""}
            onChange={(e) => set({ stack: e.target.value })}
          >
            <option value="">(default)</option>
            <option value="system">system</option>
            <option value="gvisor">gvisor</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="engine-db">Metrics database</label>
          <input
            id="engine-db"
            type="text"
            value={draft.db ?? ""}
            onChange={(e) => set({ db: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="engine-api-listen">Admin API listen</label>
          <input
            id="engine-api-listen"
            type="text"
            value={draft.api?.listen ?? ""}
            onChange={(e) =>
              set({
                api: {
                  ...(draft.api ?? {}),
                  listen: e.target.value,
                },
              })
            }
          />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="engine-api-token">Admin API token (empty disables auth)</label>
          <input
            id="engine-api-token"
            type="password"
            value={draft.api?.token ?? ""}
            onChange={(e) =>
              set({
                api: {
                  ...(draft.api ?? {}),
                  token: e.target.value,
                },
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="engine-geo-type">Geo database type</label>
          <select
            id="engine-geo-type"
            value={draft.geo?.type ?? ""}
            onChange={(e) =>
              set({
                geo: {
                  ...(draft.geo ?? {}),
                  type: e.target.value,
                },
              })
            }
          >
            <option value="">(disabled)</option>
            <option value="mmdb">mmdb</option>
            <option value="qqwry">qqwry</option>
            <option value="zxinc">zxinc</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="engine-geo-path">Geo database path</label>
          <input
            id="engine-geo-path"
            type="text"
            value={draft.geo?.path ?? ""}
            onChange={(e) =>
              set({
                geo: {
                  ...(draft.geo ?? {}),
                  path: e.target.value,
                },
              })
            }
          />
        </div>
      </div>
      {saveError !== null && <div className="error-box">{saveError}</div>}
      <div className="toolbar">
        <button
          className="primary"
          onClick={() => void save()}
          disabled={saving || loading}
        >
          {saving ? "Saving…" : "Save engine config"}
        </button>
        <button onClick={() => data !== undefined && setDraft(normalize(data))}>
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
