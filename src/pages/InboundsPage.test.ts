// src/pages/InboundsPage.test.ts — the routing column's label: it must mirror
// the engine's resolution order (chain > outbound > pool > any) so the table
// shows the route traffic actually takes, not just the fields that are set.

import { describe, expect, it } from "vitest";
import { routingLabel } from "./InboundsPage";

describe("routingLabel", () => {
  it("labels unset policies as any", () => {
    expect(routingLabel(undefined)).toBe("any");
    expect(routingLabel({})).toBe("any");
  });

  it("prefers chain over outbound and pool", () => {
    expect(
      routingLabel({ chain_id: "c", outbound_id: "ob", pool_id: "p" }),
    ).toBe("chain c");
  });

  it("ranks a pinned outbound above a pool", () => {
    expect(routingLabel({ outbound_id: "ob", pool_id: "p" })).toBe(
      "outbound ob",
    );
  });

  it("labels pool routes", () => {
    expect(routingLabel({ pool_id: "p" })).toBe("pool p");
  });
});
