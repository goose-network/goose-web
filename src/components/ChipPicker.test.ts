// src/components/ChipPicker.test.ts — the filter rule behind the bounded
// outbound/route picker.

import { describe, expect, it } from "vitest";
import { visibleChoices } from "./ChipPicker";

const CHOICES = [
  "outbound:psiphon-1.2.3.4",
  "outbound:psiphon-5.6.7.8",
  "pool:default",
  "chain:relay",
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
});
