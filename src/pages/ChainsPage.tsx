// src/pages/ChainsPage.tsx — CRUD over chains (ordered pool/server layers).

import { useMemo, useState } from "react";
import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
import { useResource } from "../useResource";
import { collect, required } from "../validate";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { Notice } from "../components/Notice";
import { SearchInput, matches } from "../components/SearchInput";
import { TextField } from "../components/fields";
import { StringList, type OptionGroup } from "../components/StringList";
import { routeMetrics, type RouteMetric } from "../components/FilterSelect";
import { listProbeResults, type HTTPProbe } from "../runApi";
import type { ChainSpec } from "@goose-network/goose-sdk";

/** What the engine resolves each layer against: its pools first, then its
 *  outbounds. Kept as a string so the form can say it once, whether the layers
 *  are a picker or (while the lists load) the text input they used to be. */
const LAYERS_RULE =
  "Each layer is a pool id or a single outbound server's id; when an id matches both, the pool wins.";

/**
 * layerOptions builds the layer picker's choices from what the engine has
 * configured, plus the layers the draft already holds.
 *
 * A layer is a BARE id, so the groups carry the half the value cannot: the
 * reader picks "relay-9" and the label says whether that names a pool or an
 * outbound. Both groups are sorted, because the lists come back in config
 * order and a picker is scanned, not searched.
 *
 * Two cases decide correctness rather than looks:
 *
 *  - An id naming both a pool and an outbound appears under Pools only. The
 *    engine resolves it to the pool, so offering it twice would offer a choice
 *    that does not exist — and two options sharing a value is a select the
 *    browser resolves to the first, silently.
 *  - A stored id that is no longer configured (a deleted outbound, or a list
 *    this page could not fetch) still gets an option, labelled as unconfigured,
 *    whose value is the bare id. A select whose value matches no option renders
 *    blank, so dropping it here would blank the layer in the form and store a
 *    chain with that hop missing on the next save.
 */
export function layerOptions(
  poolIds: ReadonlyArray<string | undefined>,
  outboundIds: ReadonlyArray<string | undefined>,
  current: ReadonlyArray<string>,
): OptionGroup[] {
  const ids = (list: ReadonlyArray<string | undefined>) =>
    [...new Set(list.filter((id): id is string => id !== undefined && id !== ""))].sort();
  const pools = ids(poolIds);
  const outbounds = ids(outboundIds);
  const poolSet = new Set(pools);
  // An outbound whose id is also a pool's is shadowed by that pool, so it is
  // not a choice the reader can make — leave it out rather than label it.
  const outboundsOnly = outbounds.filter((id) => !poolSet.has(id));
  // Current layers, in the order the chain traverses them, minus the ones a
  // group above already offers and the blank row a fresh "Add layer" makes.
  const unconfigured = [
    ...new Set(
      current.filter(
        (v) => v !== "" && !poolSet.has(v) && !outbounds.includes(v),
      ),
    ),
  ];

  const group = (
    label: string,
    values: readonly string[],
    text: (v: string) => string,
  ): OptionGroup[] =>
    values.length === 0 ? [] : [{ label, options: values.map((v) => ({ value: v, label: text(v) })) }];

  return [
    ...group("Pools", pools, (v) => v),
    ...group("Outbounds", outboundsOnly, (v) => v),
    ...group("Not configured", unconfigured, (v) => `${v} (not configured)`),
  ];
}

/**
 * layerMetrics keys the probe verdicts by the BARE id a layer stores, so the
 * picker can annotate and filter each choice by how its route last answered.
 *
 * A layer resolves pool-first (see layerOptions), so an id that names both a
 * pool and an outbound takes the pool's verdict — the outbound's would describe
 * a route the bare id cannot reach. Ids with no probe row are left absent, which
 * the picker reads as "unprobed", not "failed".
 */
export function layerMetrics(
  poolIds: ReadonlyArray<string | undefined>,
  outboundIds: ReadonlyArray<string | undefined>,
  byRoute: ReadonlyMap<string, RouteMetric>,
): Map<string, RouteMetric> {
  const out = new Map<string, RouteMetric>();
  const pools = new Set<string>();
  for (const id of poolIds) {
    if (id === undefined || id === "") continue;
    pools.add(id);
    const m = byRoute.get(`pool:${id}`);
    if (m !== undefined) out.set(id, m);
  }
  for (const id of outboundIds) {
    if (id === undefined || id === "" || pools.has(id)) continue;
    const m = byRoute.get(`outbound:${id}`);
    if (m !== undefined) out.set(id, m);
  }
  return out;
}

/** Why a chain's layers block a save, as a token rather than prose: whatever
 *  `validate` returns lands in fieldErrors verbatim, and the form compares the
 *  stored value to choose its message — "layers" shows the "Add at least one
 *  layer…" Notice, "blank-layer" the "A layer was left unchosen…" one. */
export type ChainLayerProblem = "layers" | "blank-layer";

