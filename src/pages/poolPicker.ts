// src/pages/poolPicker.ts — the rules behind the pool form's outbound picker
// and its protocol filter, split out as pure functions the way ChipPicker and
// FilterSelect split theirs (the parts worth testing directly).
//
// Two behaviors live here:
//
//  - The keyword picker works like the probe page's route filter (ChipPicker):
//    a search box narrows the fleet by case-insensitive substring, and batch
//    controls check or clear exactly what the filter matches. Unlike the probe
//    picker there is no "every one of them" chip: a pool's empty outbound list
//    means an EMPTY pool (the router answers "empty pool"), not the engine's
//    enumeration, so the selection is always an explicit, ordered id list.
//    The haystack carries the protocol beside the id, so typing "psiphon"
//    finds the psiphon fleet even when the ids themselves do not say it.
//
//  - A protocol filter auto-includes the outbounds it names: checking a
//    protocol in the filter's allowlist unions that protocol's outbounds into
//    the pool's member list, and unchecking it takes away exactly what the
//    old allowlist covered. Members the reader picked by hand (or keyword)
//    that the allowlist never covered stay put. The filter itself still rides
//    the pool and narrows at dispatch (internal/filter's Protocol), and the
//    engine AND-composes ALL of a pool's filters — so coverage is computed
//    across the whole filter list, not one row in isolation: a member another
//    filter rejects never joins, and a member another filter still admits
//    never leaves.

import { matches } from "../components/SearchInput";
import type { OptionGroup } from "../components/StringList";

/** One configured outbound, reduced to what the picker needs. */
export interface OutboundChoice {
  id: string;
  protocol: string;
}

/** Choice count at which the fleet earns a filter box, and the selection size
 *  up to which selected chips are pinned into view through a filter — the same
 *  rule ChipPicker applies (its FILTER_AT). */
const FILTER_AT = 12;

/** The text the keyword filter matches: the id plus the protocol, so a
 *  protocol name finds its whole fleet even when the ids do not carry it. */
export function outboundHaystack(c: OutboundChoice): string {
  return `${c.id} ${c.protocol}`;
}

/** The chips the box shows: everything matching the filter, plus whatever is
 *  selected whether it matches or not — a selection the filter pushed out of
 *  sight reads as a selection lost. The pinning stops at a large selection,
 *  though: a fleet-wide list would force hundreds of checked chips into view
 *  and defeat the filter at exactly the sizes that need it (ChipPicker's
 *  visibleChoices rule). */
export function visibleOutbounds(
  choices: ReadonlyArray<OutboundChoice>,
  selected: ReadonlyArray<string>,
  filter: string,
): OutboundChoice[] {
  const pinned = selected.length <= FILTER_AT ? selected : [];
  return choices.filter(
    (c) => pinned.includes(c.id) || matches(outboundHaystack(c), filter),
  );
}

/** Whether "select all filtered" has anything to add: a filter no choice
 *  matches would make the click a no-op, so the control disables rather than
 *  promising a selection it cannot make. */
export function canSelectFilteredOutbounds(
  choices: ReadonlyArray<OutboundChoice>,
  filter: string,
): boolean {
  return choices.some((c) => matches(outboundHaystack(c), filter));
}

/** The next member list when "select all filtered" is clicked: every matching
 *  outbound joins the list, deduped — the ids already there keep their places
 *  (a pool is an ordered set; roundrobin cycles it) and the new ones arrive in
 *  choice order. With no filter this materializes the whole fleet the box
 *  shows. A filter that matches nothing leaves the list untouched. */
export function selectFilteredOutbounds(
  current: ReadonlyArray<string>,
  choices: ReadonlyArray<OutboundChoice>,
  filter: string,
): string[] {
  const add = choices
    .filter((c) => matches(outboundHaystack(c), filter))
    .map((c) => c.id);
  const refs = [...current];
  for (const id of add) {
    if (!refs.includes(id)) refs.push(id);
  }
  return refs;
}

/** The next member list when "clear filtered" is clicked: every matching
 *  outbound leaves the list and the rest keep their places. With no filter the
 *  control reads "clear selection" and means exactly that — an empty pool,
 *  which the form is free to save (unlike a probe round, a pool has no
 *  "empty means every one of them" wire reading). */
export function clearFilteredOutbounds(
  current: ReadonlyArray<string>,
  choices: ReadonlyArray<OutboundChoice>,
  filter: string,
): string[] {
  if (filter.trim() === "") return [];
  const remove = new Set(
    choices
      .filter((c) => matches(outboundHaystack(c), filter))
      .map((c) => c.id),
  );
  return current.filter((id) => !remove.has(id));
}

