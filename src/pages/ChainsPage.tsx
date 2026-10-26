// src/pages/ChainsPage.tsx — CRUD over chains (ordered pool/server layers).

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useResource } from "../useResource";
import { collect, required } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { Notice } from "../components/Notice";
import { SearchInput, matches } from "../components/SearchInput";
import { TextField } from "../components/fields";
import { StringList } from "../components/StringList";
import type { ChainSpec } from "@goose-network/goose-sdk";
import { ChainProbesCard } from "./ChainProbesCard";

export function ChainsPage() {
  const { goose } = useSdk();
  const [filter, setFilter] = useState("");

  const r = useResource<ChainSpec>({
    api: {
      list: () => goose.listChains(),
      save: (d) => goose.createChain(d),
      remove: (id) => goose.deleteChain(id),
    },
    deps: [goose],
    idOf: (c) => c.id ?? "",
    blank: () => ({ id: "", layers: [] }),
    normalize: (c) => ({ ...c, layers: c.layers ?? [] }),
    noun: "chain",
    validate: (d) =>
      collect({
        id: required(d.id, "An ID is required"),
        layers:
          (d.layers ?? []).length === 0 ? "layers" : null,
      }),
  });

  const items = useMemo(
    () =>
      r.items.filter((c) =>
        matches(`${c.id ?? ""} ${(c.layers ?? []).join(" ")}`, filter),
      ),
    [r.items, filter],
  );

  const columns: Array<Column<ChainSpec>> = [
    { key: "id", header: "ID", className: "mono", render: (c) => c.id },
    {
      key: "layers",
      header: "Layers",
      className: "mono",
      render: (c) => (c.layers ?? []).join(" → ") || "—",
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "actions",
      render: (c) => (
        <>
          <button type="button" className="ghost" onClick={() => r.startEdit(c)}>
            Edit
          </button>{" "}
          <ConfirmButton onConfirm={() => void r.remove(c)} title={`Delete ${c.id ?? ""}`} />
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Chains"
        sub="Ordered layers of pools and/or single outbound servers; a request traverses them in order."
        actions={
          <button type="button" className="primary" onClick={r.startCreate}>
            New chain
          </button>
        }
      />

      {r.draft !== null && (
        <FormCard
          title={r.isNew ? "New chain" : `Edit ${r.idOf(r.draft)}`}
          onSave={() => void r.save()}
          onCancel={r.cancel}
          saving={r.saving}
          dirty
          error={r.saveError}
          onDismissError={r.dismissSaveError}
        >
          <TextField
            id="chain-id"
            label="ID"
            mono
            value={r.draft.id ?? ""}
            error={r.fieldErrors.id}
            disabled={!r.isNew}
            onChange={(id) => r.setDraft({ ...r.draft!, id })}
            placeholder="chain-multi"
            autoFocus={r.isNew}
          />
          <StringList
            id="chain-layers"
            label="Layers (in order)"
            placeholder="pool or outbound id"
            hint="Each layer is a pool id or a single outbound server's id; when an id matches both, the pool wins."
            mono
            ordered
            values={r.draft.layers ?? []}
            onChange={(layers) => r.setDraft({ ...r.draft!, layers })}
          />
          {r.fieldErrors.layers !== undefined && (
            <Notice>Add at least one layer — an empty chain routes nothing.</Notice>
          )}
        </FormCard>
      )}

      <div className="filter-bar">
        <SearchInput
          id="chain-filter"
          value={filter}
          onChange={setFilter}
          placeholder="Filter by id or layer…"
        />
        <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
          {items.length} of {r.items.length}
        </span>
      </div>

      <div className="card">
        <DataTable
          caption="Chains"
          columns={columns}
          rows={items}
          rowKey={(c) => c.id ?? ""}
          loading={r.loading}
          error={r.error}
          onRetry={r.reload}
          empty={
            r.items.length === 0 ? (
              <EmptyState
                title="No chains configured"
                hint="Chains stack pools and servers into multi-hop routes."
                action={
                  <button type="button" className="primary" onClick={r.startCreate}>
                    New chain
                  </button>
                }
              />
            ) : (
              <EmptyState title="No chains match" hint={`Nothing matches “${filter}”.`} />
            )
          }
        />
      </div>

      <ChainProbesCard />
    </>
  );
}