/**
 * chainLayerProblem checks a draft's layers and returns the token that blocks
 * the save, or null when the save may go through.
 *
 * An empty list routes nothing. A row left unchosen (the picker's "Add layer"
 * starts blank) would store an id the engine resolves to nothing — unknown
 * refs are silently skipped (internal/router/router.go: "unknown references
 * are skipped; the chain keeps its order") — so both block the save here
 * instead of turning into a shorter chain on the server. Empty is answered
 * first: [] reports "layers", so the reader who removed every row gets the
 * Notice that tells them to add one, not the unchosen-row one.
 *
 * Whether a chosen id still resolves is deliberately not asked here: that is
 * layerOptions' job, which gives any id the engine no longer knows a
 * "(not configured)" option so the select does not render blank. Rejecting
 * such an id in the guard would block saves the engine may still route fine —
 * the catalog this page saw can be stale, or a list it could not fetch.
 */
export function chainLayerProblem(
  layers: ReadonlyArray<string> | undefined,
): ChainLayerProblem | null {
  if (layers === undefined || layers.length === 0) return "layers";
  return layers.some((l) => l.trim() === "") ? "blank-layer" : null;
}

export function ChainsPage() {
  const { goose } = useSdk();
  const [filter, setFilter] = useState("");

  // The layer picker offers the engine's pools and outbounds, so this page
  // needs both lists, not just its own resource. One Promise.all, as the probe
  // page does: the two arrive together, so the picker cannot offer a half-built
  // set of choices in between. The probe history rides along so each choice can
  // say how its route last answered — the reader filters a long fleet by what
  // works, not just by what an id contains. A failed probe fetch leaves the
  // picker a plain keyword filter (no metrics), never blocks the choices.
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
  const poolIds = useMemo(
    () => (catalog.data?.[0] ?? []).map((p) => p.id),
    [catalog.data],
  );
  const outboundIds = useMemo(
    () => (catalog.data?.[1] ?? []).map((o) => o.id),
    [catalog.data],
  );
  const probeResult = catalog.data?.[2];
  const layerMetricMap = useMemo(
    () => layerMetrics(poolIds, outboundIds, routeMetrics(probeResult?.rows ?? [])),
    [poolIds, outboundIds, probeResult],
  );
  // The engine's own choices, before any draft joins them: empty exactly when
  // it has no pool or outbound to offer, which is when a picker would be a
  // dead end — only its placeholder, nothing to pick.
  const catalogGroups = useMemo(
    () => layerOptions(poolIds, outboundIds, []),
    [poolIds, outboundIds],
  );
  // A select with nothing to choose from is worse than the text input it
  // replaced, so the picker is used only once the lists have arrived and
  // offer something. While they load, when the fetch failed, or when the
  // engine has no pools or outbounds at all, the layers stay free text — and
  // the hint says which of those it is. (`catalog.data !== undefined` rather
  // than `!catalog.loading`: a background reload keeps the picker on the data
  // already in hand instead of flashing the rows back to text inputs.)
  const canPick =
    catalog.data !== undefined &&
    catalog.error === null &&
    catalogGroups.length > 0;
  const layersHint = catalog.error !== null
    ? `Could not list pools and outbounds (${catalog.error}), so layers are typed as free text. ${LAYERS_RULE}`
    : canPick
      ? LAYERS_RULE
      : catalog.loading
        ? `Loading pools and outbounds… — until they arrive, type the id. ${LAYERS_RULE}`
        : `No pools or outbounds are configured yet, so there is nothing to pick from; type the id. ${LAYERS_RULE}`;

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
        // A token, not prose: the form switches on it to choose between the
        // two layer Notices below. See chainLayerProblem.
        layers: chainLayerProblem(d.layers),
      }),
  });

  const items = useMemo(
    () =>
      r.items.filter((c) =>
        matches(`${c.id ?? ""} ${(c.layers ?? []).join(" ")}`, filter),
      ),
    [r.items, filter],
  );

  // The picker's groups plus whatever the open draft references that the
  // engine no longer knows, so editing a chain never blanks one of its layers.
  const layerGroups = useMemo(
    () => layerOptions(poolIds, outboundIds, r.draft?.layers ?? []),
    [poolIds, outboundIds, r.draft],
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
            placeholder={canPick ? "(choose a pool or outbound)" : "pool or outbound id"}
            addLabel="Add layer"
            hint={layersHint}
            mono
            ordered
            values={r.draft.layers ?? []}
            onChange={(layers) => r.setDraft({ ...r.draft!, layers })}
            // While the catalog is in flight (or missing, or empty) the rows
            // stay the text inputs they were: a select with no options would
            // show existing layers as blank and offer nothing to pick.
            options={canPick ? layerGroups : undefined}
            // Once there is something to pick, the rows become filterable:
            // type to narrow a long fleet, and filter/sort by probe result.
            // Metrics appear only when the probe fetch succeeded and actually
            // verdicted some offered route — a failed fetch (or none probed)
            // leaves a plain keyword filter rather than pilling everything
            // "unprobed".
            filterable={canPick}
            metrics={canPick && probeResult?.ok && layerMetricMap.size > 0 ? layerMetricMap : undefined}
          />
          {r.fieldErrors.layers === "layers" && (
            <Notice>Add at least one layer — an empty chain routes nothing.</Notice>
          )}
          {r.fieldErrors.layers === "blank-layer" && (
            <Notice>
              A layer was left unchosen — pick a pool or outbound for it, or
              remove the row. The engine silently skips ids it cannot resolve.
            </Notice>
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
    </>
  );
}
