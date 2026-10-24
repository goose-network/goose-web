// src/pages/OutboundsPage.tsx — CRUD over outbound proxy specs.

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useResource } from "../useResource";
import { collect, required } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { SearchInput, matches } from "../components/SearchInput";
import { SelectField, TextField } from "../components/fields";
import { KvEditor } from "../components/KvEditor";
import type { OutboundSpec } from "@goose-network/goose-sdk";

// Protocols registered by the engine's plugin set (include/register.go).
// mihomo-*/singbox-* outbounds are normally created by their provider
// plugins from a subscription, but manual creation stays possible.
const PROTOCOLS = [
  "direct",
  "http",
  "socks5",
  "psiphon",
  "mihomo-ss",
  "mihomo-vmess",
  "mihomo-vless",
  "mihomo-trojan",
  "mihomo-socks5",
  "mihomo-http",
  "singbox-socks",
  "singbox-http",
  "singbox-shadowsocks",
  "singbox-vmess",
  "singbox-vless",
  "singbox-trojan",
  "singbox-snell",
  "singbox-ssh",
  "singbox-anytls",
] as const;

export function OutboundsPage() {
  const { goose } = useSdk();
  const [filter, setFilter] = useState("");

  const r = useResource<OutboundSpec>({
    api: {
      list: () => goose.listOutbounds(),
      save: (d) => goose.createOutbound(d),
      remove: (id) => goose.deleteOutbound(id),
    },
    deps: [goose],
    idOf: (o) => o.id ?? "",
    blank: () => ({ id: "", protocol: "direct", config: {} }),
    normalize,
    noun: "outbound",
    validate: (d) => collect({ id: required(d.id, "An ID is required") }),
  });

  const items = useMemo(
    () =>
      r.items.filter((o) =>
        matches(`${o.id ?? ""} ${o.protocol ?? ""} ${summarize(o.config)}`, filter),
      ),
    [r.items, filter],
  );

  const columns: Array<Column<OutboundSpec>> = [
    { key: "id", header: "ID", className: "mono", render: (o) => o.id },
    {
      key: "protocol",
      header: "Protocol",
      render: (o) => <span className="pill">{o.protocol ?? ""}</span>,
    },
    {
      key: "config",
      header: "Config",
      className: "mono ellipsis",
      render: (o) => (
        <span title={summarize(o.config)}>{summarize(o.config)}</span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "actions",
      render: (o) => (
        <>
          <button type="button" className="ghost" onClick={() => r.startEdit(o)}>
            Edit
          </button>{" "}
          <ConfirmButton onConfirm={() => void r.remove(o)} title={`Delete ${o.id ?? ""}`} />
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Outbounds"
        sub="Proxy servers and providers the engine can dial through."
        actions={
          <button type="button" className="primary" onClick={r.startCreate}>
            New outbound
          </button>
        }
      />

      {r.draft !== null && (
        <FormCard
          title={r.isNew ? "New outbound" : `Edit ${r.idOf(r.draft)}`}
          onSave={() => void r.save()}
          onCancel={r.cancel}
          saving={r.saving}
          dirty
          error={r.saveError}
          onDismissError={r.dismissSaveError}
        >
          <div className="row">
            <TextField
              id="out-id"
              label="ID"
              mono
              value={r.draft.id ?? ""}
              error={r.fieldErrors.id}
              disabled={!r.isNew}
              onChange={(id) => r.setDraft({ ...r.draft!, id })}
              placeholder="relay-1"
              autoFocus={r.isNew}
            />
            <SelectField
              id="out-proto"
              label="Protocol"
              value={r.draft.protocol ?? "direct"}
              options={[...PROTOCOLS]}
              onChange={(protocol) => r.setDraft({ ...r.draft!, protocol })}
            />
          </div>
          <KvEditor
            id="out-config"
            label="Config (JSON)"
            value={r.draft.config}
            onChange={(config) => r.setDraft({ ...r.draft!, config })}
          />
        </FormCard>
      )}

      <div className="filter-bar">
        <SearchInput
          id="outbound-filter"
          value={filter}
          onChange={setFilter}
          placeholder="Filter by id, protocol, config…"
        />
        <span className="hint" style={{ margin: 0, alignSelf: "center" }}>
          {items.length} of {r.items.length}
        </span>
      </div>

      <div className="card">
        <DataTable
          caption="Outbound proxy specs"
          columns={columns}
          rows={items}
          rowKey={(o) => o.id ?? ""}
          loading={r.loading}
          error={r.error}
          onRetry={r.reload}
          empty={
            r.items.length === 0 ? (
              <EmptyState
                title="No outbounds configured"
                hint="Add one directly, or let a provider import a subscription."
                action={
                  <button type="button" className="primary" onClick={r.startCreate}>
                    New outbound
                  </button>
                }
              />
            ) : (
              <EmptyState title="No outbounds match" hint={`Nothing matches “${filter}”.`} />
            )
          }
        />
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
