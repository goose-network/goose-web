// src/pages/PoolsPage.tsx — CRUD over pools (outbound set + filters + selector).

import { useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
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
import {
  FILTERS,
  filterExample,
  SELECTORS,
  selectorExample,
} from "./poolExamples";
import type { Pool, FilterSpec } from "./poolTypes";
import {
  addProtocol,
  canSelectFilteredOutbounds,
  clearFilteredOutbounds,
  memberOptions,
  outboundHaystack,
  protocolChoices,
  protocolList,
  selectFilteredOutbounds,
  syncProtocolMembership,
  toggleOutbound,
  visibleOutbounds,
  withProtocolList,
  type OutboundChoice,
} from "./poolPicker";

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

  // The member picker offers the engine's configured outbounds, and the
  // protocol filter's chips are the protocols that fleet actually runs, so
  // this page needs the outbound list too — fetched once here, above the
  // form, the way the chain page fetches its layer catalog. A failed or
  // empty list degrades the form to the free-text id rows it used to be
  // (see canPick below), never blocks editing a pool.
  const catalog = useAsync(() => goose.listOutbounds(), [goose]);
  const outbounds = useMemo<OutboundChoice[]>(() => {
    const seen = new Set<string>();
    const out: OutboundChoice[] = [];
    for (const o of catalog.data ?? []) {
      const id = o?.id;
      if (id === undefined || id === "" || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, protocol: o?.protocol ?? "" });
    }
    // Sorted, because the list comes back in config order and a picker is
    // scanned, not searched (the chain page's layerOptions rule).
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }, [catalog.data]);
  // A picker with nothing to choose from is worse than the text input it
  // replaced, so it is used only once the list has arrived and offers
  // something. While it loads, when the fetch failed, or when the engine has
  // no outbounds at all, the member rows stay free text — and the hint says
  // which of those it is. (`catalog.data !== undefined` rather than
  // `!catalog.loading`: a background reload keeps the picker on the data
  // already in hand instead of flashing the rows back to text inputs.)
  const canPick =
    catalog.data !== undefined && catalog.error === null && outbounds.length > 0;
  const catalogHint =
    catalog.error !== null
      ? `Could not list outbounds (${catalog.error}), so ids are typed as free text.`
      : canPick
        ? undefined
        : catalog.loading
          ? "Loading outbounds… — until they arrive, type the id."
          : "No outbounds are configured yet, so there is nothing to pick from; type the id.";

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
      key: "chains",
      header: "Chains",
      render: (p) => {
        const ids = p.chain_ids ?? [];
        if (ids.length === 0) return "—";
        return (
          <span title={ids.join(", ")}>
            <span className="pill">{ids.length} chain{ids.length === 1 ? "" : "s"}</span>{" "}
            <span className="mono">{ids.slice(0, 2).join(", ")}</span>
            {ids.length > 2 ? ` +${ids.length - 2}` : ""}
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
          <PoolForm
            draft={r.draft}
            setDraft={r.setDraft}
            fieldErrors={r.fieldErrors}
            idLocked={!r.isNew}
            outbounds={outbounds}
            canPick={canPick}
            catalogHint={catalogHint}
          />
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
  outbounds,
  canPick,
  catalogHint,
}: {
  draft: Pool;
  setDraft: (p: Pool) => void;
  fieldErrors: Record<string, string>;
  idLocked: boolean;
  /** the engine's configured fleet, sorted by id; empty until it loads */
  outbounds: OutboundChoice[];
  /** the fleet arrived and offers something — the picker replaces free text */
  canPick: boolean;
  /** why the picker is unavailable, when it is (loading / failed / empty) */
  catalogHint: string | undefined;
}) {
  const set = (patch: Partial<Pool>) => setDraft({ ...draft, ...patch });
  const filters = draft.filters ?? [];
  const members = draft.outbound_ids ?? [];

  // The keyword filter over the fleet — the probe page's route-filter
  // behavior: type to narrow, then check chips one by one or commit exactly
  // what the filter matches with the batch controls.
  const [memberFilter, setMemberFilter] = useState("");
  const memberFilterRef = useRef<HTMLInputElement>(null);
  // The filter box only renders above twelve choices, but this state outlives
  // it (the form stays mounted across draft swaps and connection switches).
  // When the box unmounts, an old keyword would keep narrowing invisibly with
  // no way to reset it — so it goes with the box.
  const filterBoxShown = canPick && outbounds.length > 12;
  useEffect(() => {
    if (!filterBoxShown) setMemberFilter("");
  }, [filterBoxShown]);
  const shown = visibleOutbounds(outbounds, members, memberFilter);
  const narrowed = memberFilter.trim() !== "";

  // Unchecking a chip that was on screen only because it was checked (pinned
  // through the filter) drops its checkbox out of the DOM, and the keyboard
  // focus with it — hand the focus to the filter box so the reader keeps their
  // place (ChipPicker's toggle rule; without it the form's Esc guard also
  // stops firing, focus having fallen to body).
  const toggleMember = (id: string) => {
    const next = toggleOutbound(members, id);
    set({ outbound_ids: next });
    const protocol = outbounds.find((o) => o.id === id)?.protocol ?? "";
    const stillShown =
      matches(outboundHaystack({ id, protocol }), memberFilter) ||
      (next.length <= 12 && next.includes(id));
    if (memberFilter !== "" && !stillShown) memberFilterRef.current?.focus();
  };

  // The params each filter row had before its Type last changed, so flipping
  // away and back restores them (the old form kept params across switches)
  // instead of silently wiping a stored allowlist or latency cap. Keyed by
  // row index, like the rows themselves.
  const stashedParams = useRef(new Map<number, Record<string, unknown>>());

  // Every filter edit recomputes the member list, because the engine
  // AND-composes ALL of a pool's filters at dispatch: protocol coverage is
  // the intersection across rows (a second protocol filter that rejects a
  // protocol stops it being auto-included; emptying one row never releases a
  // member another row still names), and removing a protocol filter releases
  // what it covered just like emptying its allowlist does. The filters still
  // ride the pool and narrow at dispatch, so the materialized list and the
  // engine's admission agree.
  const setFilters = (next: FilterSpec[]) => {
    set({
      filters: next,
      outbound_ids: syncProtocolMembership(members, outbounds, filters, next),
    });
  };

  const setFilterParams = (i: number, params: Record<string, unknown>) => {
    const next = [...filters];
    next[i] = { ...next[i]!, params };
    setFilters(next);
  };

  const switchFilterType = (i: number, type: string) => {
    const old = filters[i]!;
    if ((old.type ?? "location") === type) return;
    const stash = stashedParams.current;
    const restored = stash.get(i);
    stash.set(i, old.params ?? {});
    const next = [...filters];
    // A stash only exists after a switch away, so the first switch starts the
    // new type clean and the switch back restores what it had.
    next[i] = { ...old, type, params: restored ?? {} };
    setFilters(next);
  };

  const removeFilter = (i: number) => {
    stashedParams.current.delete(i);
    setFilters(filters.filter((_, j) => j !== i));
  };

  const memberGroups = useMemo(
    () => memberOptions(outbounds, members),
    [outbounds, members],
  );

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

      <FieldGroup
        id="pool-outbounds"
        label="Outbounds"
        hint={
          canPick
            ? "Filter the fleet by keyword (id or protocol) and check chips — or select everything the filter matches in one click, the way the probe page picks routes. A protocol filter below includes its outbounds automatically. Members keep the order they were added; roundrobin cycles that order."
            : catalogHint
        }
      >
        {canPick && (
          <>
            <div className="chip-batch">
              {filterBoxShown && (
                <SearchInput
                  id="pool-outbound-filter"
                  value={memberFilter}
                  onChange={setMemberFilter}
                  inputRef={memberFilterRef}
                  placeholder="Filter by id or protocol…"
                />
              )}
              <button
                type="button"
                className="ghost"
                disabled={!canSelectFilteredOutbounds(outbounds, memberFilter)}
                title={
                  narrowed
                    ? "Check every outbound the filter matches — adds to the pool, keeping the order of the members already there."
                    : "Check every listed outbound explicitly, in list order."
                }
                onClick={() =>
                  set({
                    outbound_ids: selectFilteredOutbounds(members, outbounds, memberFilter),
                  })
                }
              >
                {narrowed ? "Select all filtered" : "Select all"}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={members.length === 0}
                title={
                  narrowed
                    ? "Uncheck every outbound the filter matches — the rest stay in the pool."
                    : "Uncheck everything, emptying the pool."
                }
                onClick={() =>
                  set({
                    outbound_ids: clearFilteredOutbounds(members, outbounds, memberFilter),
                  })
                }
              >
                {narrowed ? "Clear filtered" : "Clear selection"}
              </button>
            </div>
            <div className="chip-grid chip-scroll">
              {shown.map((o) => {
                const checked = members.includes(o.id);
                return (
                  <label key={o.id} className={`chip${checked ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMember(o.id)}
                    />
                    <span className="mono">{o.id}</span>
                    {o.protocol !== "" && <span className="chip-count">{o.protocol}</span>}
                  </label>
                );
              })}
            </div>
            {narrowed && shown.length < outbounds.length && (
              <div className="field-hint">
                Showing {shown.length} of {outbounds.length}
                {members.length > 0 ? ` — ${members.length} selected` : ""}.
              </div>
            )}
          </>
        )}
        <StringList
          id="pool-outbounds-list"
          label={canPick ? "Members (in order)" : "Outbound ids (in order)"}
          placeholder={canPick ? "(choose an outbound)" : "outbound id"}
          addLabel="Add member"
          mono
          ordered
          values={members}
          onChange={(outbound_ids) => set({ outbound_ids })}
          // Once the fleet has arrived the rows are filterable pickers over
          // it (grouped by protocol), not free text; a stored id the engine
          // no longer knows keeps a "Not configured" option so editing never
          // blanks it. While the catalog is in flight, missing, or empty the
          // rows stay the text inputs they were.
          options={canPick ? memberGroups : undefined}
          filterable={canPick}
        />
      </FieldGroup>

      {(draft.chain_ids ?? []).length > 0 && (
        <FieldGroup
          id="pool-chains"
          label="Chain members"
          hint="Read-only: chains a full-probe pool apply put in this pool. They ride every save untouched — editing outbounds above never removes them. Edit them on the Chains page."
        >
          <div className="chip-grid">
            {(draft.chain_ids ?? []).map((c) => (
              <span key={c} className="chip on mono" aria-disabled="true">
                {c}
              </span>
            ))}
          </div>
        </FieldGroup>
      )}

      <KvEditor
        id="pool-selector-params"
        label="Selector params (JSON)"
        value={draft.selector?.params}
        onChange={(params) =>
          set({ selector: { ...(draft.selector ?? { type: "random" }), params } })
        }
        // What the chosen strategy parses, at the moment of configuration:
        // picking a strategy swaps the example under the editor.
        example={selectorExample(draft.selector?.type ?? "random")}
      />

      <FieldGroup id="pool-filters" label="Filters" hint="Applied in order; a member must pass all of them. A protocol filter also fills the member list with the outbounds it names.">
        <div className="arr-editor">
          {filters.map((f, i) => (
            <div className="item-row" key={i} style={{ alignItems: "start" }}>
              <SelectField
                id={`filter-type-${i}`}
                label="Type"
                value={f.type ?? "location"}
                options={[...FILTERS]}
                onChange={(type) => switchFilterType(i, type)}
              />
              {f.type === "protocol" ? (
                <ProtocolFilterEditor
                  id={`filter-params-${i}`}
                  params={f.params}
                  outbounds={outbounds}
                  catalogHint={catalogHint}
                  onChange={(params) => setFilterParams(i, params)}
                />
              ) : (
                <KvEditor
                  id={`filter-params-${i}`}
                  label="Params (JSON)"
                  value={f.params}
                  onChange={(params) => setFilterParams(i, params)}
                  example={filterExample(f.type ?? "location")}
                />
              )}
              <button
                type="button"
                className="danger"
                onClick={() => removeFilter(i)}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFilters([...filters, { type: "location", params: {} }])}
          >
            Add filter
          </button>
        </div>
      </FieldGroup>
    </>
  );
}

/** The protocol filter's params editor: allow/deny chips over the protocols
 *  the fleet runs (plus whatever the stored params already name), replacing
 *  the JSON text box. Checking a protocol in the allowlist auto-includes its
 *  outbounds in the pool — the onChange rides PoolForm's setFilterParams,
 *  which syncs the member list against ALL the pool's filters. The denylist
 *  keeps the engine's other half of the filter reachable without typing JSON.
 *  A text box beside each row adds names the chips cannot offer: a protocol
 *  no outbound runs (yet), a stored name a misclick removed, or anything at
 *  all while the catalog is loading, failed, or empty — the chips degrade to
 *  whatever the params name, but the filter never becomes unconfigurable. */
function ProtocolFilterEditor({
  id,
  params,
  outbounds,
  catalogHint,
  onChange,
}: {
  id: string;
  params: Record<string, unknown> | undefined;
  outbounds: OutboundChoice[];
  catalogHint: string | undefined;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const choices = protocolChoices(outbounds, params);
  const toggle = (key: "allow" | "deny", protocol: string) => {
    const list = protocolList(params, key);
    const next = list.includes(protocol)
      ? list.filter((p) => p !== protocol)
      : [...list, protocol];
    onChange(withProtocolList(params, key, next));
  };

  const row = (key: "allow" | "deny", label: string, hint: string) => (
    <ProtocolRow
      key={key}
      id={`${id}-${key}`}
      label={label}
      hint={hint}
      choices={choices}
      on={protocolList(params, key)}
      onToggle={(p) => toggle(key, p)}
      onAdd={(name) => onChange(addProtocol(params, key, name))}
    />
  );

  return (
    <div className="field" id={id}>
      {catalogHint !== undefined && (
        <div className="field-hint">{catalogHint} Type protocol names below.</div>
      )}
      {row(
        "allow",
        "Allow protocols",
        "Checking a protocol automatically includes its outbounds in the pool; unchecking takes away what it included (other filters still get their say). No allowlist admits every protocol.",
      )}
      {row(
        "deny",
        "Deny protocols",
        "Denied protocols are excluded even when the allowlist names them. The filter still narrows the pool at selection time.",
      )}
    </div>
  );
}

/** One allow/deny row: the chips, plus a small add box for names the chips do
 *  not offer. The box is a plain controlled input — Enter or the Add button
 *  commits (form submission is not involved), and a commit clears it. */
function ProtocolRow({
  id,
  label,
  hint,
  choices,
  on,
  onToggle,
  onAdd,
}: {
  id: string;
  label: string;
  hint: string;
  choices: string[];
  on: string[];
  onToggle: (protocol: string) => void;
  onAdd: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const add = () => {
    if (name.trim() === "") return;
    onAdd(name);
    setName("");
  };
  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>{label}</span>
      <div
        className="chip-grid"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
      >
        {choices.length === 0 && (
          <span className="hint" style={{ margin: 0 }}>
            No protocols known yet — add a name below.
          </span>
        )}
        {choices.map((p) => (
          <label key={p} className={`chip${on.includes(p) ? " on" : ""}`}>
            <input
              type="checkbox"
              checked={on.includes(p)}
              onChange={() => onToggle(p)}
            />
            <span className="mono">{p === "" ? "(blank)" : p}</span>
          </label>
        ))}
      </div>
      <div className="chip-batch">
        <input
          id={`${id}-add`}
          type="text"
          className="mono"
          value={name}
          placeholder="protocol name…"
          aria-label={`Add a protocol to ${label.toLowerCase()}`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="ghost" disabled={name.trim() === ""} onClick={add}>
          Add
        </button>
      </div>
      <div className="field-hint" id={`${id}-hint`}>{hint}</div>
    </div>
  );
}

function normalize(p: Pool): Pool {
  // The spread keeps chain_ids verbatim when the engine sent them: every
  // form edit spreads the draft too, so a save round-trips the chain members
  // untouched — editing outbound members must never strip the chains a
  // full-probe pool apply put there. Absent stays absent: an older engine's
  // decoder rejects unknown fields, so a pool that never had chains must not
  // grow an empty key.
  return {
    ...p,
    outbound_ids: p.outbound_ids ?? [],
    filters: (p.filters ?? []).map((f) => ({ ...f, params: f.params ?? {} })),
    selector: { ...(p.selector ?? {}), type: p.selector?.type || "random", params: p.selector?.params ?? {} },
  };
}

export { normalize as normalizePool };
