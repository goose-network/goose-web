// src/components/ChipPicker.tsx — the "all of them, or these" multi-select the
// exit-check run card and the probe run card both offer.
//
// "Every one of them" is a real choice, not an empty form, so it gets its own
// chip — and it is a real toggle: unchecking it leaves nothing selected, which
// is a state the caller has to refuse rather than send. Both wire formats this
// picker feeds (a probe's `routes`, an exit-check run's `outbounds`) read an
// empty list as "every one of them", so "nothing selected" cannot travel as an
// empty list. That is why the selection carries an explicit `all` flag instead
// of being inferred from an empty array: `ALL_SELECTED` and `NONE_SELECTED`
// look alike on the wire and mean opposite things.
//
// Individual chips render unchecked under the all-chip. They are about to be
// probed, but the set they belong to is the engine's to enumerate at run time —
// the built outbounds, which no endpoint reports — so checking them would
// promise a specific list the round may not match, and unchecking one would
// have to materialize the rest: a click on a 476-outbound fleet would name 475
// refs the reader never asked for. Leaving the all-chip to say it, and letting
// a chip click start an explicit list, keeps both readings honest.
//
// A chip can stand for a set of other chips: `groups` names them, so one click
// covers the bundle. In the probe picker a pool chip selects its member
// outbounds — probing "pool:x" as a route of its own asks the pool's selector
// to pick ONE member, so a round through it says almost nothing about the
// others.
//
// A live fleet has hundreds of outbounds, so the individual chips sit in a
// bounded scroll box with a filter above a threshold: an unbounded grid of 300
// chips would dwarf the card around it.

import { useRef, useState } from "react";
import { matches, SearchInput } from "./SearchInput";

/** Choice count at which the list earns a filter box — and the selection size
 *  up to which selected chips are pinned into view through a filter (see
 *  visibleChoices). */
const FILTER_AT = 12;

/** What the picker holds. `all` on means the engine's own enumeration, and
 *  `refs` is empty; `all` off means exactly the refs — possibly none, which is
 *  a state a caller has to handle rather than send. */
export interface ChipSelection {
  all: boolean;
  refs: string[];
}

/** The all-mode selection: what a form starts at, and what clicking the
 *  all-chip from an explicit list returns to. On the wire it is an omitted
 *  list, which stays dynamic — an outbound added later joins the round. */
export const ALL_SELECTED: ChipSelection = { all: true, refs: [] };

/** Nothing selected: all-mode off and no chip checked. Reachable by
 *  unchecking the all-chip, and unrunnable — the caller says so, because both
 *  wire formats read an empty list as "every one of them". */
export const NONE_SELECTED: ChipSelection = { all: false, refs: [] };

/** True for the state the wire cannot carry: all-mode off and no chip
 *  checked. Callers gate their run/save button on it rather than sending an
 *  empty list, which the engine would read as "every one of them". */
export function isNothingSelected(sel: ChipSelection): boolean {
  return !sel.all && sel.refs.length === 0;
}

/** How a selection reads in a card head or a summary: all-mode as the phrase
 *  the picker uses for it, an explicit list as a count, and the nothing-selected
 *  state as itself rather than as a count of zero. */
