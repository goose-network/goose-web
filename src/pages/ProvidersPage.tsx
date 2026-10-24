// src/pages/ProvidersPage.tsx — CRUD over dynamic outbound providers, with a
// subscription-link quick-create form (the common case: paste a URL, get a
// managed pool of proxies).

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useResource } from "../useResource";
import { collect, httpUrl, required } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { SearchInput, matches } from "../components/SearchInput";
import { SelectField, TextField } from "../components/fields";
import { KvEditor } from "../components/KvEditor";
import type { ProviderSpec } from "@goose-network/goose-sdk";

const PLUGINS = ["subscription", "psiphon", "mihomo", "singbox"] as const;

export function ProvidersPage() {
  const { goose } = useSdk();
  const [filter, setFilter] = useState("");

  const r = useResource<ProviderSpec>({
    api: {
      list: () => goose.listProviders(),
      save: (d) => goose.createProvider(d),
      remove: (id) => goose.deleteProvider(id),
    },
    deps: [goose],
    idOf: (p) => p.id ?? "",
    blank: () => ({
      id: "",
      provider: "subscription",
      pool_id: "",
      config: { url: "" },
    }),
    normalize: (p) => ({ ...p, config: { ...(p.config ?? {}) } }),
    noun: "provider",
    validate: (d) =>
      collect({
        id: required(d.id, "An ID is required"),
        url:
          d.provider === "subscription"
            ? httpUrl(
                typeof d.config?.url === "string" ? d.config.url : "",
                "A subscription needs an http(s) URL",
              )
            : null,
      }),
  });

  const items = useMemo(
    () =>
      r.items.filter((p) =>
        matches(
          `${p.id ?? ""} ${p.provider ?? ""} ${p.pool_id ?? ""} ${urlOf(p)}`,
          filter,
        ),
      ),
    [r.items, filter],
  );

  const columns: Array<Column<ProviderSpec>> = [
    { key: "id", header: "ID", className: "mono", render: (p) => p.id },
    {
      key: "plugin",
      header: "Plugin",
      render: (p) => <span className="pill">{p.provider ?? ""}</span>,
    },
    { key: "pool", header: "Pool", className: "mono", render: (p) => p.pool_id || "default" },
    {
      key: "config",
      header: "Subscription URL",
      className: "mono ellipsis",
      render: (p) => <span title={urlOf(p)}>{urlOf(p) || "—"}</span>,
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
        title="Providers"
        sub="Dynamic outbound sources. A provider fetches its own proxy list and feeds a managed pool; the engine keeps the pool in sync without a restart."
        actions={
          <button type="button" className="primary" onClick={r.startCreate}>
            New provider
          </button>
        }
      />

      {r.draft !== null && (
        <FormCard
          title={r.isNew ? "New provider" : `Edit ${r.idOf(r.draft)}`}
          onSave={() => void r.save()}
          onCancel={r.cancel}
          saving={r.saving}
          dirty
          error={r.saveError}
          onDismissError={r.dismissSaveError}
        >
          <ProviderForm
            draft={r.draft}
            setDraft={r.setDraft}
            fieldErrors={r.fieldErrors}
            idLocked={!r.isNew}
          />
        </FormCard>
      )}

      <div className="filter-bar">
        <SearchInput
          id="provider-filter"
          value={filter}
          onChange={setFilter}
          placeholder="Filter by id, plugin, pool, url…"
        />
        <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
          {items.length} of {r.items.length}
        </span>
      </div>

      <div className="card">
        <DataTable
          caption="Dynamic outbound providers"
          columns={columns}
          rows={items}
          rowKey={(p) => p.id ?? ""}
          loading={r.loading}
          error={r.error}
          onRetry={r.reload}
          empty={
            r.items.length === 0 ? (
              <EmptyState
                title="No providers configured"
                hint="Paste a subscription URL to import a managed pool of proxies."
                action={
                  <button type="button" className="primary" onClick={r.startCreate}>
                    New provider
                  </button>
                }
              />
            ) : (
              <EmptyState title="No providers match" hint={`Nothing matches “${filter}”.`} />
            )
          }
        />
      </div>
    </>
  );
}

function urlOf(p: ProviderSpec): string {
  const u = p.config?.url;
  return typeof u === "string" ? u : "";
}

function ProviderForm({
  draft,
  setDraft,
  fieldErrors,
  idLocked,
}: {
  draft: ProviderSpec;
  setDraft: (d: ProviderSpec) => void;
  fieldErrors: Record<string, string>;
  idLocked: boolean;
}) {
  const set = (patch: Partial<ProviderSpec>) => setDraft({ ...draft, ...patch });
  const cfg = draft.config ?? {};
  const setCfg = (next: Record<string, unknown>) => set({ config: next });

  return (
    <>
      <div className="row">
        <TextField
          id="prov-id"
          label="ID"
          mono
          value={draft.id ?? ""}
          error={fieldErrors.id}
          disabled={idLocked}
          onChange={(id) => set({ id })}
          placeholder="sub-main"
          autoFocus={!idLocked}
        />
        <SelectField
          id="prov-plugin"
          label="Plugin"
          value={draft.provider ?? "subscription"}
          options={[...PLUGINS]}
          onChange={(provider) => set({ provider })}
        />
        <TextField
          id="prov-pool"
          label="Pool ID"
          mono
          value={draft.pool_id ?? ""}
          placeholder="defaults to the “default” pool"
          onChange={(pool_id) => set({ pool_id })}
        />
      </div>
      <div className="row">
        <TextField
          id="prov-url"
          label="Subscription URL"
          mono
          type="url"
          value={typeof cfg.url === "string" ? cfg.url : ""}
          error={fieldErrors.url}
          placeholder="https://example.com/sub"
          onChange={(url) => setCfg({ ...cfg, url })}
        />
        <TextField
          id="prov-prefix"
          label="ID prefix"
          mono
          value={typeof cfg.prefix === "string" ? cfg.prefix : ""}
          placeholder="sub (optional)"
          onChange={(prefix) =>
            prefix === "" ? setCfg({ url: cfg.url }) : setCfg({ ...cfg, prefix })
          }
        />
      </div>
      <KvEditor
        id="prov-extra"
        label="Extra config (advanced)"
        value={cfg}
        onChange={setCfg}
      />
    </>
  );
}
