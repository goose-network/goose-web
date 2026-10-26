// src/pages/InboundsPage.tsx — CRUD over inbound listeners.

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useResource } from "../useResource";
import { collect, hostPort, required } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { SearchInput, matches } from "../components/SearchInput";
import { SelectField, TextField, FieldGroup } from "../components/fields";
import { KvEditor } from "../components/KvEditor";
import type { Inbound } from "@goose-network/goose-sdk";
import type { components } from "@goose-network/goose-sdk";
import type { FilterSpec } from "./poolTypes";

type User = components["schemas"]["config.User"];
type Policy = components["schemas"]["config.InboundPolicy"];

const FILTERS = ["location", "latency", "protocol"] as const;

export function InboundsPage() {
  const { goose } = useSdk();
  const [filter, setFilter] = useState("");

  const r = useResource<Inbound>({
    api: {
      list: () => goose.listInbounds(),
      save: (d) => goose.createInbound(d),
      remove: (id) => goose.deleteInbound(id),
    },
    deps: [goose],
    idOf: (i) => i.id ?? "",
    blank: () => ({
      id: "",
      protocol: "http",
      listen: "127.0.0.1:8080",
      users: [],
      policy: {},
    }),
    normalize,
    noun: "inbound",
    validate: (d) =>
      collect({
        id: required(d.id, "An ID is required"),
        listen: hostPort(d.listen, "Use host:port, e.g. 127.0.0.1:8080"),
      }),
  });

  const items = useMemo(
    () =>
      r.items.filter((i) =>
        matches(`${i.id ?? ""} ${i.protocol ?? ""} ${i.listen ?? ""}`, filter),
      ),
    [r.items, filter],
  );

  const columns: Array<Column<Inbound>> = [
    { key: "id", header: "ID", className: "mono", render: (i) => i.id },
    {
      key: "protocol",
      header: "Protocol",
      render: (i) => <span className="pill">{i.protocol ?? ""}</span>,
    },
    { key: "listen", header: "Listen", className: "mono", render: (i) => i.listen },
    {
      key: "users",
      header: "Users",
      render: (i) =>
        (i.users ?? []).length === 0 ? (
          <span className="hint" style={{ margin: 0 }}>
            no auth
          </span>
        ) : (
          (i.users ?? []).length
        ),
    },
    {
      key: "chain",
      header: "Routing",
      className: "mono",
      render: (i) => routingLabel(i.policy),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "actions",
      render: (i) => (
        <>
          <button type="button" className="ghost" onClick={() => r.startEdit(i)}>
            Edit
          </button>{" "}
          <ConfirmButton onConfirm={() => void r.remove(i)} title={`Delete ${i.id ?? ""}`} />
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Inbounds"
        sub="HTTP/SOCKS5 listeners clients connect to. Changes apply live."
        actions={
          <button type="button" className="primary" onClick={r.startCreate}>
            New inbound
          </button>
        }
      />

      {r.draft !== null && (
        <FormCard
          title={r.isNew ? "New inbound" : `Edit ${r.idOf(r.draft)}`}
          onSave={() => void r.save()}
          onCancel={r.cancel}
          saving={r.saving}
          dirty
          error={r.saveError}
          onDismissError={r.dismissSaveError}
        >
          <InboundForm
            draft={r.draft}
            setDraft={r.setDraft}
            fieldErrors={r.fieldErrors}
            idLocked={!r.isNew}
          />
        </FormCard>
      )}

      <div className="filter-bar">
        <SearchInput id="inbound-filter" value={filter} onChange={setFilter} placeholder="Filter by id, protocol, listen…" />
        <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
          {items.length} of {r.items.length}
        </span>
      </div>

      <div className="card">
        <DataTable
          caption="Inbound listeners"
          columns={columns}
          rows={items}
          rowKey={(i) => i.id ?? ""}
          loading={r.loading}
          error={r.error}
          onRetry={r.reload}
          empty={
            r.items.length === 0 ? (
              <EmptyState
                title="No inbounds configured"
                hint="Clients need at least one listener to connect through."
                action={
                  <button type="button" className="primary" onClick={r.startCreate}>
                    New inbound
                  </button>
                }
              />
            ) : (
              <EmptyState title="No inbounds match" hint={`Nothing matches “${filter}”.`} />
            )
          }
        />
      </div>
    </>
  );
}

// The routing label mirrors the engine's resolution order (chain, then
// outbound, then pool) so the table's Routing column stays honest.
export function routingLabel(policy: Policy | undefined): string {
  if (policy?.chain_id) return `chain ${policy.chain_id}`;
  if (policy?.outbound_id) return `outbound ${policy.outbound_id}`;
  if (policy?.pool_id) return `pool ${policy.pool_id}`;
  return "any";
}

function InboundForm({
  draft,
  setDraft,
  fieldErrors,
  idLocked,
}: {
  draft: Inbound;
  setDraft: (d: Inbound) => void;
  fieldErrors: Record<string, string>;
  /** editing: the id is the resource's identity, so it can't change here */
  idLocked: boolean;
}) {
  const users = draft.users ?? [];
  const set = (patch: Partial<Inbound>) => setDraft({ ...draft, ...patch });
  const policy = draft.policy ?? {};
  const filters = policy.filters ?? [];
  const setPolicy = (patch: Partial<Policy>) =>
    set({ policy: { ...policy, ...patch } });

  const setUser = (i: number, patch: Partial<User>) => {
    const next = [...users];
    next[i] = { ...next[i]!, ...patch };
    set({ users: next });
  };
  const setUserPolicy = (i: number, patch: Partial<Policy>) =>
    setUser(i, { policy: { ...(users[i]!.policy ?? {}), ...patch } });

  return (
    <>
      <div className="row">
        <TextField
          id="inb-id"
          label="ID"
          mono
          value={draft.id ?? ""}
          error={fieldErrors.id}
          disabled={idLocked}
          hint={idLocked ? "The ID is this inbound's identity." : undefined}
          onChange={(id) => set({ id })}
          placeholder="in-http"
          autoFocus={!idLocked}
        />
        <SelectField
          id="inb-proto"
          label="Protocol"
          value={draft.protocol ?? "http"}
          options={["http", "socks5"]}
          onChange={(protocol) => set({ protocol })}
        />
        <TextField
          id="inb-listen"
          label="Listen address"
          mono
          value={draft.listen ?? ""}
          error={fieldErrors.listen}
          placeholder="127.0.0.1:8080"
          onChange={(listen) => set({ listen })}
        />
      </div>
      <div className="row">
        <TextField
          id="inb-chain"
          label="Default chain"
          mono
          value={policy.chain_id ?? ""}
          placeholder="chain id (optional)"
          onChange={(chain_id) => setPolicy({ chain_id })}
        />
        <TextField
          id="inb-outbound"
          label="Outbound"
          mono
          value={policy.outbound_id ?? ""}
          placeholder="outbound id (optional)"
          hint="Pin this inbound to one server — used when no chain is set."
          onChange={(outbound_id) => setPolicy({ outbound_id })}
        />
        <TextField
          id="inb-pool"
          label="Pool"
          mono
          value={policy.pool_id ?? ""}
          placeholder="pool id (optional)"
          onChange={(pool_id) => setPolicy({ pool_id })}
        />
      </div>

      <FieldGroup
        id="inb-filters"
        label="Policy filters"
        hint="Narrow the route for this inbound (on top of a pool's own filters, and on every layer of a chain)."
      >
        <FilterList
          id="inb-filter"
          filters={filters}
          onChange={(next) => setPolicy({ filters: next })}
        />
      </FieldGroup>

      <FieldGroup
        id="inb-users"
        label="Users"
        hint="Leave empty for no authentication. A user's route fields (chain / outbound / pool) replace the inbound's as a group; their filters are their own."
      >
        {users.map((u, i) => (
          <div className="user-row" key={i}>
            <input
              type="text"
              className="mono"
              aria-label={`Username ${i + 1}`}
              placeholder="username"
              value={u.username ?? ""}
              onChange={(e) => setUser(i, { username: e.target.value })}
            />
            <input
              type="text"
              aria-label={`Password for ${u.username || `user ${i + 1}`}`}
              placeholder="password"
              value={u.password ?? ""}
              onChange={(e) => setUser(i, { password: e.target.value })}
            />
            <input
              type="text"
              className="mono"
              aria-label={`Per-user chain for ${u.username || `user ${i + 1}`}`}
              placeholder="per-user chain"
              value={u.policy?.chain_id ?? ""}
              onChange={(e) => setUserPolicy(i, { chain_id: e.target.value })}
            />
            <input
              type="text"
              className="mono"
              aria-label={`Per-user outbound for ${u.username || `user ${i + 1}`}`}
              placeholder="per-user outbound"
              value={u.policy?.outbound_id ?? ""}
              onChange={(e) => setUserPolicy(i, { outbound_id: e.target.value })}
            />
            <input
              type="text"
              className="mono"
              aria-label={`Per-user pool for ${u.username || `user ${i + 1}`}`}
              placeholder="per-user pool"
              value={u.policy?.pool_id ?? ""}
              onChange={(e) => setUserPolicy(i, { pool_id: e.target.value })}
            />
            <button
              type="button"
              className="ghost icon"
              aria-label={`Remove user ${u.username || i + 1}`}
              onClick={() => set({ users: users.filter((_, j) => j !== i) })}
            >
              ×
            </button>
            <div className="user-filters">
              <FilterList
                id={`inb-user-filter-${i}`}
                filters={u.policy?.filters ?? []}
                onChange={(next) => setUserPolicy(i, { filters: next })}
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set({ users: [...users, { username: "", password: "" }] })}
        >
          Add user
        </button>
      </FieldGroup>
    </>
  );
}

function normalize(inb: Inbound): Inbound {
  return {
    ...inb,
    users: (inb.users ?? []).map((u) => ({
      username: u.username ?? "",
      password: u.password ?? "",
      policy: {
        ...(u.policy ?? {}),
        filters: (u.policy?.filters ?? []).map((f) => ({
          ...f,
          params: f.params ?? {},
        })),
      },
    })),
    policy: {
      ...(inb.policy ?? {}),
      filters: (inb.policy?.filters ?? []).map((f) => ({
        ...f,
        params: f.params ?? {},
      })),
    },
  };
}

// FilterList edits a policy's filter array: the same shape serves the
// inbound-level policy and each user's (filters are per-user now).
function FilterList({
  id,
  filters,
  onChange,
}: {
  id: string;
  filters: FilterSpec[];
  onChange: (next: FilterSpec[]) => void;
}) {
  return (
    <div className="arr-editor">
      {filters.map((f, i) => (
        <div className="item-row" key={i} style={{ alignItems: "start" }}>
          <SelectField
            id={`${id}-type-${i}`}
            label="Type"
            className="filter-type"
            value={f.type ?? "location"}
            options={[...FILTERS]}
            onChange={(type) => {
              const next = [...filters];
              next[i] = { ...next[i]!, type };
              onChange(next);
            }}
          />
          <KvEditor
            id={`${id}-params-${i}`}
            label="Params (JSON)"
            value={f.params}
            onChange={(params) => {
              const next = [...filters];
              next[i] = { ...next[i]!, params };
              onChange(next);
            }}
          />
          <button
            type="button"
            className="danger"
            onClick={() => onChange(filters.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...filters, { type: "location", params: {} }])}
      >
        Add filter
      </button>
    </div>
  );
}
