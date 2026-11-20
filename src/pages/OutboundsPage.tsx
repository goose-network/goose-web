// src/pages/OutboundsPage.tsx — CRUD over outbound proxy specs.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "../sdk";
import { useResource } from "../useResource";
import { collect, required } from "../validate";
import { PageHeader } from "../components/PageHeader";
import {
  DataTable,
  EmptyState,
  type Column,
  type EditorRow,
} from "../components/DataTable";
import { FormCard } from "../components/FormCard";
import { ConfirmButton } from "../components/ConfirmButton";
import { SearchInput, matches } from "../components/SearchInput";
import { SelectField, TextField } from "../components/fields";
import { KvEditor } from "../components/KvEditor";
import { outboundExample, PROTOCOLS } from "./outboundExamples";
import type { OutboundSpec } from "@goose-network/goose-sdk";

/** The draft that is open, reduced to what placement needs: which row it
 *  belongs to, and whether it belongs to a row at all. */
export interface OpenDraft {
  key: string;
  isNew: boolean;
}

/**
 * Where an open draft's editor belongs.
 *
 * - "inline": under the row being edited — the operator picks a row, and the
 *   form appears at that row instead of somewhere they have to go looking.
 * - "card": the panel at the top of the page. Two cases land here: a create
 *   has no row to sit under, and an edit whose row the filter box has hidden
 *   has no row left on screen either. The fallback keeps the draft reachable
 *   rather than dropping it, because the draft outlives the filter — throwing
 *   away an operator's half-typed config just because they narrowed the list
 *   would cost work to save a repaint.
 * - null: no draft is open.
 *
 * `visibleKeys` is what the table is actually rendering, so a table showing an
 *   error or an empty state passes an empty list and the editor goes to the
 *   card — there would be no row to attach it to.
 */
export function editorPlacement(
  draft: OpenDraft | null,
  visibleKeys: ReadonlyArray<string>,
): "inline" | "card" | null {
  if (draft === null) return null;
  if (draft.isNew) return "card";
  return visibleKeys.includes(draft.key) ? "inline" : "card";
}

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

  const draft = r.draft;
  const open: OpenDraft | null =
    draft === null ? null : { key: r.idOf(draft), isNew: r.isNew };
  // DataTable renders rows only when it has some and no error to show instead.
  const visibleKeys = useMemo(
    () => (r.error === null ? items.map((o) => o.id ?? "") : []),
    [r.error, items],
  );
  const placement = editorPlacement(open, visibleKeys);
  const inlineKey = placement === "inline" && open !== null ? open.key : null;

  // Autofocus belongs to *opening* an editor, not to moving one. Narrowing the
  // filter until the edited row disappears re-mounts the same draft in the top
  // card while the operator is still typing in #outbound-filter, and taking
  // focus at that moment would swallow the rest of what they type — so the
  // signature below names the draft, not the placement. A create is just
  // "new": its key is the id being typed, so keying on it would re-focus on
  // every keystroke.
  const openSig = draft === null ? null : r.isNew ? "new" : `edit:${r.idOf(draft)}`;
  const lastSig = useRef<string | null>(null);
  const takeFocus = openSig !== null && openSig !== lastSig.current;
  useEffect(() => {
    lastSig.current = openSig;
  });

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
          <button
            type="button"
            className="ghost"
            // While an editor is open inline, each Edit button is a
            // disclosure for its own row: one expanded, the rest not.
            aria-expanded={inlineKey === null ? undefined : inlineKey === (o.id ?? "")}
            onClick={() => r.startEdit(o)}
          >
            Edit
          </button>{" "}
          <ConfirmButton onConfirm={() => void r.remove(o)} title={`Delete ${o.id ?? ""}`} />
        </>
      ),
    },
  ];

  /** The draft's fields, shared by both placements so the inline editor and
   *  the top card cannot drift apart. */
  const fields =
    draft === null ? null : (
      <>
        <div className="row">
          <TextField
            id="out-id"
            label="ID"
            mono
            value={draft.id ?? ""}
            error={r.fieldErrors.id}
            disabled={!r.isNew}
            onChange={(id) => r.setDraft({ ...draft, id })}
            placeholder="relay-1"
            autoFocus={r.isNew}
          />
          <SelectField
            id="out-proto"
            label="Protocol"
            value={draft.protocol ?? "direct"}
            options={[...PROTOCOLS]}
            onChange={(protocol) => r.setDraft({ ...draft, protocol })}
          />
        </div>
        <KvEditor
          id="out-config"
          label="Config (JSON)"
          value={draft.config}
          onChange={(config) => r.setDraft({ ...draft, config })}
          // What this protocol's plugin parses, at the moment of
          // configuration: picking a protocol swaps the example under the
          // editor, and an empty editor offers to insert it.
          example={outboundExample(draft.protocol ?? "direct")}
        />
      </>
    );

  /** One FormCard per placement — "inline" drops the card chrome, since the
   *  table cell already provides a surface. Everything else (the <form>, the
   *  two-step discard guard, saving, the error notice) is FormCard's. */
  const form = (variant: "card" | "inline") =>
    draft === null ? null : (
      <FormCard
        variant={variant}
        autoFocus={takeFocus}
        title={r.isNew ? "New outbound" : `Edit ${r.idOf(draft)}`}
        onSave={() => void r.save()}
        onCancel={r.cancel}
        saving={r.saving}
        dirty
        error={r.saveError}
        onDismissError={r.dismissSaveError}
      >
        {fields}
      </FormCard>
    );

  const inlineEditor: EditorRow | null =
    inlineKey === null ? null : { key: inlineKey, content: form("inline") };

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

      {/* The create flow stays here: a draft for an outbound that does not
          exist yet has no row in the table to be inline in. An edit only
          falls back to this card when its row is not on screen. */}
      {placement === "card" && form("card")}

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
          editor={inlineEditor}
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
