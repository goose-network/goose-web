// src/components/FilterSelect.tsx — a filterable single-select over grouped
// choices, for the pickers whose lists grew too long to scan: a chain's layers
// (hundreds of provider-fed outbounds) and a provider's upstream route.
//
// A native <select> makes the reader scroll a flat list of 400 ids to find one;
// this opens a box they can type into, and — when the engine has probed the
// routes — narrow to the ones that answered, failed, or were never tried, and
// sort the reachable ones fastest-first. The choice is still a single value, so
// it drops into the same forms the <select> and the free-text field it replaces
// served.
//
// The filtering, metric folding and option flattening live in exported pure
// functions (the parts worth testing directly); the component is the thin
// keyboard/click shell around them, the same split ChipPicker uses.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { matches } from "./SearchInput";
import { formatDuration } from "../format";
import type { OptionGroup } from "./StringList";

/** The latest observed probe verdict for one route. A value absent from the
 *  metrics map was never probed — distinct from a probe that failed. */
export interface RouteMetric {
  /** the latest probe got a response (success === true) */
  ok: boolean;
  /** that probe's latency, ns; present only on a success */
  latencyNs?: number;
  /** the latest failure's reason slug; present only on a failure */
  reason?: string;
}

/** How the metric chips narrow the list. "all" is the default — the picker is
 *  a chooser first and a report second, so nothing is hidden until asked. */
export type MetricFilter = "all" | "ok" | "failed" | "unprobed";

export const METRIC_FILTERS: ReadonlyArray<{ value: MetricFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "ok", label: "Reachable" },
  { value: "failed", label: "Failed" },
  { value: "unprobed", label: "Unprobed" },
];

/** One probe row, reduced to what folding a verdict needs. Both the SDK's
 *  recorded probes and a manual round's results satisfy it. */
export interface ProbeRow {
  route?: string;
  success?: boolean;
  latency?: number;
  reason?: string;
}

/**
 * routeMetrics folds probe rows to the latest verdict per route reference.
 * Rows arrive newest-first (the engine's history order), so the first row seen
 * for a route is its most recent probe and later ones are ignored. A route with
 * no usable ref drops out rather than becoming a bare "" key.
 */
export function routeMetrics(probes: ReadonlyArray<ProbeRow>): Map<string, RouteMetric> {
  const map = new Map<string, RouteMetric>();
  for (const p of probes) {
    const route = p.route ?? "";
    if (route === "" || map.has(route)) continue;
    const ok = p.success === true;
    map.set(route, {
      ok,
      ...(ok
        ? p.latency !== undefined ? { latencyNs: p.latency } : {}
        : p.reason !== undefined && p.reason !== "" ? { reason: p.reason } : {}),
    });
  }
  return map;
}

/** Whether a verdict passes the metric filter. An absent verdict is "unprobed",
 *  never "failed": a route the engine has not tried is not one it found broken. */
export function matchesMetric(m: RouteMetric | undefined, filter: MetricFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "ok":
      return m?.ok === true;
    case "failed":
      return m !== undefined && !m.ok;
    case "unprobed":
      return m === undefined;
  }
}

/** Compact words for a verdict, for the pill beside a choice and the keyword
 *  haystack. A success reads as its latency (or "ok" untimed); a failure as its
 *  reason humanized; an unprobed route as "unprobed". */
export function metricLabel(m: RouteMetric | undefined): string {
  if (m === undefined) return "unprobed";
  if (m.ok) return m.latencyNs !== undefined ? formatDuration(m.latencyNs) : "ok";
  return m.reason !== undefined && m.reason !== "" ? m.reason.replace(/_/g, " ") : "failed";
}

/** The pill tone for a verdict: ok / fail / warn (unprobed). */
export function metricTone(m: RouteMetric | undefined): "ok" | "fail" | "warn" {
  if (m === undefined) return "warn";
  return m.ok ? "ok" : "fail";
}

/** One row the open box shows, flattened for rendering and keyboard travel. */
export interface FlatOption {
  value: string;
  label: string;
  /** the group header this row sits under; "" for the clear/custom pseudo-rows */
  group: string;
  metric?: RouteMetric;
  kind: "empty" | "choice" | "custom";
}

