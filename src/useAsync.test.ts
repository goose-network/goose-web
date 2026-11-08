// src/useAsync.test.ts — the re-seed rule behind useSeededDraft.
//
// It decides when an edit form may be overwritten by data arriving from the
// server, and both of its refusals are load-bearing: a background reload must
// not eat what the reader is typing, and a save must not be followed by a
// flash of the pre-save value. The second one shipped as a bug twice — first as
// a card reading "Not configured" straight after a successful save, then as a
// refresh being spent on the load already in hand, so the card never caught up.

import { describe, expect, it } from "vitest";
import { seedsDraft } from "./useAsync";

/** Stand-in for the loaded resource. */
type Engine = { sites: string[] };

const engine = (sites: string[] = []): Engine => ({ sites });

describe("seedsDraft", () => {
  it("waits for the source to load", () => {
    expect(seedsDraft<Engine, string[]>(null, undefined, true, true)).toBe(false);
    expect(seedsDraft(["a"], undefined, true, true)).toBe(false);
  });

  it("seeds on the first load", () => {
    expect(seedsDraft(null, engine(["a"]), true, false)).toBe(true);
  });

  it("keeps the draft across a re-render with the same load", () => {
    expect(seedsDraft(["a", "b"], engine(["a"]), false, false)).toBe(false);
  });

  it("keeps the draft when a load arrives and nothing was saved", () => {
    // A reader mid-edit while the page polls would lose their work, so a new
    // load on its own is not a reason to overwrite.
    expect(seedsDraft(["a", "b"], engine(["a"]), true, false)).toBe(false);
  });

  it("re-seeds once the refresh's load has landed", () => {
    expect(seedsDraft(["a"], engine(["a", "saved"]), true, true)).toBe(true);
  });

  it("does not re-seed from the load that was in hand when the refresh was asked for", () => {
    // The saving card bumps the key before the reload it triggered resolves, so
    // for one commit the flag is set and the source still holds the pre-save
    // value. Seeding there would consume the flag and leave the card stale —
    // which then overwrites the saved value if the reader presses Save.
    expect(seedsDraft(["a", "saved"], engine(["a"]), false, true)).toBe(false);
  });
});
