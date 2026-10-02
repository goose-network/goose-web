// src/pages/InboundsPage.tsx — CRUD over inbound listeners.

import { useState } from "react";
import { useSdk } from "../sdk";
import { errMessage, useAsync } from "../useAsync";
import { StringList } from "../components/StringList";
import type { Inbound } from "@goose-network/goose-sdk";
import type { components } from "@goose-network/goose-sdk";

type User = components["schemas"]["config.User"];

export function InboundsPage() {
  return (
    <>
      <h1 className="page-title">Inbounds</h1>
      <p className="page-sub">
        HTTP/SOCKS5 listeners clients connect to. Changes apply live.
      </p>
      <InboundsCard />
    </>
  );
}

function InboundsCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(
    () => goose.listInbounds(),
    [goose],
  );
  const [draft, setDraft] = useState<Inbound | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading && data === undefined)
    return <div className="loading">Loading…</div>;
  if (error !== null)
    return <div className="error-box">Failed to load inbounds: {error}</div>;

  const startCreate = () =>
    setDraft({ id: "", protocol: "http", listen: "127.0.0.1:8080", users: [], policy: {} });
  const startEdit = (inb: Inbound) => setDraft(normalize(inb));

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await goose.createInbound(draft);
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
      await goose.deleteInbound(id);
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
          New inbound
        </button>
      </div>

      {draft !== null && (
        <div className="card">
          <h2>{draft.id === "" ? "New inbound" : `Edit ${draft.id}`}</h2>
          <InboundForm draft={draft} setDraft={setDraft} />
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
          <div className="empty">No inbounds configured.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Protocol</th>
                  <th>Listen</th>
                  <th>Users</th>
                  <th>Chain</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((inb) => (
                  <InboundRow key={inb.id} inb={inb} onEdit={() => startEdit(inb)} onDelete={() => void del(inb.id ?? "")} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function InboundRow({
  inb,
  onEdit,
  onDelete,
}: {
  inb: Inbound;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const users = inb.users ?? [];
  return (
    <tr>
      <td className="mono">{inb.id}</td>
      <td>
        <span className="pill">{inb.protocol ?? ""}</span>
      </td>
      <td className="mono">{inb.listen}</td>
      <td>{users.length === 0 ? "no auth" : users.length}</td>
      <td className="mono">{inb.policy?.chain_id || "—"}</td>
      <td>
        <button onClick={onEdit}>Edit</button>{" "}
        <button className="danger" onClick={onDelete}>
          Delete
        </button>
      </td>
    </tr>
  );
}

function InboundForm({
  draft,
  setDraft,
}: {
  draft: Inbound;
  setDraft: (d: Inbound) => void;
}) {
  const users = draft.users ?? [];
  const set = (patch: Partial<Inbound>) => setDraft({ ...draft, ...patch });

  const setUser = (i: number, patch: Partial<User>) => {
    const next = [...users];
    next[i] = { ...next[i]!, ...patch };
    set({ users: next });
  };

  return (
    <>
      <div className="row">
        <div className="field">
          <label htmlFor="inb-id">ID</label>
          <input
            id="inb-id"
            type="text"
            value={draft.id ?? ""}
            onChange={(e) => set({ id: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="inb-proto">Protocol</label>
          <select
            id="inb-proto"
            value={draft.protocol ?? "http"}
            onChange={(e) => set({ protocol: e.target.value })}
          >
            <option value="http">http</option>
            <option value="socks5">socks5</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="inb-listen">Listen address</label>
          <input
            id="inb-listen"
            type="text"
            value={draft.listen ?? ""}
            placeholder="127.0.0.1:8080"
            onChange={(e) => set({ listen: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="inb-chain">Default chain</label>
          <input
            id="inb-chain"
            type="text"
            value={draft.policy?.chain_id ?? ""}
            placeholder="chain id (optional)"
            onChange={(e) =>
              set({ policy: { ...(draft.policy ?? {}), chain_id: e.target.value } })
            }
          />
        </div>
      </div>

      <StringList
        id="inb-users"
        label="Users (empty = no auth)"
        placeholder="username"
        values={users.map((u) => u.username ?? "")}
        onChange={(names) =>
          set({
            users: names.map((name, i) => ({
              username: name,
              password: users[i]?.password ?? "",
            })),
          })
        }
      />

      {users.map((u, i) => (
        <div className="user-row" key={i}>
          <input
            type="text"
            aria-label={`Password for ${u.username || `user ${i + 1}`}`}
            placeholder="password"
            value={u.password ?? ""}
            onChange={(e) => setUser(i, { password: e.target.value })}
          />
          <input
            type="text"
            className="chain-input"
            aria-label={`Per-user chain for ${u.username || `user ${i + 1}`}`}
            placeholder="per-user chain (optional)"
            value={u.policy?.chain_id ?? ""}
            onChange={(e) =>
              setUser(i, {
                policy: { ...(u.policy ?? {}), chain_id: e.target.value },
              })
            }
          />
        </div>
      ))}
    </>
  );
}

function normalize(inb: Inbound): Inbound {
  return {
    ...inb,
    users: (inb.users ?? []).map((u) => ({
      username: u.username ?? "",
      password: u.password ?? "",
    })),
    policy: inb.policy ?? {},
  };
}
