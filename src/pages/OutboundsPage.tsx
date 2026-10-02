// src/pages/OutboundsPage.tsx — CRUD over outbound proxy specs.

import { useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { KvEditor } from "../components/KvEditor";
import type { OutboundSpec } from "@goose-network/goose-sdk";

// Protocols registered by the engine's plugin set (include/register.go).
const PROTOCOLS = ["direct", "http", "socks5", "psiphon"] as const;

export function OutboundsPage() {
  return (
    <>
      <h1 className="page-title">Outbounds</h1>
      <p className="page-sub">
        Proxy servers and providers the engine can dial through.
      </p>
      <OutboundsCard />
    </>
  );
}

function OutboundsCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(
    () => goose.listOutbounds(),
    [goose],
  );
  const [draft, setDraft] = useState<OutboundSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading && data === undefined)
    return <div className="loading">Loading…</div>;
  if (error !== null)
    return <div className="error-box">Failed to load outbounds: {error}</div>;

  const startCreate = () =>
    setDraft({ id: "", protocol: "direct", config: {} });
  const startEdit = (o: OutboundSpec) => setDraft(normalize(o));

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await goose.createOutbound(draft);
      setDraft(null);
      reload();
    } catch (err) {
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const del = async (id: string) => {
    try {
      await goose.deleteOutbound(id);
      reload();
    } catch (err) {
      setSaveError(errMessage(err));
    }
  };

  const items = data ?? [];

  return (
    <>
      {saveError !== null && <div className="error-box">{saveError}</div>}
      <div className="toolbar">
        <button className="primary" onClick={startCreate}>
          New outbound
        </button>
      </div>

      {draft !== null && (
        <div className="card">
          <h2>{draft.id === "" ? "New outbound" : `Edit ${draft.id}`}</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="out-id">ID</label>
              <input
                id="out-id"
                type="text"
                value={draft.id ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, id: e.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="out-proto">Protocol</label>
              <select
                id="out-proto"
                value={draft.protocol ?? "direct"}
                onChange={(e) =>
                  setDraft({ ...draft, protocol: e.target.value })
                }
              >
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <KvEditor
            id="out-config"
            label="Config (JSON)"
            value={draft.config}
            onChange={(config) => setDraft({ ...draft, config })}
          />
          <div className="toolbar">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        {items.length === 0 ? (
          <div className="empty">No outbounds configured.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Protocol</th>
                  <th>Config</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.id}</td>
                    <td>
                      <span className="pill">{o.protocol ?? ""}</span>
                    </td>
                    <td className="mono" style={{ maxWidth: 420 }}>
                      {summarize(o.config)}
                    </td>
                    <td>
                      <button onClick={() => startEdit(o)}>Edit</button>{" "}
                      <button
                        className="danger"
                        onClick={() => void del(o.id ?? "")}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function summarize(config: Record<string, unknown> | undefined): string {
  const entries = Object.entries(config ?? {}).filter(([k]) => !k.startsWith("_"));
  if (entries.length === 0) return "—";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
}

function normalize(o: OutboundSpec): OutboundSpec {
  return {
    ...o,
    config: Object.fromEntries(
      Object.entries(o.config ?? {}).filter(([k]) => !k.startsWith("_")),
    ),
  };
}