/**
 * visibleOptions flattens the grouped choices to the rows the open box shows:
 * the clear row first, then every choice passing the keyword and metric filter
 * (optionally sorted fastest-first within its group), then — when free text is
 * allowed and the typed text names no existing choice — a "Use …" row that
 * commits it verbatim.
 *
 * The clear row (value "") is always offered and is not subject to the filters:
 * it is how the reader resets a choice, not a route to judge. Sorting keeps each
 * group's kind together (a chain's Pools/Outbounds split is meaningful) and sinks
 * failed and unprobed routes below the reachable ones, whose latency ascends.
 */
export function visibleOptions(
  groups: ReadonlyArray<OptionGroup>,
  query: string,
  metrics: ReadonlyMap<string, RouteMetric> | undefined,
  filter: MetricFilter,
  sortByLatency: boolean,
  allowCustom: boolean,
  placeholder: string,
): FlatOption[] {
  const out: FlatOption[] = [
    { value: "", label: placeholder, group: "", kind: "empty" },
  ];
  const q = query.trim();
  const seen = new Set<string>([""]);
  for (const g of groups) {
    let opts = g.options.filter((o) => {
      const m = metrics?.get(o.value);
      // The verdict word belongs in the keyword haystack only when metrics are
      // shown. In degraded mode (metrics undefined) no pill is rendered, so
      // appending metricLabel(undefined)="unprobed" would leak invisible metric
      // vocabulary — a query like "probe" would match the entire fleet.
      const haystack =
        metrics !== undefined
          ? `${o.value} ${o.label} ${metricLabel(m)}`
          : `${o.value} ${o.label}`;
      return matchesMetric(m, filter) && matches(haystack, query);
    });
    if (sortByLatency) {
      opts = [...opts].sort((a, b) => latencyKey(metrics?.get(a.value)) - latencyKey(metrics?.get(b.value)));
    }
    for (const o of opts) {
      if (seen.has(o.value)) continue;
      seen.add(o.value);
      const m = metrics?.get(o.value);
      out.push({
        value: o.value,
        label: o.label,
        group: g.label,
        kind: "choice",
        ...(m !== undefined ? { metric: m } : {}),
      });
    }
  }
  if (allowCustom && q !== "" && !seen.has(q)) {
    out.push({ value: q, label: `Use “${q}”`, group: "", kind: "custom" });
  }
  return out;
}

/** Sort key: a reachable route's latency, everything else after it. Failed and
 *  unprobed routes share the tail so "fastest first" never promotes a broken
 *  route above a working one merely because it has no timing. */
function latencyKey(m: RouteMetric | undefined): number {
  if (m === undefined || !m.ok) return Number.POSITIVE_INFINITY;
  return m.latencyNs ?? Number.POSITIVE_INFINITY;
}

/** The label the closed trigger shows for a value: its option's label, the
 *  placeholder for the empty choice, or the raw value when nothing offers it
 *  (a stored id the engine no longer knows, or a free-text route). */
export function displayLabel(
  value: string,
  groups: ReadonlyArray<OptionGroup>,
  placeholder: string,
): string {
  if (value === "") return placeholder;
  for (const g of groups) {
    for (const o of g.options) if (o.value === value) return o.label;
  }
  return value;
}

/** Index of the first row a keystroke should land on — the first real choice,
 *  skipping the clear row so Enter on a fresh filter picks a match, not "none". */
function firstActive(shown: ReadonlyArray<FlatOption>): number {
  const i = shown.findIndex((o) => o.kind !== "empty");
  return i < 0 ? 0 : i;
}

export interface FilterSelectProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  groups: ReadonlyArray<OptionGroup>;
  /** label for the empty choice (value "") — also the closed trigger's text
   *  when nothing is chosen */
  placeholder: string;
  /** latest probe verdict per choice value; absent = no metric UI */
  metrics?: ReadonlyMap<string, RouteMetric> | undefined;
  /** allow committing typed text that names no choice (a custom upstream route) */
  allowCustom?: boolean;
  mono?: boolean;
  disabled?: boolean;
  /** standalone field label; omitted inside a StringList row, which labels it */
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | null | undefined;
  ariaLabel?: string | undefined;
}

