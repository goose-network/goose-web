// src/pages/ProvidersPage.tsx — CRUD over dynamic outbound providers, with a
// subscription-link quick-create form (the common case: paste a URL, get a
// managed pool of proxies). One provider can feed several pools (pool_ids);
// each plugin gets a detailed inline example while you configure it.

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
import { useResource } from "../useResource";
import { collect, httpUrl, required, upstreamRoute } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { SearchInput, matches } from "../components/SearchInput";
import { SelectField, TextField } from "../components/fields";
import { KvEditor } from "../components/KvEditor";
import { StringList, type OptionGroup } from "../components/StringList";
import { FilterSelect, routeMetrics, type RouteMetric } from "../components/FilterSelect";
import { listProbeResults, type HTTPProbe } from "../runApi";
import { ProvidersStatusCard } from "./ProvidersStatusCard";
import type { ProviderSpec } from "@goose-network/goose-sdk";

// Plugins offered in the dropdown. The engine is plugin-agnostic and can
// surface others (auto-seeded zero-config providers, external plugins); the
// form renders any plugin name through pluginHelp's fallback rather than
// crashing on a key it does not know.
const PLUGINS = ["subscription", "psiphon", "geph", "tor", "openrung", "mihomo", "singbox"] as const;

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

  // The upstream-route picker offers the engine's pools and outbounds (as
  // explicit pool:/outbound: refs) plus the special routes, so the form needs
  // those lists alongside its own resource. The probe history rides along to
  // annotate each route with how it last answered; a failed fetch leaves a
  // plain keyword filter, and the picker still allows any typed route.
  const catalog = useAsync(
    () =>
      Promise.all([
        goose.listPools(),
        goose.listOutbounds(),
        // Keep whether the probe fetch succeeded: a failed or absent probe
        // endpoint must leave the picker a plain keyword filter, not label
        // every route "unprobed" (which reads as "the whole fleet is dead").
        listProbeResults(goose, { n: 500 })
          .then((rows) => ({ rows, ok: true }))
          .catch(() => ({ rows: [] as HTTPProbe[], ok: false })),
      ]),
    [goose],
  );
  const upstreamGroups = useMemo(
    () =>
      upstreamOptions(
        (catalog.data?.[0] ?? []).map((p) => p.id),
        (catalog.data?.[1] ?? []).map((o) => o.id),
        r.draft?.upstream_proxy ?? "",
      ),
    [catalog.data, r.draft],
  );
  const probeResult = catalog.data?.[2];
  // Metrics only when the probe fetch succeeded and verdicted at least one
  // route; otherwise the picker stays a plain keyword filter (allowCustom still
  // lets any route be typed). An empty map would pill everything "unprobed".
  const upstreamMetrics = useMemo(() => {
    if (!probeResult?.ok) return undefined;
    const m = routeMetrics(probeResult.rows);
    return m.size > 0 ? m : undefined;
  }, [probeResult]);

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

      <ProvidersStatusCard />

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
            upstreamGroups={upstreamGroups}
            upstreamMetrics={upstreamMetrics}
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

/**
 * upstreamOptions builds the upstream-route picker's choices: the special
 * routes the engine knows by name, then every pool and outbound as an explicit
 * prefixed reference, then the stored value if it names none of them.
 *
 * Unlike a chain layer (a BARE id resolved pool-first), an upstream route spells
 * its kind — "pool:x" and "outbound:x" are distinct routes even when one id names
 * both — so neither list shadows the other. The empty choice (blank = direct) is
 * the picker's placeholder, not a group entry. A stored value the engine no
 * longer knows keeps an option so editing the provider never blanks its route;
 * `allowCustom` on the picker still lets the reader type any other route.
 */
export function upstreamOptions(
  poolIds: ReadonlyArray<string | undefined>,
  outboundIds: ReadonlyArray<string | undefined>,
  current: string,
): OptionGroup[] {
  const ids = (list: ReadonlyArray<string | undefined>) =>
    [...new Set(list.filter((id): id is string => id !== undefined && id !== ""))].sort();
  const pools = ids(poolIds);
  const outbounds = ids(outboundIds);
  const groups: OptionGroup[] = [
    {
      label: "Special",
      options: [
        { value: "direct", label: "direct — the engine host's network" },
        { value: "access", label: "access — dial direct first, then the access pool" },
      ],
    },
  ];
  if (pools.length > 0) {
    groups.push({ label: "Pools", options: pools.map((id) => ({ value: `pool:${id}`, label: `pool:${id}` })) });
  }
  if (outbounds.length > 0) {
    groups.push({
      label: "Outbounds",
      options: outbounds.map((id) => ({ value: `outbound:${id}`, label: `outbound:${id}` })),
    });
  }
  const known = new Set<string>([
    "direct",
    "access",
    ...pools.map((id) => `pool:${id}`),
    ...outbounds.map((id) => `outbound:${id}`),
  ]);
  if (current !== "" && !known.has(current)) {
    groups.push({ label: "Current", options: [{ value: current, label: current }] });
  }
  return groups;
}

