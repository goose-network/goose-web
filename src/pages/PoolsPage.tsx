// src/pages/PoolsPage.tsx — CRUD over pools (outbound set + filters + selector).

import { useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { StringList } from "../components/StringList";
import { KvEditor } from "../components/KvEditor";
import type { Pool, FilterSpec } from "./poolTypes";

const SELECTORS = ["random", "roundrobin", "sticky", "leastlatency"] as const;
const FILTERS = ["location", "latency", "protocol"] as const;

export function PoolsPage() {
  return (
    <>
      <h1 className="page-title">Pools</h1>
      <p className="page-sub">
        Ordered outbound sets with filters and a selection strategy.
      </p>
      <PoolsCard />
    </>
  );
}

function PoolsCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(() => goose.listPools(), [goose]);
  const [draft, setDraft] = useState<Pool | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading && data === undefined)
    return <div className="loading">Loading…</div>;
  if (error !== null)
    return <div className="error-box">Failed to load pools: {error}</div>;

  const startCreate = () =>
    setDraft({
      id: "",
      outbound_ids: [],
      filters: [],
      selector: { type: "random", params: {} },
    });
  const startEdit = (p: Pool) => setDraft(normalize(p));

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await goose.createPool(draft);
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
      await goose.deletePool(id);
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
          New pool
        </button>
      </div>

      {draft !== null && (
        <div className="card">
          <h2>{draft.id === "" ? "New pool" : `Edit ${draft.id}`}</h2>
          <PoolForm draft={draft} setDraft={setDraft} />
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
          <div className="empty">No pools configured.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Outbounds</th>
                  <th>Selector</th>
                  <th>Filters</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{(p.outbound_ids ?? []).length}</td>
                    <td>
                      <span className="pill">{p.selector?.type ?? "—"}</span>
                    </td>
                    <td>{(p.filters ?? []).map((f) => f.type).join(", ") || "—"}</td>
                    <td>
                      <button onClick={() => startEdit(p)}>Edit</button>{" "}
                      <button className="danger" onClick={() => void del(p.id ?? "")}>
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

function PoolForm({
  draft,
  setDraft,
}: {
  draft: Pool;
  setDraft: (p: Pool) => void;
}) {
  const set = (patch: Partial<Pool>) => setDraft({ ...draft, ...patch });
  const filters = draft.filters ?? [];

  const setFilter = (i: number, patch: Partial<FilterSpec>) => {
    const next = [...filters];
    next[i] = { ...next[i]!, ...patch };
    set({ filters: next });
  };

  return (
    <>
      <div className="row">
        <div className="field">
          <label htmlFor="pool-id">ID</label>
          <input
            id="pool-id"
            type="text"
            value={draft.id ?? ""}
            onChange={(e) => set({ id: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="pool-selector">Selection strategy</label>
          <select
            id="pool-selector"
            value={draft.selector?.type ?? "random"}
            onChange={(e) =>
              set({
                selector: { ...(draft.selector ?? {}), type: e.target.value },
              })
            }
          >
            {SELECTORS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <StringList
        id="pool-outbounds"
        label="Outbound ids (in order)"
        placeholder="outbound id"
        values={draft.outbound_ids ?? []}
        onChange={(outbound_ids) => set({ outbound_ids })}
      />

      <KvEditor
        id="pool-selector-params"
        label="Selector params (JSON)"
        value={draft.selector?.params}
        onChange={(params) =>
          set({
            selector: { ...(draft.selector ?? { type: "random" }), params },
          })
        }
      />

      <div className="field">
        <label>Filters</label>
        <div className="arr-editor">
          {filters.map((f, i) => (
            <div className="filter-row" key={i} style={{ marginBottom: 10 }}>
              <div className="row">
                <div className="field">
                  <label htmlFor={`filter-type-${i}`}>Type</label>
                  <select
                    id={`filter-type-${i}`}
                    value={f.type ?? "location"}
                    onChange={(e) => setFilter(i, { type: e.target.value })}
                  >
                    {FILTERS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: 2 }}>
                  <KvEditor
                    id={`filter-params-${i}`}
                    label="Params (JSON)"
                    value={f.params}
                    onChange={(params) => setFilter(i, { params })}
                  />
                </div>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    set({ filters: filters.filter((_, j) => j !== i) })
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set({ filters: [...filters, { type: "location", params: {} }] })}
          >
            Add filter
          </button>
        </div>
      </div>
    </>
  );
}

function normalize(p: Pool): Pool {
  return {
    ...p,
    outbound_ids: p.outbound_ids ?? [],
    filters: (p.filters ?? []).map((f) => ({ ...f, params: f.params ?? {} })),
    selector: { type: "random", ...(p.selector ?? {}), params: p.selector?.params ?? {} },
  };
}
