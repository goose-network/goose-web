// src/pages/ProbesPage.test.ts — the probe picker's pool chips. One click on a
// pool chip commits the round to that pool's member outbounds, so the member
// list is the chip's whole claim: a repeat would count the same route twice,
// and an id the engine has no outbound for would be a round that fails for a
// reason the reader never chose. Both reach the browser verbatim — GET
// /api/pools echoes what the config stored, without cleaning it.

import { describe, expect, it } from "vitest";
import { poolChipGroups } from "./ProbesPage";

describe("poolChipGroups", () => {
  it("expands a pool into one chip naming its configured members", () => {
    // The chip is labelled with the pool, but a round through "pool:x" rides
    // whichever single member the pool's selector picks — so the members are
    // what one click has to put in the round for it to say anything about the
    // rest of the pool.
    expect(
      poolChipGroups([{ id: "x", outbound_ids: ["a", "b"] }], ["a", "b", "c"]),
    ).toEqual([{ ref: "pool:x", members: ["outbound:a", "outbound:b"] }]);
  });

  it("counts a member the pool names twice once", () => {
    // The pools editor does not clean the list, and a provider-fed pool gains a
    // repeat when two providers emit the same id into it. A second entry would
    // inflate the chip's count and hand the round the same route twice.
    expect(
      poolChipGroups([{ id: "x", outbound_ids: ["a", "a", "b"] }], ["a", "b"]),
    ).toEqual([{ ref: "pool:x", members: ["outbound:a", "outbound:b"] }]);
  });

  it("drops a member the engine has not configured", () => {
    // A pool can name an id that was deleted. The router skips it when it builds
    // the pool, so a chip offering it would promise a probe the engine cannot
    // run — a failure the reader did not choose.
    expect(
      poolChipGroups([{ id: "x", outbound_ids: ["a", "gone"] }], ["a"]),
    ).toEqual([{ ref: "pool:x", members: ["outbound:a"] }]);
  });

  it("gives a pool of only unconfigured ids no chip group", () => {
    // The CI fixture's pool-ghost. Nothing left to select is not a chip that
    // selects nothing: with no group behind it the chip falls back to its own
    // ref (ChipPicker's `covers`), so the pool stays a route the reader can name
    // and the engine answers that the pool is empty.
    expect(
      poolChipGroups(
        [{ id: "pool-ghost", outbound_ids: ["nope-1", "nope-2"] }],
        ["direct-1"],
      ),
    ).toEqual([]);
  });

  it("dedupes and filters together, as the CI fixture needs them", () => {
    // The fixture this is the fast net for: pool-default names the one
    // configured outbound twice plus an id nothing configures. One member
    // survives, so the chip's badge reads 1 rather than the 3 the pool declares.
    expect(
      poolChipGroups(
        [
          {
            id: "pool-default",
            outbound_ids: ["direct-1", "direct-1", "e2e-not-configured"],
          },
        ],
        ["direct-1"],
      ),
    ).toEqual([{ ref: "pool:pool-default", members: ["outbound:direct-1"] }]);
  });

  it("skips a pool with no id rather than offering a blank ref", () => {
    // The SDK's id is optional, so a list can carry entries without one; a chip
    // reading "pool:" names nothing and selects nothing.
    expect(
      poolChipGroups(
        [{ outbound_ids: ["a"] }, { id: "", outbound_ids: ["a"] }],
        ["a"],
      ),
    ).toEqual([]);
  });

  it("skips a null or undefined pool entry without crashing", () => {
    // The list arrives off the wire. One null between pools would otherwise take
    // down the whole picker — every route on the page, not just this pool's.
    expect(poolChipGroups([null, undefined], ["a"])).toEqual([]);
    expect(
      poolChipGroups(
        [null, { id: "x", outbound_ids: ["a"] }, undefined],
        ["a"],
      ),
    ).toEqual([{ ref: "pool:x", members: ["outbound:a"] }]);
  });

  it("gives a pool with no members no chip group", () => {
    // An absent or empty list means the pool has no members — not one member
    // named "outbound:undefined", which the picker would offer as a route.
    expect(
      poolChipGroups([{ id: "x" }, { id: "y", outbound_ids: [] }], ["a"]),
    ).toEqual([]);
  });

  it("keeps the pool's declared order, deduped to the first occurrence", () => {
    // The order is the one the pools editor shows, so the chip's members read as
    // the reader wrote them — the same rule `cleanList` applies to every list in
    // this app, and what `new Set` iteration gives for free.
    expect(
      poolChipGroups(
        [{ id: "x", outbound_ids: ["c", "a", "c", "b", "a"] }],
        ["a", "b", "c"],
      ),
    ).toEqual([
      { ref: "pool:x", members: ["outbound:c", "outbound:a", "outbound:b"] },
    ]);
  });

  it("gives each pool its own members, never a merge of two pools", () => {
    // A fleet has many pools and one click lands on one of them: the round has
    // to be the pool the reader clicked, so a group cannot pick up the previous
    // pool's members as it goes.
    expect(
      poolChipGroups(
        [
          { id: "one", outbound_ids: ["a"] },
          { id: "two", outbound_ids: ["b", "a"] },
        ],
        ["a", "b"],
      ),
    ).toEqual([
      { ref: "pool:one", members: ["outbound:a"] },
      { ref: "pool:two", members: ["outbound:b", "outbound:a"] },
    ]);
  });

  it("gives no pool a group when the engine reports no configured outbound", () => {
    // The configured set comes from /api/outbounds, so an empty list means this
    // page can vouch for no member: every pool chip falls back to itself rather
    // than naming routes the engine will reject.
    expect(poolChipGroups([{ id: "x", outbound_ids: ["a"] }], [])).toEqual([]);
  });

  it("does not let a blank id stand in for a configured outbound", () => {
    // Both sides of the match go through the ref builder, which drops blank ids:
    // an outbound the engine served without an id is not "outbound:", so it
    // cannot vouch for a pool member that is not a route either.
    expect(
      poolChipGroups([{ id: "x", outbound_ids: [""] }], ["", undefined]),
    ).toEqual([]);
  });
});
