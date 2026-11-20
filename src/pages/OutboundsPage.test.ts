// src/pages/OutboundsPage.test.ts — where an open draft's editor belongs.
//
// The rule is worth testing because getting it wrong is silent: an editor that
// lands inline when its row is not on screen simply does not render, and the
// operator's draft looks like it was thrown away.

import { describe, expect, it } from "vitest";
import { editorPlacement } from "./OutboundsPage";

const VISIBLE = ["relay-1", "relay-2", "psiphon-1.2.3.4"];

describe("editorPlacement", () => {
  it("places nothing when no draft is open", () => {
    expect(editorPlacement(null, VISIBLE)).toBeNull();
  });

  it("keeps a create in the top card: it has no row to sit under", () => {
    // The blank draft's key is the id being typed, and that id names no row —
    // even if it happens to collide with a listed one, the create belongs at
    // the top so the operator is not editing "into" an existing row.
    expect(editorPlacement({ key: "", isNew: true }, VISIBLE)).toBe("card");
    expect(editorPlacement({ key: "relay-1", isNew: true }, VISIBLE)).toBe(
      "card",
    );
  });

  it("places an edit inline under its own row", () => {
    expect(editorPlacement({ key: "relay-2", isNew: false }, VISIBLE)).toBe(
      "inline",
    );
  });

  it("falls back to the top card when the filter hid the edited row", () => {
    // The draft outlives the filter, so the fallback is what keeps it
    // reachable rather than discarding it.
    expect(
      editorPlacement({ key: "relay-2", isNew: false }, ["relay-1"]),
    ).toBe("card");
  });

  it("falls back to the top card when the table shows no rows at all", () => {
    // An error or an empty state replaces the <table>, so there is nothing to
    // attach an inline editor to.
    expect(editorPlacement({ key: "relay-2", isNew: false }, [])).toBe("card");
  });
});
