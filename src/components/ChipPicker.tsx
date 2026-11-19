// src/components/ChipPicker.tsx — the "all of them, or these" multi-select the
// exit-check run card and the probe run card both offer. Nothing selected is a
// real choice ("every outbound"), not an empty form, so it gets its own chip.
//
// What the all-chip stands for on the wire is its IMPLIED set: the choices an
// empty selection covers. By default that is every choice — the exit-check's
// "every outbound" names every id in its list — but a caller can narrow it:
// the engine expands an empty probe-route list to the built outbounds only, so
// the probe page passes just its outbound:* refs and a pool, chain or "direct"
// chip honestly renders unchecked under "every outbound".
//
// Because nothing selected already selects the implied set, those chips render
// checked, and unchecking one materializes the set minus that chip: "every
// outbound" is something you can trim, not only replace. A trimmed selection
// that comes to cover the implied set exactly collapses back to the empty
// form, so it stays dynamic — an outbound added later joins the round.
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

/** The choices the all-chip covers: `implied` when the caller narrows it,
 *  every choice otherwise. */
export function impliedChoices(
  choices: string[],
  implied?: string[],
): string[] {
  return implied ?? choices;
}

/** Whether a chip renders as checked. With nothing selected the implied set
 *  IS what is selected — the empty form means "every implied choice" on the
 *  wire — so those chips read as checked; showing them off would hide what
 *  the round is about to do. */
export function chipChecked(
  selected: string[],
  implied: string[],
  ref: string,
): boolean {
  return (selected.length === 0 ? implied : selected).includes(ref);
}

/** The next selection when one chip is toggled. From all-mode the implied set
 *  materializes, minus the chip just unchecked or plus the one just checked;
 *  from an explicit selection it is the plain toggle. Either way, a selection
 *  that comes to mean exactly what the all-chip means collapses back to the
 *  empty form: a materialized copy of "every outbound" would silently miss
 *  outbounds added later, and the engine's own expansion would not. */
export function toggleChoice(
  selected: string[],
  implied: string[],
  ref: string,
): string[] {
  const base = selected.length === 0 ? implied : selected;
  const next = base.includes(ref)
    ? base.filter((r) => r !== ref)
    : [...base, ref];
  const coversImplied =
    implied.length > 0 &&
    next.length === implied.length &&
    implied.every((r) => next.includes(r));
  return coversImplied ? [] : next;
}

/** The chips the box shows: everything matching the filter, plus whatever is
 *  selected whether it matches or not — a selection the filter pushed out of
 *  sight reads as a selection lost. The pinning stops at a large selection,
 *  though: "every outbound minus one", materialized by unchecking a chip in
 *  all-mode, would force hundreds of checked chips into view and defeat the
 *  filter at exactly the fleet sizes that need it. */
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
  selected,
  onChange,
  implied,
}: {
  id: string;
  allLabel: string;
  choices: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** The subset of `choices` the all-chip covers; every choice by default. */
  implied?: string[] | undefined;
}) {
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const all = impliedChoices(choices, implied);
  const shown = visibleChoices(choices, selected, filter);
  const toggle = (ref: string) => {
    const next = toggleChoice(selected, all, ref);
    onChange(next);
    // Unchecking a chip that was on screen only because it was checked drops
    // its checkbox out of the DOM, and the keyboard focus with it; hand the
    // focus to the filter box so the reader keeps their place.
    const stillShown =
      matches(ref, filter) || (next.length <= FILTER_AT && next.includes(ref));
    if (filter !== "" && !stillShown) {
      filterRef.current?.focus();
    }
  };

  return (
    <>
      <div className="chip-grid">
        <label className={`chip${selected.length === 0 ? " on" : ""}`}>
          <input
            type="checkbox"
            checked={selected.length === 0}
            onChange={() => onChange([])}
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
          const checked = chipChecked(selected, all, ref);
          return (
            <label key={ref} className={`chip${checked ? " on" : ""}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(ref)}
              />
              <span className="mono">{ref}</span>
            </label>
          );
        })}
      </div>
      {filter !== "" && shown.length < choices.length && (
        <div className="field-hint">
          Showing {shown.length} of {choices.length}.
        </div>
      )}
    </>
  );
}
