// src/pages/ChainsPage.test.ts — the layer picker's choices. A layer is a
// BARE id and the engine resolves it against pools first, then outbounds, so
// the option list is the only place the reader learns which kind of thing an
// id names — and a stored id the engine no longer knows must survive the trip
// through a <select>, which renders blank when its value matches no option.

import { describe, expect, it } from "vitest";
import { layerOptions } from "./ChainsPage";

describe("layerOptions", () => {
  it("groups pools and outbounds, sorted, with bare ids as values", () => {
    // The value must stay the bare id: that is what the engine's ChainSpec
    // stores and resolves. Only the grouping says which kind of thing it is.
    expect(layerOptions(["zeta", "alpha"], ["relay-b", "relay-a"], [])).toEqual([
      {
        label: "Pools",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "zeta", label: "zeta" },
        ],
      },
      {
        label: "Outbounds",
        options: [
          { value: "relay-a", label: "relay-a" },
          { value: "relay-b", label: "relay-b" },
        ],
      },
    ]);
  });

  it("offers an id that is both a pool and an outbound under Pools only", () => {
    // The engine resolves the collision to the pool, so a second Outbounds
    // entry would advertise a choice the bare id cannot express — and two
    // options sharing a value make a select resolve to the first, silently.
    expect(layerOptions(["shared"], ["shared", "solo"], [])).toEqual([
      { label: "Pools", options: [{ value: "shared", label: "shared" }] },
      { label: "Outbounds", options: [{ value: "solo", label: "solo" }] },
    ]);
  });

  it("keeps a stored id that is no longer configured, labelled as such", () => {
    // Deleting an outbound must not blank the chain that referenced it: a
    // select whose value matches no option renders nothing selected, and the
    // next save would quietly store a shorter chain. The value stays bare.
    const groups = layerOptions(["pool-a"], ["relay-1"], [
      "relay-1",
      "relay-9",
    ]);
    expect(groups[2]).toEqual({
      label: "Not configured",
      options: [{ value: "relay-9", label: "relay-9 (not configured)" }],
    });
  });

  it("does not re-list configured or blank layers as unconfigured", () => {
    // "Add layer" appends "" for the reader to fill in; that is the picker's
    // own placeholder option, not a phantom "(not configured)" row.
    const groups = layerOptions(["pool-a"], ["relay-1"], [
      "pool-a",
      "",
      "relay-1",
    ]);
    expect(groups).toHaveLength(2);
  });

  it("lists unconfigured layers once each, in chain order", () => {
    // The chain's own order is the order the reader reads the form in; a
    // repeated ghost layer is one problem, not two options.
    const groups = layerOptions([], [], ["gone-b", "gone-a", "gone-b"]);
    expect(groups).toEqual([
      {
        label: "Not configured",
        options: [
          { value: "gone-b", label: "gone-b (not configured)" },
          { value: "gone-a", label: "gone-a (not configured)" },
        ],
      },
    ]);
  });

  it("omits empty groups and ignores missing ids", () => {
    // The SDK's id fields are optional, so a list can carry undefineds; an
    // empty <optgroup> renders as a header with nothing under it.
    expect(layerOptions([undefined], [], [])).toEqual([]);
    expect(layerOptions([], ["relay-1"], ["ghost"])).toEqual([
      { label: "Outbounds", options: [{ value: "relay-1", label: "relay-1" }] },
      {
        label: "Not configured",
        options: [{ value: "ghost", label: "ghost (not configured)" }],
      },
    ]);
  });
});
