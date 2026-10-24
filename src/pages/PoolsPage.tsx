// src/pages/PoolsPage.tsx — CRUD over pools (outbound set + filters + selector).

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useResource } from "../useResource";
import { collect, required } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { SearchInput, matches } from "../components/SearchInput";
import { SelectField, TextField, FieldGroup } from "../components/fields";
import { StringList } from "../components/StringList";
import { KvEditor } from "../components/KvEditor";
import type { Pool, FilterSpec } from "./poolTypes";

const SELECTORS = ["random", "roundrobin", "sticky", "leastlatency"] as const;
const FILTERS = ["location", "latency", "protocol"] as const;

export function PoolsPage() {
  const { goose } = useSdk();
  const [filter, setFilter] = useState("");

  const r = useResource<Pool>({
    api: {
      list: () => goose.listPools(),
      save: (d) => goose.createPool(d),
      remove: (id) => goose.deletePool(id),
    },
    deps: [goose],
    idOf: (p) => p.id ?? "",
    blank: () => ({
      id: "",
      outbound_ids: [],
      filters: [],
      selector: { type: "random", params: {} },
    }),
    normalize,
    noun: "pool",
    validate: (d) => collect({ id: required(d.id, "An ID is required") }),
  });

  const items = useMemo(
    () =>
      r.items.filter((p) =>
        matches(
          `${p.id ?? ""} ${p.selector?.type ?? ""} ${(p.outbound_ids ?? []).join(" ")}`,
          filter,
        ),
      ),
    [r.items, filter],
  );

  const columns: Array<Column<Pool>> = [
    { key: "id", header: "ID", className: "mono", render: (p) => p.id },
    {
      key: "outbounds",
      header: "Outbounds",
      className: "mono",
      render: (p) => {
        const ids = p.outbound_ids ?? [];
        const shown = ids.slice(0, 3).join(", ");
        return ids.length === 0 ? (
          "—"
        ) : (
          <span title={ids.join(", ")}>
            {shown}
            {ids.length > 3 ? ` +${ids.length - 3}` : ""}
          </span>
        );
      },
    },
    {
      key: "selector",
      header: "Selector",
      render: (p) => <span className="pill">{p.selector?.type ?? "—"}</span>,
    },
    {
      key: "filters",
      header: "Filters",
      render: (p) =>
        (p.filters ?? []).length === 0
          ? "—"
          : (p.filters ?? []).map((f) => f.type).join(", "),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "actions",
      render: (p) => (
        <>
          <button type="button" className="ghost" onClick={() => r.startEdit(p)}>
            Edit
          </button>{" "}
          <ConfirmButton onConfirm={() => void r.remove(p)} title={`Delete ${p.id ?? ""}`} />
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Pools"
        sub="Ordered outbound sets with filters and a selection strategy."
        actions={
          <button type="button" className="primary" onClick={r.startCreate}>
            New pool
          </button>
        }
      />

      {r.draft !== null && (
        <FormCard
          title={r.isNew ? "New pool" : `Edit ${r.idOf(r.draft)}`}
          onSave={() => void r.save()}
          onCancel={r.cancel}
          saving={r.saving}
          dirty
          error={r.saveError}
          onDismissError={r.dismissSaveError}
        >
          <PoolForm draft={r.draft} setDraft={r.setDraft} fieldErrors={r.fieldErrors} idLocked={!r.isNew} />
        </FormCard>
      )}

      <div className="filter-bar">
        <SearchInput
          id="pool-filter"
          value={filter}
          onChange={setFilter}
          placeholder="Filter by id, selector, outbound…"
        />
        <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
          {items.length} of {r.items.length}
        </span>
      </div>

      <div className="card">
        <DataTable
          caption="Pools"
          columns={columns}
          rows={items}
          rowKey={(p) => p.id ?? ""}
          loading={r.loading}
          error={r.error}
          onRetry={r.reload}
          empty={
            r.items.length === 0 ? (
              <EmptyState
                title="No pools configured"
                hint="A pool groups outbounds behind one selection strategy."
                action={
                  <button type="button" className="primary" onClick={r.startCreate}>
                    New pool
                  </button>
                }
              />
            ) : (
              <EmptyState title="No pools match" hint={`Nothing matches “${filter}”.`} />
            )
          }
        />
      </div>
    </>
  );
}

function PoolForm({
  draft,
  setDraft,
  fieldErrors,
  idLocked,
}: {
  draft: Pool;
  setDraft: (p: Pool) => void;
  fieldErrors: Record<string, string>;
  idLocked: boolean;
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
        <TextField
          id="pool-id"
          label="ID"
          mono
          value={draft.id ?? ""}
          error={fieldErrors.id}
          disabled={idLocked}
          onChange={(id) => set({ id })}
          placeholder="pool-relay"
          autoFocus={!idLocked}
        />
        <SelectField
          id="pool-selector"
          label="Selection strategy"
          value={draft.selector?.type ?? "random"}
          options={[...SELECTORS]}
          onChange={(type) =>
            set({ selector: { ...(draft.selector ?? {}), type } })
          }
        />
      </div>

      <StringList
        id="pool-outbounds"
        label="Outbound ids (in order)"
        placeholder="outbound id"
        mono
        ordered
        values={draft.outbound_ids ?? []}
        onChange={(outbound_ids) => set({ outbound_ids })}
      />

      <KvEditor
        id="pool-selector-params"
        label="Selector params (JSON)"
        value={draft.selector?.params}
        onChange={(params) =>
          set({ selector: { ...(draft.selector ?? { type: "random" }), params } })
        }
      />

      <FieldGroup id="pool-filters" label="Filters" hint="Applied in order; a member must pass all of them.">
        <div className="arr-editor">
          {filters.map((f, i) => (
            <div className="item-row" key={i} style={{ alignItems: "start" }}>
              <SelectField
                id={`filter-type-${i}`}
                label="Type"
                value={f.type ?? "location"}
                options={[...FILTERS]}
                onChange={(type) => setFilter(i, { type })}
              />
              <KvEditor
                id={`filter-params-${i}`}
                label="Params (JSON)"
                value={f.params}
                onChange={(params) => setFilter(i, { params })}
              />
              <button
                type="button"
                className="danger"
                onClick={() => set({ filters: filters.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set({ filters: [...filters, { type: "location", params: {} }] })}
          >
            Add filter
          </button>
        </div>
      </FieldGroup>
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
