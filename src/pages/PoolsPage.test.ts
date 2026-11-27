// src/pages/PoolsPage.test.ts — the pool draft's normalize: the form edits
// outbound members, filters and the selector, but a pool created by
// full-probe pool apply also carries CHAIN members. The save PUTs the draft
// verbatim, so normalize must round-trip chain_ids untouched — dropping it
// would silently strip the chains the pool routes over — while a pool that
// never had chains must not grow the key (an older engine's decoder rejects
// unknown fields outright).

import { describe, expect, it } from "vitest";
import { normalizePool } from "./PoolsPage";
import type { Pool } from "./poolTypes";

describe("normalizePool", () => {
  it("round-trips chain_ids verbatim, order and all", () => {
    const p: Pool = {
      id: "fp-1-pool",
      outbound_ids: ["a", "b"],
      chain_ids: ["fp-1-c2", "fp-1-c1"],
      filters: [],
      selector: { type: "roundrobin", params: {} },
    };
    const draft = normalizePool(p);
    expect(draft.chain_ids).toEqual(["fp-1-c2", "fp-1-c1"]);
    // The save path: the form's edits spread the draft, so an outbound
    // change must carry the chains along unchanged.
    const edited = { ...draft, outbound_ids: ["a"] };
    expect(edited.chain_ids).toEqual(p.chain_ids);
    expect(JSON.parse(JSON.stringify(edited)).chain_ids).toEqual(p.chain_ids);
  });

  it("a pool without chains never grows the key — old engines 400 on it", () => {
    const draft = normalizePool({ id: "plain", outbound_ids: ["a"] });
    expect(draft).not.toHaveProperty("chain_ids");
    expect(JSON.stringify(draft)).not.toContain("chain_ids");
  });

  it("an empty chain list the engine sent stays an empty list", () => {
    const draft = normalizePool({ id: "p", chain_ids: [] });
    expect(draft.chain_ids).toEqual([]);
  });

  it("still defaults the member list, filters and selector as before", () => {
    const draft = normalizePool({ id: "p" });
    expect(draft.outbound_ids).toEqual([]);
    expect(draft.filters).toEqual([]);
    expect(draft.selector).toEqual({ type: "random", params: {} });
  });
});
