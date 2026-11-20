// src/components/ChipPicker.test.ts — the rules behind the bounded
// outbound/route picker: what shows through a filter, what reads as checked,
// what one click on a chip commits, and how a selection reads back in words.

import { describe, expect, it } from "vitest";
import {
  ALL_SELECTED,
  chipChecked,
  covers,
  isNothingSelected,
  NONE_SELECTED,
  nothingSelectedProblem,
  selectionWord,
  toggleAll,
  toggleChip,
  visibleChoices,
  type ChipGroup,
} from "./ChipPicker";

const CHOICES = [
  "outbound:psiphon-1.2.3.4",
  "outbound:psiphon-5.6.7.8",
  "pool:default",
  "chain:relay",
];
// The probe picker's pool: one click selects the members, not the pool ref,
// because a round through "pool:x" asks the pool's selector to pick ONE of
// them and says nothing about the rest.
const POOL: ChipGroup[] = [
  {
    ref: "pool:default",
    members: ["outbound:psiphon-1.2.3.4", "outbound:psiphon-5.6.7.8"],
  },
];
const explicit = (...refs: string[]) => ({ all: false, refs });

describe("visibleChoices", () => {
  it("shows every choice with no filter", () => {
    expect(visibleChoices(CHOICES, [], "")).toEqual(CHOICES);
  });

  it("narrows to case-insensitive substring matches", () => {
    expect(visibleChoices(CHOICES, [], "PSIPHON")).toEqual([
      "outbound:psiphon-1.2.3.4",
      "outbound:psiphon-5.6.7.8",
    ]);
    expect(visibleChoices(CHOICES, [], "pool")).toEqual(["pool:default"]);
  });

  it("keeps selected chips the filter would hide", () => {
    // A selection that filtered out of sight reads as a selection lost.
    expect(visibleChoices(CHOICES, ["chain:relay"], "psiphon")).toEqual([
      "outbound:psiphon-1.2.3.4",
      "outbound:psiphon-5.6.7.8",
      "chain:relay",
    ]);
  });

  it("shows nothing but the selection when nothing matches", () => {
    expect(visibleChoices(CHOICES, [], "nope")).toEqual([]);
    expect(visibleChoices(CHOICES, ["pool:default"], "nope")).toEqual([
      "pool:default",
    ]);
  });

  it("lets a large selection go through the filter", () => {
    // A fleet-wide explicit list would otherwise pin hundreds of checked chips
    // into view and defeat the filter at the fleet sizes that need it.
    const many = Array.from({ length: 20 }, (_, i) => `outbound:relay-${i}`);
    const choices = [...many, "pool:default"];
    expect(visibleChoices(choices, many, "relay-1")).toEqual([
      "outbound:relay-1",
      "outbound:relay-10",
      "outbound:relay-11",
      "outbound:relay-12",
      "outbound:relay-13",
      "outbound:relay-14",
      "outbound:relay-15",
      "outbound:relay-16",
      "outbound:relay-17",
      "outbound:relay-18",
      "outbound:relay-19",
    ]);
  });
});

describe("covers", () => {
  it("is a group's members, not the group's own ref", () => {
    expect(covers(POOL, "pool:default")).toEqual([
      "outbound:psiphon-1.2.3.4",
      "outbound:psiphon-5.6.7.8",
    ]);
  });

  it("is the ref itself for a plain chip", () => {
    expect(covers(POOL, "chain:relay")).toEqual(["chain:relay"]);
  });

  it("falls back to the ref for a group with no members", () => {
    // An empty pool still selects something a round can answer for — the
    // engine reports no usable outbound — rather than a click that looks like
    // it did nothing.
    expect(covers([{ ref: "pool:empty", members: [] }], "pool:empty")).toEqual([
      "pool:empty",
    ]);
  });
});

describe("chipChecked", () => {
  it("reads no chip as checked in all-mode", () => {
    // The round's own set is the engine's to enumerate — the built outbounds,
    // which no endpoint reports — so no chip can promise it.
    for (const ref of CHOICES) {
      expect(chipChecked(ALL_SELECTED, POOL, ref), ref).toBe(false);
    }
  });

  it("follows the explicit selection", () => {
    expect(chipChecked(explicit("chain:relay"), POOL, "chain:relay")).toBe(true);
    expect(
      chipChecked(explicit("chain:relay"), POOL, "outbound:psiphon-1.2.3.4"),
    ).toBe(false);
  });

  it("checks a group chip only while every member is selected", () => {
    expect(
      chipChecked(
        explicit("outbound:psiphon-1.2.3.4", "outbound:psiphon-5.6.7.8"),
        POOL,
        "pool:default",
      ),
    ).toBe(true);
    expect(
      chipChecked(explicit("outbound:psiphon-1.2.3.4"), POOL, "pool:default"),
    ).toBe(false);
  });
});

