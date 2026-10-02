// src/pages/ChainsPage.tsx — CRUD over chains (ordered pool layers).

import { useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { StringList } from "../components/StringList";
import type { ChainSpec } from "@goose-network/goose-sdk";

export function ChainsPage() {
  return (
    <>
      <h1 className="page-title">Chains</h1>
      <p className="page-sub">
        Ordered pool layers; a request traverses them in order.
      </p>
      <ChainsCard />
    </>
  );
}

function ChainsCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(
    () => goose.listChains(),
    [goose],
  );
  const [draft, setDraft] = useState<ChainSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading && data === undefined)
    return <div className="loading">Loading…</div>;
  if (error !== null)
    return <div className="error-box">Failed to load chains: {error}</div>;

  const startCreate = () => setDraft({ id: "", layers: [] });
  const startEdit = (c: ChainSpec) => setDraft({ ...c, layers: c.layers ?? [] });

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await goose.createChain(draft);
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
      await goose.deleteChain(id);
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
          New chain
        </button>
      </div>

      {draft !== null && (
        <div className="card">
          <h2>{draft.id === "" ? "New chain" : `Edit ${draft.id}`}</h2>
          <div className="field">
            <label htmlFor="chain-id">ID</label>
            <input
              id="chain-id"
              type="text"
              value={draft.id ?? ""}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
          </div>
          <StringList
            id="chain-layers"
            label="Pool layers (in order)"
            placeholder="pool id"
            values={draft.layers ?? []}
            onChange={(layers) => setDraft({ ...draft, layers })}
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
          <div className="empty">No chains configured.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Layers</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td className="mono">{(c.layers ?? []).join(" → ") || "—"}</td>
                    <td>
                      <button onClick={() => startEdit(c)}>Edit</button>{" "}
                      <button className="danger" onClick={() => void del(c.id ?? "")}>
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
