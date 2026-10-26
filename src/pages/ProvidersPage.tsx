// src/pages/ProvidersPage.tsx — CRUD over dynamic outbound providers, with a
// subscription-link quick-create form (the common case: paste a URL, get a
// managed pool of proxies). One provider can feed several pools (pool_ids);
// each plugin gets a detailed inline example while you configure it.

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useResource } from "../useResource";
import { collect, httpUrl, required, upstreamRoute } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { SearchInput, matches } from "../components/SearchInput";
import { SelectField, TextField } from "../components/fields";
import { KvEditor } from "../components/KvEditor";
import { StringList } from "../components/StringList";
import type { ProviderSpec } from "@goose-network/goose-sdk";

const PLUGINS = ["subscription", "psiphon", "mihomo", "singbox"] as const;
type Plugin = (typeof PLUGINS)[number];

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
      pool_ids: [],
      config: { url: "" },
      upstream_proxy: "",
    }),
    normalize: (p) => ({ ...p, pool_ids: p.pool_ids ?? [], config: { ...(p.config ?? {}) } }),
    noun: "provider",
    validate: (d) =>
      collect({
        id: required(d.id, "An ID is required"),
        url:
          d.provider === "subscription" || d.provider === "mihomo" || d.provider === "singbox"
            ? httpUrl(
                typeof d.config?.url === "string" ? d.config.url : "",
                "This plugin needs an http(s) subscription URL",
              )
            : null,
        upstream: upstreamRoute(
          d.upstream_proxy,
          "Route is empty, “direct”, “access”, “outbound:<id>”, “pool:<id>”, or a bare pool/outbound id",
        ),
      }),
  });

  const items = useMemo(
    () =>
      r.items.filter((p) =>
        matches(
          `${p.id ?? ""} ${p.provider ?? ""} ${(p.pool_ids ?? []).join(" ")} ${urlOf(p)} ${p.upstream_proxy ?? ""}`,
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
    {
      key: "pools",
      header: "Pools",
      className: "mono",
      render: (p) =>
        (p.pool_ids ?? []).join(", ") ||
        (p as { pool_id?: string }).pool_id ||
        "default",
    },
    {
      key: "config",
      header: "Subscription URL",
      className: "mono ellipsis",
      render: (p) => (
        <span title={urlOf(p)}>{urlOf(p) || (p.provider === "psiphon" ? "default config" : "—")}</span>
      ),
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
        sub="Dynamic outbound sources. A provider fetches its own proxy list and feeds one or more managed pools; the engine keeps them in sync without a restart."
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
                hint="Paste a subscription URL to import a managed pool of proxies — or add the psiphon provider, which needs no config at all."
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
  const plugin = (draft.provider ?? "subscription") as Plugin;

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
          onChange={(provider) => set({ provider: provider as Plugin })}
        />
      </div>
      <div className="row">
        <StringList
          id="prov-pools"
          label="Pool IDs"
          values={draft.pool_ids ?? []}
          placeholder="my-pool (blank = “default”)"
          onChange={(pool_ids) => set({ pool_ids })}
          mono
          addLabel="Add pool"
          hint="Every pool listed receives the provider’s full outbound set — one subscription can feed both a “fast” and a “fallback” pool. Blank list = the “default” pool."
        />
        <TextField
          id="prov-prefix"
          label="ID prefix"
          mono
          value={typeof cfg.prefix === "string" ? cfg.prefix : ""}
          placeholder={`${plugin === "subscription" ? "sub" : plugin} (optional)`}
          onChange={(prefix) =>
            prefix === "" ? setCfg({ url: cfg.url }) : setCfg({ ...cfg, prefix })
          }
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
          placeholder={EXAMPLES[plugin].urlPlaceholder}
          onChange={(url) => setCfg({ ...cfg, url })}
        />
        <TextField
          id="prov-upstream"
          label="Upstream proxy"
          mono
          value={draft.upstream_proxy ?? ""}
          error={fieldErrors.upstream}
          placeholder="pool:relays (optional)"
          onChange={(upstream_proxy) =>
            set({ upstream_proxy: upstream_proxy.trim() })
          }
          hint="Routes this provider's own URL fetches through an engine route instead of the engine host's network — for subscription URLs the host cannot reach directly. One of: outbound:<id>, pool:<id>, a bare pool/outbound id, or “access” (dial direct first, then the access pool). Blank = direct."
        />
      </div>
      <PluginHelp plugin={plugin} />
      <KvEditor
        id="prov-extra"
        label="Extra config (advanced)"
        value={cfg}
        onChange={setCfg}
      />
    </>
  );
}

// Per-plugin guidance shown inline while configuring, so a user never has to
// leave the form to learn what the plugin expects. This is goal #3: detailed
// examples at the moment of configuration.
interface PluginHelpInfo {
  urlPlaceholder: string;
  title: string;
  paragraphs: string[];
  example: { label: string; config: Record<string, unknown>; poolIds?: string[] };
}

const EXAMPLES: Record<Plugin, PluginHelpInfo> = {
  subscription: {
    urlPlaceholder: "https://example.com/sub",
    title: "subscription — generic subscription link",
    paragraphs: [
      "Fetches a remote proxy list over HTTP and re-fetches it on refresh. The body may be Clash YAML (proxies:), a base64-encoded V2Ray link list (vmess://…), or a plain link list — the format is auto-detected.",
      "The URL is required; every other field is optional. Outbound IDs are generated from the prefix and each proxy’s server:port. When the URL is unreachable from the engine host (e.g. behind a firewall), set Upstream proxy to fetch it through an engine outbound or pool.",
    ],
    example: {
      label: "Example: one subscription feeding two pools",
      poolIds: ["fast", "fallback"],
      config: {
        url: "https://example.com/clash-sub",
        prefix: "sub",
      },
    },
  },
  psiphon: {
    urlPlaceholder: "(no config needed — leave blank)",
    title: "psiphon — Psiphon circumvention network",
    paragraphs: [
      "Runs with zero configuration: leave every field empty and the provider connects to the production Psiphon network, auto-downloads the signed server list, and exposes one socks5 outbound that rides real Psiphon tunnels. The engine starts using it as soon as the tunnel establishes (typically seconds to a minute).",
      "Only set fields to customize: config_path points at a real psiphon.config (for a custom Psiphon network), upstream_proxy routes tunnel-core through another proxy (e.g. socks5://127.0.0.1:7890) when direct 443 is blocked, establish_timeout_seconds (default 120) bounds how long to wait for the first tunnel, and data_dir relocates the server-list datastore.",
    ],
    example: {
      label: "Example: out-of-the-box (empty config)",
      poolIds: ["psiphon-pool"],
      config: {},
    },
  },
  mihomo: {
    urlPlaceholder: "https://example.com/clash-sub",
    title: "mihomo — Clash/mihomo subscription",
    paragraphs: [
      "Parses a Clash (mihomo) YAML subscription (proxies:) or a V2Ray link list and turns each node into an outbound using the bundled mihomo core — so protocols like ss, vmess, trojan, vless and hysteria2 work natively.",
      "There is no default provider for this plugin: it cannot work without your external subscription URL, because the proxy credentials live in the link you paste. Everything else is optional: prefix (default “mihomo”) names the generated outbound IDs.",
    ],
    example: {
      label: "Example: Clash subscription",
      poolIds: ["clash"],
      config: {
        url: "https://example.com/clash-sub",
        prefix: "clash",
      },
    },
  },
  singbox: {
    urlPlaceholder: "https://example.com/sub (clash YAML, v2ray links, or sing-box JSON)",
    title: "singbox — sing-box subscription",
    paragraphs: [
      "Parses three subscription dialects: Clash YAML (proxies:), a base64/plain V2Ray link list, and native sing-box JSON (outbounds:). Each node becomes an outbound built by the embedded sing-box core — protocols include ss, vmess, vless, trojan, hysteria2, tuic and wireguard.",
      "Like mihomo, there is no default provider: the node credentials live in your external subscription URL, so the URL is required. prefix (default “singbox”) names the generated outbound IDs.",
    ],
    example: {
      label: "Example: sing-box JSON subscription",
      poolIds: ["sb"],
      config: {
        url: "https://example.com/singbox.json",
        prefix: "sb",
      },
    },
  },
};

function PluginHelp({ plugin }: { plugin: Plugin }) {
  const info = EXAMPLES[plugin];
  return (
    <div className="field">
      <label>{info.title}</label>
      <div className="hint" style={{ display: "block", whiteSpace: "normal", marginBottom: 6 }}>
        {info.paragraphs.map((p, i) => (
          <p key={i} style={{ margin: "0 0 6px 0" }}>
            {p}
          </p>
        ))}
      </div>
      <div>
        <div className="hint" style={{ display: "block", margin: 0 }}>
          {info.example.label}:
        </div>
        <pre
          className="mono"
          style={{
            margin: "4px 0 0 0",
            padding: "8px 10px",
            background: "var(--bg-inset, #f5f5f5)",
            borderRadius: 6,
            overflowX: "auto",
            fontSize: "0.85em",
          }}
        >
{JSON.stringify(
  {
    id: "my-provider",
    provider: plugin,
    pool_ids: info.example.poolIds ?? ["default"],
    config: info.example.config,
  },
  null,
  2,
)}
        </pre>
      </div>
    </div>
  );
}