function ProviderForm({
  draft,
  setDraft,
  fieldErrors,
  idLocked,
  upstreamGroups,
  upstreamMetrics,
}: {
  draft: ProviderSpec;
  setDraft: (d: ProviderSpec) => void;
  fieldErrors: Record<string, string>;
  idLocked: boolean;
  upstreamGroups: OptionGroup[];
  upstreamMetrics: ReadonlyMap<string, RouteMetric> | undefined;
}) {
  const set = (patch: Partial<ProviderSpec>) => setDraft({ ...draft, ...patch });
  const cfg = draft.config ?? {};
  const setCfg = (next: Record<string, unknown>) => set({ config: next });
  const plugin = draft.provider ?? "subscription";
  const help = pluginHelp(plugin);
  // Keep the current plugin selectable even when it is not a built-in option,
  // so editing an external provider shows its real plugin instead of a blank.
  const pluginOptions: string[] = (PLUGINS as readonly string[]).includes(plugin)
    ? [...PLUGINS]
    : [...PLUGINS, plugin];

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
          value={plugin}
          options={pluginOptions}
          onChange={(provider) => set({ provider })}
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
          onChange={(prefix) => setCfg(withPrefix(cfg, prefix))}
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
          placeholder={help.urlPlaceholder}
          onChange={(url) => setCfg({ ...cfg, url })}
        />
        <FilterSelect
          id="prov-upstream"
          label="Upstream proxy"
          mono
          value={draft.upstream_proxy ?? ""}
          error={fieldErrors.upstream}
          placeholder="(direct — blank)"
          groups={upstreamGroups}
          metrics={upstreamMetrics}
          allowCustom
          onChange={(upstream_proxy) =>
            set({ upstream_proxy: upstream_proxy.trim() })
          }
          hint="Routes this provider's own proxy-list fetches (a subscription URL, server list or directory) through an engine route instead of the engine host's network — for lists the host cannot reach directly. The outbounds' own tunnel and relay dials never ride it. Pick a route below, or type one: outbound:<id>, pool:<id>, a bare pool/outbound id, or “access” (dial direct first, then the access pool). Blank = direct."
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

const EXAMPLES: Record<string, PluginHelpInfo> = {
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
      "Runs with zero configuration: leave every field empty and the provider connects to the production Psiphon network, auto-downloads the signed server list, and feeds one outbound per real Psiphon server — IP, region, protocols — so the Outbounds page shows the actual server list and each server can be pooled, pinned, or filtered individually. The general tunnel, where Psiphon itself picks the exit server per connection, keeps running underneath but is deliberately not listed as an outbound: no single address says where its traffic would exit.",
      "Dials run in memory through the engine's network stack: no local SOCKS or HTTP proxy is involved, and the tunnels' own connections to their Psiphon servers go through the engine's configured stack. Per-server outbounds appear as soon as the server list lands (typically seconds to a minute after the tunnel establishes); a hand-written “psiphon” outbound with no server pinned still dials through the general tunnel.",
      "Only set fields to customize: config_path points at a real psiphon.config (for a custom Psiphon network), server_list_path seeds the datastore from a server_list.dat, upstream_proxy routes only the server-list fetch through another proxy (e.g. socks5://127.0.0.1:7890) when direct access is blocked (the tunnels' own dials never ride it — they go through the engine's stack), establish_timeout_seconds (default 120) bounds how long a dial waits for a tunnel, and data_dir relocates the server-list datastore.",
    ],
    example: {
      label: "Example: out-of-the-box (empty config)",
      poolIds: ["psiphon-pool"],
      config: {},
    },
  },
  geph: {
    urlPlaceholder: "(no config needed — leave blank)",
    title: "geph — Geph circumvention network",
    paragraphs: [
      "Runs with zero configuration: leave every field empty and the provider connects to the Geph network through its embedded broker fronts and advertises the live exit roster — one outbound per exit node — so the Outbounds page shows the real exits and each can be pooled, pinned, or filtered. No subscription URL is involved.",
      "Only set fields to customize: outbound_id (default “geph”) names the general outbound and prefixes the per-exit IDs; username/password or credentials select a custom Geph exit; config_path points at a geph5 config; cache relocates the broker/exit cache. The general “geph” outbound rides a live circuit, while the per-exit list represents the discovered exits.",
    ],
    example: {
      label: "Example: out-of-the-box (empty config)",
      poolIds: ["geph-pool"],
      config: {},
    },
  },
  tor: {
    urlPlaceholder: "(no config needed — leave blank)",
    title: "tor — Tor anonymity network",
    paragraphs: [
      "Runs with zero configuration: leave every field empty and the provider bootstraps a Tor circuit from the embedded directory authorities and advertises the exit roster — one outbound per exit relay (named <id>-<nickname>-<digest>-<ip:port>) — so the Outbounds page shows the real exits. The general “tor” outbound rides a live circuit and appears once the guard link is up; no subscription URL is involved.",
      "Only set fields to customize: outbound_id (default “tor”) names the general outbound and prefixes the per-exit IDs; upstream_proxy routes only the directory fetch through another proxy when direct access is blocked — circuit and exit dials ride the engine's stack, never the upstream; verify_signatures (default on) checks the consensus; path_len, allow_private_addresses and the timeout knobs tune circuit building.",
    ],
    example: {
      label: "Example: out-of-the-box (empty config)",
      poolIds: ["tor-pool"],
      config: {},
    },
  },
  openrung: {
    urlPlaceholder: "(no config needed — leave blank)",
    title: "openrung — OpenRung relay network",
    paragraphs: [
      "Runs with zero configuration: leave every field empty and the provider fetches the Ed25519-signed relay directory through the built-in broker fronts (Cloudflare → CloudFront → Azure, raced) and emits one mihomo-vless outbound per usable relay (VLESS + REALITY + Vision). No subscription URL is involved.",
      "Only set fields to customize: limit caps the directory page size (the broker serves a random slice, so 20+ fetches the full rotation); prefix (default “openrung”) names the outbound IDs; broker_url overrides the broker; upstream_proxy routes broker traffic only — relay dials stay direct, because a REALITY ClientHello carries its camouflage SNI as the dial address and a TLS-sniffing forwarder would re-target it.",
    ],
    example: {
      label: "Example: out-of-the-box (empty config)",
      poolIds: ["openrung-pool"],
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

// FALLBACK_HELP renders for any plugin without a tailored entry — an external
// or newly-linked provider. The form must never crash on an unknown plugin
// name (the engine is plugin-agnostic), so pluginHelp always returns a value.
const FALLBACK_HELP: PluginHelpInfo = {
  urlPlaceholder: "(plugin-specific — see its documentation)",
  title: "provider plugin",
  paragraphs: [
    "This plugin retrieves its own proxy list and feeds the pools you assign. If it is zero-config, leave every field empty and it connects to its network out of the box; otherwise set the fields its documentation describes under “Extra config (advanced)” below.",
  ],
  example: { label: "Example: empty config", config: {} },
};

// pluginHelp returns the tailored guidance for a plugin, or the generic
// fallback for any name without an entry. It never returns undefined:
// indexing EXAMPLES directly with an unknown plugin (e.g. an auto-seeded
// geph/tor/openrung provider) used to throw and white-screen the edit form.
export function pluginHelp(plugin: string | undefined): PluginHelpInfo {
  const key = plugin ?? "";
  // Own-property check: a plain object literal inherits Object.prototype, so
  // EXAMPLES["constructor"] / ["toString"] would return truthy prototype
  // members and slip past a bare `?? FALLBACK_HELP`, crashing the render on
  // info.paragraphs. Only a real entry counts; every other name — unknown
  // plugin or prototype collision — gets the generic fallback.
  const own = Object.prototype.hasOwnProperty.call(EXAMPLES, key) ? EXAMPLES[key] : undefined;
  return own ?? FALLBACK_HELP;
}

// withPrefix sets the optional outbound-id prefix on a config map, or removes
// just that key when cleared. Every other field survives: clearing the prefix
// used to replace the whole config with {url}, silently dropping credentials,
// limit, broker_url and the rest on save.
export function withPrefix(
  cfg: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const next = { ...cfg };
  if (prefix === "") delete next.prefix;
  else next.prefix = prefix;
  return next;
}

function PluginHelp({ plugin }: { plugin: string }) {
  const info = pluginHelp(plugin);
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
          className="mono json-sample"
          style={{
            margin: "4px 0 0 0",
            padding: "8px 10px",
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