export function FilterSelect({
  id,
  value,
  onChange,
  groups,
  placeholder,
  metrics,
  allowCustom = false,
  mono = false,
  disabled = false,
  label,
  hint,
  error,
  ariaLabel,
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MetricFilter>("all");
  const [sortByLatency, setSortByLatency] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // When metrics degrade to undefined (a failed/absent probe fetch, or a
  // connection switch to an engine without probe history) the chip row that
  // sets filter/sort unmounts, but their state persists. Ignore it in that
  // mode so a stale "Reachable"/"Failed" never leaves the picker showing
  // "No matches." for every query with no in-widget way to reset it.
  const effFilter: MetricFilter = metrics !== undefined ? filter : "all";
  const effSort = metrics !== undefined ? sortByLatency : false;

  const shown = useMemo(
    () => visibleOptions(groups, query, metrics, effFilter, effSort, allowCustom, placeholder),
    [groups, query, metrics, effFilter, effSort, allowCustom, placeholder],
  );

  // The "No matches." state renders no option buttons — only the hidden clear
  // pseudo-row survives the filters. Enter must not commit that row (it would
  // wipe the stored value the reader never asked to clear), and
  // aria-activedescendant must not name an option id that is not in the DOM.
  const hasChoices = !(shown.length === 1 && shown[0]?.kind === "empty");

  // Click-away closes the box. pointerdown (not click) so a drag that starts
  // outside still dismisses it, and the option rows preventDefault on
  // pointerdown to keep their own click from being swallowed by the blur.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keep the keyboard-active row in view: a fleet of 1700 outbounds scrolls, and
  // arrow-keying to a row below the fold should bring it into the box, not leave
  // the highlight off-screen. block:"nearest" avoids jumping the whole page.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  // When the popup closes while the trigger keeps focus (commit, Esc), select
  // the restored label so the next keystroke replaces it instead of appending.
  // This must run post-render: those handlers batch setOpen(false) with the
  // refocus, so an onFocus select would still see open=true — or not fire at
  // all when the input was already focused. onFocus covers Tab/autofocus into a
  // never-opened picker; this covers closing back onto a focused trigger.
  useEffect(() => {
    if (!open && document.activeElement === inputRef.current) {
      inputRef.current?.select();
    }
  }, [open]);

  const openBox = () => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setActive(firstActive(visibleOptions(groups, "", metrics, effFilter, effSort, allowCustom, placeholder)));
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
    // Return focus to the trigger: a mouse click on an option keeps focus on
    // the input (pointerdown preventDefault), but a chip may hold it, and the
    // popup unmounting would otherwise drop focus to the body.
    inputRef.current?.focus();
  };

  const onQuery = (q: string) => {
    setQuery(q);
    setOpen(true);
    setActive(firstActive(visibleOptions(groups, q, metrics, effFilter, effSort, allowCustom, placeholder)));
  };

  // Escape is handled on the root element (below), not here, so it also fires
  // when a filter chip holds focus, and stops propagation there so dismissing
  // the popup never reaches FormCard's document-level Esc-to-cancel guard.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        openBox();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Nothing is rendered to pick (the "No matches." state): leave the draft
      // alone rather than commit the hidden clear row, and let the reader
      // refine the query.
      if (!hasChoices) return;
      const pick = shown[active] ?? shown[firstActive(shown)];
      if (pick !== undefined) commit(pick.value);
    }
  };

  const chosen = displayLabel(value, groups, placeholder);
  const chosenMetric = metrics?.get(value);
  const hasMetrics = metrics !== undefined;
  const listId = `${id}-listbox`;

  const control = (
    <div
      className={`filter-select${mono ? " mono" : ""}`}
      ref={rootRef}
      // Close when focus leaves the widget (Tab / Shift+Tab to another field),
      // so the panel never stays open over the form and the trigger goes back
      // to showing the stored value. Focus moving to a chip inside the root
      // keeps it open; relatedTarget is null when focus goes to the body.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setQuery("");
        }
      }}
      // Esc closes the popup from anywhere inside it (the input or a filter
      // chip) and stops the event reaching FormCard's document Esc-to-cancel
      // guard — dismissing a dropdown must not arm or discard the whole form.
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          setQuery("");
          inputRef.current?.focus();
        }
      }}
    >
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        className={mono ? "mono" : undefined}
        value={open ? query : chosen}
        placeholder={open ? "Type to filter…" : placeholder}
        disabled={disabled}
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && hasChoices ? `${id}-opt-${active}` : undefined}
        aria-label={ariaLabel ?? label}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        // Open on a deliberate click, not on focus: FormCard auto-focuses the
        // first field when an edit form mounts, and opening on focus would drop
        // an unrequested popup over the form and blank the stored id. Typing or
        // ArrowDown/Enter still opens it for keyboard users.
        onClick={() => {
          if (!open) openBox();
        }}
        // The closed trigger shows the stored label (or the placeholder text
        // when nothing is chosen) as editable text. Select it on focus so the
        // first keystroke REPLACES it rather than appending — otherwise typing
        // "relay" into a focused-but-closed "fast" filters on "fastrelay". This
        // covers programmatic autofocus, refocus after commit/Esc, and Tab.
        onFocus={() => {
          if (!open) inputRef.current?.select();
        }}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {!open && value !== "" && hasMetrics && (
        <span className={`pill ${metricTone(chosenMetric)} fs-chosen-pill`}>
          {metricLabel(chosenMetric)}
        </span>
      )}
      {open && (
        <div className="fs-panel">
          {hasMetrics && (
            <div className="chip-grid fs-filters">
              {METRIC_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={`chip${filter === f.value ? " on" : ""}`}
                  aria-pressed={filter === f.value}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setFilter(f.value);
                    setActive(firstActive(visibleOptions(groups, query, metrics, f.value, sortByLatency, allowCustom, placeholder)));
                  }}
                >
                  {f.label}
                </button>
              ))}
              <button
                type="button"
                className={`chip${sortByLatency ? " on" : ""}`}
                aria-pressed={sortByLatency}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  const next = !sortByLatency;
                  setSortByLatency(next);
                  setActive(firstActive(visibleOptions(groups, query, metrics, filter, next, allowCustom, placeholder)));
                }}
                title="Sort reachable routes fastest first"
              >
                Fastest first
              </button>
            </div>
          )}
          <div className="fs-list" id={listId} role="listbox" aria-label={ariaLabel ?? label ?? "Choices"}>
            {shown.length === 1 && shown[0]?.kind === "empty" ? (
              <div className="fs-none">No matches.</div>
            ) : (
              shown.map((o, i) => {
                const prev = shown[i - 1];
                const header =
                  o.group !== "" && (prev === undefined || prev.group !== o.group) ? o.group : null;
                return (
                  <div key={`${o.kind}:${o.value}`} role="presentation">
                    {header !== null && <div className="fs-group" role="presentation">{header}</div>}
                    <button
                      type="button"
                      id={`${id}-opt-${i}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={o.value === value}
                      className={`fs-option${i === active ? " active" : ""}${o.value === value ? " chosen" : ""}`}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => commit(o.value)}
                      onMouseEnter={() => setActive(i)}
                    >
                      <span className="fs-option-label">{o.label}</span>
                      {o.kind === "choice" && hasMetrics && (
                        <span className={`pill ${metricTone(o.metric)}`}>{metricLabel(o.metric)}</span>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (label === undefined) return control;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {error !== null && error !== undefined && (
        <div className="field-error" id={`${id}-error`}>{error}</div>
      )}
      {hint !== undefined && (
        <div className="field-hint" id={`${id}-hint`}>{hint}</div>
      )}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string | null): string | undefined {
  const ids = [
    error !== null && error !== undefined ? `${id}-error` : "",
    hint !== undefined ? `${id}-hint` : "",
  ].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}