/** The next member list when one outbound chip is clicked: a plain toggle
 *  that keeps the places of the ids already there. */
export function toggleOutbound(
  current: ReadonlyArray<string>,
  id: string,
): string[] {
  return current.includes(id)
    ? current.filter((v) => v !== id)
    : [...current, id];
}

// ---------------------------------------------------------------------------
// Protocol filter
// ---------------------------------------------------------------------------

/** The string list under one protocol-filter param key ("allow"/"deny"),
 *  normalized EXACTLY the way the engine's filter.set normalizes it:
 *  strings.ToLower, nothing else — no trim, no empty-entry dropping ("" is a
 *  real set entry the engine keeps, and a non-empty allowlist of it rejects
 *  every protocol). Non-strings drop, duplicates collapse (it is a set).
 *  Params arrive as parsed JSON of unknown shape, so nothing here may assume
 *  a type. Reading the stored list any other way would render chips — and
 *  materialize members — opposite to what the engine admits at dispatch. */
export function protocolList(
  params: Record<string, unknown> | undefined,
  key: "allow" | "deny",
): string[] {
  const v = params?.[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.toLowerCase();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Whether one protocol passes a protocol filter — internal/filter's
 *  Protocol.Allow: the denylist rejects first, then a non-empty allowlist
 *  must contain the protocol; an empty allowlist admits everything the
 *  denylist left. The engine lowercases both sides and does NOT trim, so
 *  neither does this. */
export function protocolAdmits(
  protocol: string,
  params: Record<string, unknown> | undefined,
): boolean {
  const p = protocol.toLowerCase();
  if (protocolList(params, "deny").includes(p)) return false;
  const allow = protocolList(params, "allow");
  return allow.length === 0 || allow.includes(p);
}

/** The shape of a pool filter row this module reads. Structurally matches the
 *  SDK's config.FilterSpec without importing it, so this module stays pure
 *  over plain data: `type` discriminates, `params` is parsed JSON of unknown
 *  shape. */
export interface PoolFilter {
  type?: string | undefined;
  params?: Record<string, unknown> | undefined;
}

/** The outbounds the pool's protocol filters cover, computed across the WHOLE
 *  filter list the way the engine AND-composes filters at dispatch: an
 *  outbound is covered only when EVERY protocol filter admits it. A second
 *  protocol filter that rejects a protocol therefore stops it being
 *  auto-included, and emptying one filter does not release a member another
 *  filter still names.
 *
 *  Coverage needs at least one non-empty allowlist somewhere: an empty
 *  allowlist "admits everything", which is not a set of outbounds to
 *  materialize, and flooding the pool with the whole fleet is not what adding
 *  an empty filter asks for. (A degenerate allowlist like [""] is non-empty
 *  but admits no real protocol, so it covers nothing — matching the engine,
 *  which rejects every member under it.) */
export function protocolCoveredIds(
  outbounds: ReadonlyArray<OutboundChoice>,
  filters: ReadonlyArray<PoolFilter>,
): string[] {
  const protocolFilters = filters.filter((f) => f.type === "protocol");
  if (!protocolFilters.some((f) => protocolList(f.params, "allow").length > 0)) {
    return [];
  }
  return outbounds
    .filter((o) => protocolFilters.every((f) => protocolAdmits(o.protocol, f.params)))
    .map((o) => o.id);
}

/**
 * syncProtocolMembership recomputes the member list after the pool's filters
 * changed: what the OLD filters covered and the new ones no longer do leaves
 * the list, and what the NEW filters NEWLY cover joins it (deduped, in choice
 * order, after the ids already there). Coverage is the AND-composition of
 * every protocol filter (protocolCoveredIds), so editing one row never
 * silently deletes a member another row still admits, nor adds one another
 * row rejects.
 *
 * Only covered ids are touched. A member the reader picked by hand whose
 * protocol the filters never covered stays — auto-inclusion adds the related
 * outbounds, it does not confiscate the rest of the pool. Ids the engine no
 * longer has configured stay too: the catalog this page saw can be stale, and
 * dropping a stored member on a filter edit would lose it silently.
 */
export function syncProtocolMembership(
  current: ReadonlyArray<string>,
  outbounds: ReadonlyArray<OutboundChoice>,
  oldFilters: ReadonlyArray<PoolFilter>,
  newFilters: ReadonlyArray<PoolFilter>,
): string[] {
  const oldCovered = new Set(protocolCoveredIds(outbounds, oldFilters));
  const newCovered = protocolCoveredIds(outbounds, newFilters);
  const newSet = new Set(newCovered);
  const refs = current.filter((id) => !oldCovered.has(id) || newSet.has(id));
  // Only ids the edit NEWLY covers join. An id still covered but unchecked by
  // hand stays unchecked, and an edit that leaves coverage unchanged (a
  // latency tweak, adding a location filter) moves nothing — re-adding the
  // whole covered set on every edit would undo the reader's manual unchecks.
  for (const id of newCovered) {
    if (!oldCovered.has(id) && !refs.includes(id)) refs.push(id);
  }
  return refs;
}

/** Replace one protocol list in params, omitting the key when the list comes
 *  out empty — the engine reads a missing key and [] alike as "no list", and
 *  the omitted form is what the chip editor commits. The list is normalized
 *  the way the engine reads it (protocolList); other keys ride along untouched
 *  (params is unknown JSON and the editor owns only allow/deny). */
export function withProtocolList(
  params: Record<string, unknown> | undefined,
  key: "allow" | "deny",
  list: ReadonlyArray<string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(params ?? {}) };
  const cleaned = protocolList({ [key]: [...list] }, key);
  if (cleaned.length === 0) delete next[key];
  else next[key] = cleaned;
  return next;
}

/** Add one protocol name to a list — the free-text affordance beside the
 *  chips, for a protocol the fleet does not run (yet) or a stored name a
 *  misclick removed. Unlike the READ mirror (protocolList, which never trims
 *  because the engine does not), this WRITES a clean value: the name is
 *  trimmed and lowercased, so what lands in params is exactly what the engine
 *  will read back. A blank name or one already listed is a no-op. */
export function addProtocol(
  params: Record<string, unknown> | undefined,
  key: "allow" | "deny",
  name: string,
): Record<string, unknown> {
  const p = name.trim().toLowerCase();
  const list = protocolList(params, key);
  if (p === "" || list.includes(p)) return { ...(params ?? {}) };
  return withProtocolList(params, key, [...list, p]);
}

/** The protocols the filter's allow/deny chips offer: every protocol the
 *  fleet actually runs, plus whatever the stored params already name (a
 *  protocol the fleet no longer has must still render as a chip, or editing
 *  the pool would silently drop it from the allowlist). Sorted, lowercase —
 *  the canonical form the engine normalizes to. A blank entry stays blank
 *  ("" is a real stored value the engine reads as reject-all; hiding it would
 *  render the filter opposite to its behavior). */
export function protocolChoices(
  outbounds: ReadonlyArray<OutboundChoice>,
  params: Record<string, unknown> | undefined,
): string[] {
  const set = new Set<string>();
  for (const o of outbounds) {
    const p = o.protocol.toLowerCase();
    if (p !== "") set.add(p);
  }
  for (const key of ["allow", "deny"] as const) {
    for (const p of protocolList(params, key)) set.add(p);
  }
  return [...set].sort();
}

/**
 * memberOptions builds the ordered member list's picker choices: the fleet
 * grouped by protocol (the group header carries what a bare id cannot), plus
 * a "Not configured" group for stored members the engine no longer knows —
 * a select whose value matches no option renders blank, so dropping them here
 * would blank the member in the form and store a pool with it missing on the
 * next save (the same rule ChainsPage.layerOptions applies).
 */
export function memberOptions(
  outbounds: ReadonlyArray<OutboundChoice>,
  current: ReadonlyArray<string>,
): OptionGroup[] {
  const byProtocol = new Map<string, string[]>();
  const known = new Set<string>();
  for (const o of outbounds) {
    if (o.id === "" || known.has(o.id)) continue;
    known.add(o.id);
    const p = o.protocol.toLowerCase() || "(no protocol)";
    const list = byProtocol.get(p) ?? [];
    list.push(o.id);
    byProtocol.set(p, list);
  }
  const groups: OptionGroup[] = [...byProtocol.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([protocol, ids]) => ({
      label: protocol,
      options: ids.sort().map((id) => ({ value: id, label: id })),
    }));
  const unconfigured = [
    ...new Set(current.filter((id) => id !== "" && !known.has(id))),
  ];
  if (unconfigured.length > 0) {
    groups.push({
      label: "Not configured",
      options: unconfigured.map((id) => ({ value: id, label: `${id} (not configured)` })),
    });
  }
  return groups;
}
