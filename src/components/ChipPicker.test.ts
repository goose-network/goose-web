// src/components/ChipPicker.test.ts — the rules behind the bounded
// outbound/route picker: what shows through a filter, what reads as checked,
// and what one click on a chip commits.

import { describe, expect, it } from "vitest";
import {
  chipChecked,
  impliedChoices,
  toggleChoice,
  visibleChoices,
} from "./ChipPicker";

const CHOICES = [
  "outbound:psiphon-1.2.3.4",
  "outbound:psiphon-5.6.7.8",
  "pool:default",
  "chain:relay",
];
// The engine expands an empty probe-route list to the built outbounds only.
const IMPLIED = [
  "outbound:psiphon-1.2.3.4",
  "outbound:psiphon-5.6.7.8",
];

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
    // "Every outbound minus one", materialized from all-mode, would otherwise
    // pin hundreds of checked chips into view and defeat the filter at the
    // fleet sizes that need it.
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

describe("impliedChoices", () => {
  it("is every choice unless the caller narrows it", () => {
    expect(impliedChoices(CHOICES, undefined)).toEqual(CHOICES);
    expect(impliedChoices(CHOICES, IMPLIED)).toEqual(IMPLIED);
  });
});

describe("chipChecked", () => {
  it("reads the implied set as checked when nothing is selected", () => {
    // "Every outbound" is a choice that selects the implied set, so those
    // chips show what the round will actually do.
    expect(chipChecked([], IMPLIED, "outbound:psiphon-1.2.3.4")).toBe(true);
    // … and only the implied set: a pool is not covered by "every outbound".
    expect(chipChecked([], IMPLIED, "pool:default")).toBe(false);
  });

  it("follows the explicit selection once one exists", () => {
    expect(chipChecked(["pool:default"], IMPLIED, "pool:default")).toBe(true);
    expect(
      chipChecked(["pool:default"], IMPLIED, "outbound:psiphon-1.2.3.4"),
    ).toBe(false);
  });

  it("treats every choice as implied when the picker does not narrow", () => {
    expect(chipChecked([], CHOICES, "chain:relay")).toBe(true);
  });
});

describe("toggleChoice", () => {
  it("unchecks one implied chip into all-minus-one", () => {
    expect(toggleChoice([], IMPLIED, "outbound:psiphon-5.6.7.8")).toEqual([
      "outbound:psiphon-1.2.3.4",
    ]);
  });

  it("adds a non-implied chip to the implied set", () => {
    expect(toggleChoice([], IMPLIED, "pool:default")).toEqual([
      "outbound:psiphon-1.2.3.4",
      "outbound:psiphon-5.6.7.8",
      "pool:default",
    ]);
  });

  it("toggles within an explicit selection", () => {
    expect(toggleChoice(["pool:default"], IMPLIED, "chain:relay")).toEqual([
      "pool:default",
      "chain:relay",
    ]);
    expect(toggleChoice(["pool:default"], IMPLIED, "pool:default")).toEqual([]);
  });

  it("collapses a selection that covers the implied set exactly", () => {
    // A materialized copy of "every outbound" would miss outbounds added
    // later; the empty form stays dynamic.
    const one = ["outbound:psiphon-1.2.3.4"];
    expect(
      toggleChoice(one, IMPLIED, "outbound:psiphon-5.6.7.8"),
    ).toEqual([]);
  });

  it("collapses when removing an extra route leaves exactly the implied set", () => {
    // Dropping "pool:default" from implied+pool leaves a selection that means
    // the same thing as the all-chip, so it becomes the all-chip again.
    expect(
      toggleChoice([...IMPLIED, "pool:default"], IMPLIED, "pool:default"),
    ).toEqual([]);
  });

  it("keeps an extra route that the collapse would not cover", () => {
    const one = [...IMPLIED.slice(0, 1), "pool:default"];
    expect(
      toggleChoice(one, IMPLIED, "outbound:psiphon-5.6.7.8"),
    ).toEqual(["outbound:psiphon-1.2.3.4", "pool:default", "outbound:psiphon-5.6.7.8"]);
  });

  it("does not collapse onto an empty implied set", () => {
    // With no outbounds built, "every outbound" covers nothing — an explicit
    // pick of the only route stays explicit rather than snapping back to a
    // form that means "nothing at all".
    expect(toggleChoice([], [], "direct")).toEqual(["direct"]);
  });

  it("unchecking the last chip returns to all-mode", () => {
    // The wire has no "probe nothing": an empty list means every implied
    // choice. One chip implied, unchecked, leaves nothing to express.
    expect(toggleChoice([], ["outbound:solo"], "outbound:solo")).toEqual([]);
  });
});