describe("toggleChip", () => {
  it("turns all-mode off and selects exactly the clicked chip", () => {
    expect(toggleChip(ALL_SELECTED, POOL, "chain:relay")).toEqual(
      explicit("chain:relay"),
    );
  });

  it("does not name the rest of the fleet when one chip is clicked", () => {
    // The whole point of the explicit `all` flag: a click on a 476-outbound
    // fleet must not materialize the other 475 refs the reader never asked
    // for. The fleet is a real input here — one chip whose group covers all
    // 476 — so the assertion below is the invariant it stands for, not a
    // constant that cannot fail.
    const fleet = Array.from({ length: 476 }, (_, i) => `outbound:o${i}`);
    const group: ChipGroup[] = [{ ref: "pool:fleet", members: fleet }];
    // Clicking a bare outbound chip selects just that ref, even in the same
    // picker that offers a group covering the whole fleet.
    const next = toggleChip(ALL_SELECTED, group, "outbound:o0");
    expect(next).toEqual(explicit("outbound:o0"));
    expect(next.refs.length).toBeLessThan(fleet.length);
    // … and clicking the fleet chip is the one thing that does name them all.
    const all = toggleChip(ALL_SELECTED, group, "pool:fleet");
    expect(all.refs).toHaveLength(fleet.length);
  });

  it("adds to and removes from an explicit selection", () => {
    expect(toggleChip(explicit("chain:relay"), POOL, "pool:default")).toEqual(
      explicit(
        "chain:relay",
        "outbound:psiphon-1.2.3.4",
        "outbound:psiphon-5.6.7.8",
      ),
    );
    // … and unchecking the last chip reaches the state the caller must refuse.
    expect(toggleChip(explicit("chain:relay"), POOL, "chain:relay")).toEqual(
      NONE_SELECTED,
    );
  });

  it("selects every member of a pool in one click", () => {
    expect(toggleChip(NONE_SELECTED, POOL, "pool:default")).toEqual(
      explicit("outbound:psiphon-1.2.3.4", "outbound:psiphon-5.6.7.8"),
    );
  });

  it("remembers the members a pool click left out", () => {
    // A pool that selects its members must not drop an outbound the reader
    // checked by hand first.
    expect(
      toggleChip(explicit("chain:relay"), POOL, "pool:default"),
    ).toEqual(
      explicit(
        "chain:relay",
        "outbound:psiphon-1.2.3.4",
        "outbound:psiphon-5.6.7.8",
      ),
    );
  });

  it("unchecks a whole pool in one click", () => {
    const sel = explicit(
      "chain:relay",
      "outbound:psiphon-1.2.3.4",
      "outbound:psiphon-5.6.7.8",
    );
    expect(toggleChip(sel, POOL, "pool:default")).toEqual(
      explicit("chain:relay"),
    );
  });

  it("re-clicking a partially covered group completes it rather than removing", () => {
    // The chip reads unchecked, so the click has to check it: a toggle keyed on
    // "anything is selected" would delete the member that was already there.
    expect(
      toggleChip(explicit("outbound:psiphon-1.2.3.4"), POOL, "pool:default"),
    ).toEqual(
      explicit("outbound:psiphon-1.2.3.4", "outbound:psiphon-5.6.7.8"),
    );
  });
});

describe("toggleAll", () => {
  it("unchecking 'every outbound' selects nothing at all", () => {
    // Not "every outbound minus nothing", and not the fleet spelled out: the
    // reader asked for the all-mode to stop, and an empty list on the wire
    // means the opposite, so the caller has to refuse it.
    expect(toggleAll(ALL_SELECTED)).toEqual(NONE_SELECTED);
    expect(isNothingSelected(toggleAll(ALL_SELECTED))).toBe(true);
  });

  it("returns to all-mode from an explicit list, dropping it", () => {
    expect(toggleAll(explicit("chain:relay"))).toEqual(ALL_SELECTED);
    expect(toggleAll(NONE_SELECTED)).toEqual(ALL_SELECTED);
  });

  it("says nothing is selected only in that one state", () => {
    expect(isNothingSelected(ALL_SELECTED)).toBe(false);
    expect(isNothingSelected(explicit("chain:relay"))).toBe(false);
    expect(isNothingSelected(NONE_SELECTED)).toBe(true);
  });
});

describe("selectionWord", () => {
  it("reads all-mode as the caller's own phrase", () => {
    expect(selectionWord(ALL_SELECTED, "every outbound", "route")).toBe(
      "every outbound",
    );
  });

  it("counts an explicit list, and names the empty one", () => {
    expect(selectionWord(explicit("chain:relay"), "every outbound", "route")).toBe(
      "1 route",
    );
    expect(
      selectionWord(
        explicit("chain:relay", "direct"),
        "every outbound",
        "route",
      ),
    ).toBe("2 routes");
    // Zero would read as "0 routes" in a pill, which is a count of something
    // rather than the unfinished form it is.
    expect(selectionWord(NONE_SELECTED, "every outbound", "route")).toBe(
      "no routes",
    );
  });
});

describe("nothingSelectedProblem", () => {
  it("blocks, and says why an empty list is not the answer", () => {
    const problem = nothingSelectedProblem("route", "every outbound");
    expect(problem.blocked).toBe(true);
    expect(problem.message).toContain("No route selected");
    expect(problem.message).toContain("every outbound");
    // The reason matters: the engine reads an omitted or empty `routes` as
    // every built outbound, so sending this form would probe the fleet the
    // reader just unchecked.
    expect(problem.message).toContain("would mean every one of them");
  });
});