export function selectionWord(
  sel: ChipSelection,
  allLabel: string,
  noun: string,
): string {
  if (sel.all) return allLabel;
  const n = sel.refs.length;
  if (n === 0) return `no ${noun}s`;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Why nothing is selected, in the words both pickers share. The engine reads
 *  an empty list as "every one of them", so this state cannot be sent — it is a
 *  form the reader has to finish, not a round the engine will reject. */
export function nothingSelectedProblem(
  what: string,
  allLabel: string,
): { blocked: true; message: string } {
  return {
    blocked: true,
    message: `No ${what} selected — pick at least one, or check “${allLabel}”. An empty list would mean every one of them, which is not what unchecking it asks for.`,
  };
}

/** A chip that stands for other chips: clicking it checks or unchecks the whole
 *  set, and it reads as checked only while all of them are. */
export interface ChipGroup {
  /** the chip's own label — a pool ref in the probe picker */
  ref: string;
  /** the chips one click on it selects */
  members: string[];
}

/** The refs one chip covers: its group's members, or just itself. A group with
 *  no members falls back to its own ref, so an empty pool still selects
 *  something a round can answer for (the engine reports no usable outbound)
 *  rather than a click that appears to do nothing. */
export function covers(groups: ChipGroup[], ref: string): string[] {
  const members = groups.find((g) => g.ref === ref)?.members;
  return members === undefined || members.length === 0 ? [ref] : members;
}

/** Whether a chip renders as checked: only from an explicit selection, and only
 *  when everything it covers is in it. Under the all-chip nothing reads checked
 *  — see the header for why the round's own set is not spelled out here. */
export function chipChecked(
  sel: ChipSelection,
  groups: ChipGroup[],
  ref: string,
): boolean {
  if (sel.all) return false;
  return covers(groups, ref).every((c) => sel.refs.includes(c));
}

/** The next selection when one chip is clicked. The all-chip turns off: a list
 *  the reader named is what they get, and "every one of them plus this" is not
 *  a thing either wire format can say. The click is then a plain toggle of the
 *  refs the chip covers, so unchecking the last chip reaches NONE_SELECTED —
 *  which the caller refuses to run rather than sending as an empty list. */
export function toggleChip(
  sel: ChipSelection,
  groups: ChipGroup[],
  ref: string,
): ChipSelection {
  const covered = covers(groups, ref);
  const base = sel.all ? [] : sel.refs;
  const on = covered.every((c) => base.includes(c));
  return {
    all: false,
    refs: on
      ? base.filter((r) => !covered.includes(r))
      : [...base, ...covered.filter((c) => !base.includes(c))],
  };
}

/** The next selection when the all-chip is clicked. Off means nothing is
 *  selected — not "every one of them", which is what leaving the list empty
 *  would silently mean on the wire. */
export function toggleAll(sel: ChipSelection): ChipSelection {
  return sel.all ? NONE_SELECTED : ALL_SELECTED;
}

/** The chips the box shows: everything matching the filter, plus whatever is
 *  selected whether it matches or not — a selection the filter pushed out of
 *  sight reads as a selection lost. The pinning stops at a large selection,
 *  though: a fleet-wide list would force hundreds of checked chips into view
 *  and defeat the filter at exactly the sizes that need it. */
export function visibleChoices(
  choices: string[],
  selected: string[],
  filter: string,
): string[] {
  const pinned = selected.length <= FILTER_AT ? selected : [];
  return choices.filter((c) => pinned.includes(c) || matches(c, filter));
}

export function ChipPicker({
  id,
  allLabel,
  choices,
  value,
  onChange,
  groups = [],
}: {
  id: string;
  /** what the all-chip reads, in the caller's terms */
  allLabel: string;
  /** every chip the box can show, group chips included */
  choices: string[];
  value: ChipSelection;
  onChange: (next: ChipSelection) => void;
  /** chips that select a set of other chips */
  groups?: ChipGroup[];
}) {
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const shown = visibleChoices(choices, value.refs, filter);
  const toggle = (ref: string) => {
    const next = toggleChip(value, groups, ref);
    onChange(next);
    // Unchecking a chip that was on screen only because it was checked drops
    // its checkbox out of the DOM, and the keyboard focus with it; hand the
    // focus to the filter box so the reader keeps their place.
    const stillShown =
      matches(ref, filter) ||
      (next.refs.length <= FILTER_AT && next.refs.includes(ref));
    if (filter !== "" && !stillShown) {
      filterRef.current?.focus();
    }
  };

  return (
    <>
      <div className="chip-grid">
        <label className={`chip${value.all ? " on" : ""}`}>
          <input
            type="checkbox"
            checked={value.all}
            onChange={() => onChange(toggleAll(value))}
          />
          {allLabel}
        </label>
      </div>
      {choices.length > FILTER_AT && (
        <SearchInput
          id={`${id}-filter`}
          value={filter}
          onChange={setFilter}
          inputRef={filterRef}
        />
      )}
      <div className="chip-grid chip-scroll">
        {shown.map((ref) => {
          const checked = chipChecked(value, groups, ref);
          // A group chip says what one click on it selects: without the count,
          // a pool reads as one route among hundreds.
          const members = covers(groups, ref);
          const isGroup = members.length > 1 || members[0] !== ref;
          return (
            <label key={ref} className={`chip${checked ? " on" : ""}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(ref)}
              />
              <span className="mono">{ref}</span>
              {isGroup && <span className="chip-count">{members.length}</span>}
            </label>
          );
        })}
      </div>
      {filter !== "" && shown.length < choices.length && (
        <div className="field-hint">
          Showing {shown.length} of {choices.length}
          {/* A selection larger than FILTER_AT is not pinned into the filtered
              view — see visibleChoices — so without this the reader is looking
              at a box of unchecked chips while hundreds of them are selected. */}
          {value.refs.length > 0 ? ` — ${value.refs.length} selected` : ""}.
        </div>
      )}
    </>
  );
}
