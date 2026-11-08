// src/components/ChipPicker.tsx — the "all of them, or these" multi-select the
// exit-check run card and the probe run card both offer. Nothing selected is a
// real choice ("every outbound"), not an empty form, so it gets its own chip.
//
// A live fleet has hundreds of outbounds, so the individual chips sit in a
// bounded scroll box with a filter above a threshold: an unbounded grid of 300
// chips would dwarf the card around it.

import { useRef, useState } from "react";
import { matches, SearchInput } from "./SearchInput";

/** Choice count at which the list earns a filter box. */
const FILTER_AT = 12;

/** The chips the box shows: everything matching the filter, plus whatever is
 *  selected whether it matches or not — a selection the filter pushed out of
 *  sight reads as a selection lost. */
export function visibleChoices(
  choices: string[],
  selected: string[],
  filter: string,
): string[] {
  return choices.filter((c) => selected.includes(c) || matches(c, filter));
}

export function ChipPicker({
  id,
  allLabel,
  choices,
  selected,
  onChange,
}: {
  id: string;
  allLabel: string;
  choices: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const shown = visibleChoices(choices, selected, filter);
  const toggle = (ref: string) => {
    const next = selected.includes(ref)
      ? selected.filter((r) => r !== ref)
      : [...selected, ref];
    onChange(next);
    // Deselecting a chip that was on screen only because it was selected
    // drops its checkbox out of the DOM, and the keyboard focus with it;
    // hand the focus to the filter box so the reader keeps their place.
    if (filter !== "" && !next.includes(ref) && !matches(ref, filter)) {
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
        {shown.map((ref) => (
          <label key={ref} className={`chip${selected.includes(ref) ? " on" : ""}`}>
            <input
              type="checkbox"
              checked={selected.includes(ref)}
              onChange={() => toggle(ref)}
            />
            <span className="mono">{ref}</span>
          </label>
        ))}
      </div>
      {filter !== "" && shown.length < choices.length && (
        <div className="field-hint">
          Showing {shown.length} of {choices.length}.
        </div>
      )}
    </>
  );
}
