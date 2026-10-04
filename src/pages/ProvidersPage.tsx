// src/pages/ProvidersPage.tsx — CRUD over dynamic outbound providers, with a
// subscription-link quick-create form (the common case: paste a URL, get a
// managed pool of proxies).

import { useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { KvEditor } from "../components/KvEditor";
import type { ProviderSpec } from "@goose-network/goose-sdk";

export function ProvidersPage() {
  return (
    <>
      <h1 className="page-title">Providers</h1>
      <p className="page-sub">
        Dynamic outbound sources. A provider fetches its own proxy list and
        feeds a managed pool; the engine keeps the pool in sync without a
        restart.
      </p>
      <ProvidersCard />
    </>
  );
}

function ProvidersCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(
    () => goose.listProviders(),
    [goose],
  );
  const [draft, setDraft] = useState<ProviderSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading && data === undefined)
    return <div className="loading">Loading…</div>;
  if (error !== null)
    return <div className="error-box">Failed to load providers: {error}</div>;

  const startCreate = () =>
    setDraft({
      id: "",
      provider: "subscription",
      pool_id: "",
      config: { url: "" },
    });
  const startEdit = (p: ProviderSpec) => setDraft({ ...p, config: { ...(p.config ?? {}) } });

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await goose.createProvider(draft);
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
      await goose.deleteProvider(id);
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
          New provider
        </button>
      </div>

      {draft !== null && (
        <div className="card">
          <h2>{draft.id === "" ? "New provider" : `Edit ${draft.id}`}</h2>
          <ProviderForm draft={draft} setDraft={setDraft} />
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
          <div className="empty">No providers configured.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Plugin</th>
                  <th>Pool</th>
                  <th>Config</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    onEdit={() => startEdit(p)}
                    onDelete={() => void del(p.id ?? "")}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ProviderSpec;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cfg = provider.config ?? {};
  const url = typeof cfg.url === "string" ? cfg.url : "";
  return (
    <tr>
      <td className="mono">{provider.id}</td>
      <td>
        <span className="pill">{provider.provider ?? ""}</span>
      </td>
      <td className="mono">{provider.pool_id || "default"}</td>
      <td className="mono ellipsis">{url || "—"}</td>
      <td>
        <button onClick={onEdit}>Edit</button>{" "}
        <button className="danger" onClick={onDelete}>
          Delete
        </button>
      </td>
    </tr>
  );
}

function ProviderForm({
  draft,
  setDraft,
}: {
  draft: ProviderSpec;
  setDraft: (d: ProviderSpec) => void;
}) {
  const set = (patch: Partial<ProviderSpec>) => setDraft({ ...draft, ...patch });
  const cfg = draft.config ?? {};
  const setCfg = (next: Record<string, unknown>) => set({ config: next });

  return (
    <div className="row">
      <div className="field">
        <label htmlFor="prov-id">ID</label>
        <input
          id="prov-id"
          type="text"
          value={draft.id ?? ""}
          onChange={(e) => set({ id: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="prov-plugin">Plugin</label>
        <select
          id="prov-plugin"
          value={draft.provider ?? "subscription"}
          onChange={(e) => set({ provider: e.target.value })}
        >
          <option value="subscription">subscription</option>
          <option value="psiphon">psiphon</option>
          <option value="mihomo">mihomo</option>
          <option value="singbox">singbox</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="prov-pool">Pool ID</label>
        <input
          id="prov-pool"
          type="text"
          value={draft.pool_id ?? ""}
          placeholder="defaults to the “default” pool"
          onChange={(e) => set({ pool_id: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="prov-url">Subscription URL</label>
        <input
          id="prov-url"
          type="text"
          value={typeof cfg.url === "string" ? cfg.url : ""}
          placeholder="https://example.com/sub"
          onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="prov-prefix">ID prefix</label>
        <input
          id="prov-prefix"
          type="text"
          value={typeof cfg.prefix === "string" ? cfg.prefix : ""}
          placeholder="sub (optional)"
          onChange={(e) =>
            e.target.value === ""
              ? setCfg({ url: cfg.url })
              : setCfg({ ...cfg, prefix: e.target.value })
          }
        />
      </div>
      <KvEditor
        id="prov-extra"
        label="Extra config (advanced)"
        value={cfg}
        onChange={setCfg}
      />
    </div>
  );
}
