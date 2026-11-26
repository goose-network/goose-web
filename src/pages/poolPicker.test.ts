// src/pages/poolPicker.test.ts — the rules behind the pool form's outbound
// picker and protocol filter: what shows through a keyword filter, what the
// batch controls commit, and how the pool's protocol filters auto-include
// (and release) the outbounds they jointly admit.

import { describe, expect, it } from "vitest";
import {
  addProtocol,
  canSelectFilteredOutbounds,
  clearFilteredOutbounds,
  memberOptions,
  protocolAdmits,
  protocolChoices,
  protocolCoveredIds,
  protocolList,
  selectFilteredOutbounds,
  syncProtocolMembership,
  toggleOutbound,
  visibleOutbounds,
  withProtocolList,
  type OutboundChoice,
  type PoolFilter,
} from "./poolPicker";

const FLEET: OutboundChoice[] = [
  { id: "psiphon-1", protocol: "psiphon" },
  { id: "psiphon-2", protocol: "psiphon" },
  { id: "relay-9", protocol: "mihomo-vmess" },
  { id: "tor-1", protocol: "tor" },
];
const ids = (list: OutboundChoice[]) => list.map((o) => o.id);
// One protocol filter row, the shape coverage/sync read.
const pf = (params: Record<string, unknown> | undefined): PoolFilter => ({
  type: "protocol",
  params,
});

describe("visibleOutbounds", () => {
  it("shows every choice with no filter", () => {
    expect(visibleOutbounds(FLEET, [], "")).toEqual(FLEET);
  });

  it("narrows by id, case-insensitively", () => {
    expect(ids(visibleOutbounds(FLEET, [], "PSIPHON"))).toEqual([
      "psiphon-1",
      "psiphon-2",
    ]);
  });

  it("narrows by protocol even when the ids do not carry it", () => {
    // The haystack is id + protocol: typing a protocol name finds its fleet.
    expect(ids(visibleOutbounds(FLEET, [], "mihomo"))).toEqual(["relay-9"]);
    expect(ids(visibleOutbounds(FLEET, [], "tor"))).toEqual(["tor-1"]);
  });

  it("keeps selected chips the filter would hide", () => {
    expect(ids(visibleOutbounds(FLEET, ["tor-1"], "psiphon"))).toEqual([
      "psiphon-1",
      "psiphon-2",
      "tor-1",
    ]);
  });

  it("lets a large selection go through the filter", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `relay-${i}`,
      protocol: "http",
    }));
    expect(ids(visibleOutbounds(many, ids(many), "relay-1"))).toEqual([
      "relay-1",
      "relay-10",
      "relay-11",
      "relay-12",
      "relay-13",
      "relay-14",
      "relay-15",
      "relay-16",
      "relay-17",
      "relay-18",
      "relay-19",
    ]);
  });
});

describe("selectFilteredOutbounds", () => {
  it("adds exactly what the filter matches, in choice order", () => {
    expect(selectFilteredOutbounds([], FLEET, "psiphon")).toEqual([
      "psiphon-1",
      "psiphon-2",
    ]);
  });

  it("keeps the places of the members already there", () => {
    // A pool is an ordered set; roundrobin cycles the list as stored.
    expect(selectFilteredOutbounds(["tor-1"], FLEET, "psiphon")).toEqual([
      "tor-1",
      "psiphon-1",
      "psiphon-2",
    ]);
  });

  it("dedupes against the current list", () => {
    expect(selectFilteredOutbounds(["psiphon-2"], FLEET, "psiphon")).toEqual([
      "psiphon-2",
      "psiphon-1",
    ]);
  });

  it("with no filter materializes the whole fleet", () => {
    expect(selectFilteredOutbounds([], FLEET, "")).toEqual(ids(FLEET));
  });

  it("a filter that matches nothing leaves the list untouched", () => {
    expect(selectFilteredOutbounds(["tor-1"], FLEET, "nope")).toEqual(["tor-1"]);
    expect(canSelectFilteredOutbounds(FLEET, "nope")).toBe(false);
    expect(canSelectFilteredOutbounds(FLEET, "tor")).toBe(true);
  });
});

describe("clearFilteredOutbounds", () => {
  it("removes exactly what the filter matches, keeping the rest in place", () => {
    expect(
      clearFilteredOutbounds(["tor-1", "psiphon-1", "psiphon-2"], FLEET, "psiphon"),
    ).toEqual(["tor-1"]);
  });

  it("with no filter clears the whole selection", () => {
    expect(clearFilteredOutbounds(["tor-1"], FLEET, "")).toEqual([]);
    expect(clearFilteredOutbounds(["tor-1"], FLEET, "   ")).toEqual([]);
  });

  it("a filter that matches nothing removes nothing", () => {
    expect(clearFilteredOutbounds(["tor-1"], FLEET, "nope")).toEqual(["tor-1"]);
  });
});

describe("toggleOutbound", () => {
  it("appends an unchecked id and removes a checked one", () => {
    expect(toggleOutbound(["tor-1"], "psiphon-1")).toEqual(["tor-1", "psiphon-1"]);
    expect(toggleOutbound(["tor-1", "psiphon-1"], "tor-1")).toEqual(["psiphon-1"]);
  });
});

describe("protocolList", () => {
  it("lowercases, dedupes, and drops non-strings — exactly the engine's set()", () => {
    // internal/filter set() does strings.ToLower and nothing else: no trim,
    // no empty-entry dropping. The read mirror must match it or the chips
    // render opposite to what the engine admits.
    expect(
      protocolList({ allow: ["PSIPHON", "tor", "psiphon", 7] }, "allow"),
    ).toEqual(["psiphon", "tor"]);
  });

  it("keeps whitespace and empty entries the engine keeps", () => {
    expect(protocolList({ allow: [" tor ", ""] }, "allow")).toEqual([" tor ", ""]);
  });

  it("is empty for a missing or non-array key", () => {
    expect(protocolList(undefined, "allow")).toEqual([]);
    expect(protocolList({ allow: "psiphon" }, "allow")).toEqual([]);
    expect(protocolList({}, "deny")).toEqual([]);
  });
});

describe("protocolAdmits", () => {
  it("mirrors the engine: deny first, then a non-empty allow must contain", () => {
    // internal/filter's Protocol.Allow.
    expect(protocolAdmits("psiphon", { allow: ["psiphon"] })).toBe(true);
    expect(protocolAdmits("tor", { allow: ["psiphon"] })).toBe(false);
    expect(protocolAdmits("psiphon", { allow: ["psiphon"], deny: ["psiphon"] })).toBe(false);
    expect(protocolAdmits("tor", { deny: ["psiphon"] })).toBe(true);
  });

  it("an empty allowlist admits everything the denylist left", () => {
    expect(protocolAdmits("tor", {})).toBe(true);
    expect(protocolAdmits("tor", undefined)).toBe(true);
    expect(protocolAdmits("tor", { deny: ["tor"] })).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(protocolAdmits("PSIPHON", { allow: ["Psiphon"] })).toBe(true);
    expect(protocolAdmits("Psiphon", { deny: ["PSIPHON"] })).toBe(false);
  });

  it("does not trim, so a padded entry matches no real protocol", () => {
    // The engine lowercases but never trims: allow [" tor "] is a non-empty
    // set holding " tor ", which protocol "tor" is not in.
    expect(protocolAdmits("tor", { allow: [" tor "] })).toBe(false);
    // allow [""] is non-empty and rejects every protocol.
    expect(protocolAdmits("tor", { allow: [""] })).toBe(false);
    expect(protocolAdmits("psiphon", { allow: [""] })).toBe(false);
  });
});

describe("protocolCoveredIds", () => {
  it("is the fleet the allowlist names, minus the denylist", () => {
    expect(protocolCoveredIds(FLEET, [pf({ allow: ["psiphon"] })])).toEqual([
      "psiphon-1",
      "psiphon-2",
    ]);
    expect(
      protocolCoveredIds(FLEET, [pf({ allow: ["psiphon", "tor"], deny: ["tor"] })]),
    ).toEqual(["psiphon-1", "psiphon-2"]);
  });

  it("an empty allowlist covers nothing — not the whole fleet", () => {
    // "Admits everything" is not a set of outbounds to auto-include.
    expect(protocolCoveredIds(FLEET, [pf({})])).toEqual([]);
    expect(protocolCoveredIds(FLEET, [pf({ deny: ["tor"] })])).toEqual([]);
    expect(protocolCoveredIds(FLEET, [])).toEqual([]);
  });

  it("a degenerate allowlist of blank entries covers nothing", () => {
    expect(protocolCoveredIds(FLEET, [pf({ allow: [""] })])).toEqual([]);
  });

  it("AND-composes protocol filters: coverage is the intersection", () => {
    // Two filters must BOTH admit an outbound for it to be covered.
    expect(
      protocolCoveredIds(FLEET, [pf({ allow: ["psiphon", "tor"] }), pf({ allow: ["tor"] })]),
    ).toEqual(["tor-1"]);
    // Disjoint allowlists admit nothing together.
    expect(
      protocolCoveredIds(FLEET, [pf({ allow: ["psiphon"] }), pf({ allow: ["tor"] })]),
    ).toEqual([]);
    // An empty-allow filter imposes no constraint, so the other still names.
    expect(
      protocolCoveredIds(FLEET, [pf({ allow: ["tor"] }), pf({})]),
    ).toEqual(["tor-1"]);
  });

  it("ignores non-protocol filters", () => {
    expect(
      protocolCoveredIds(FLEET, [
        { type: "location", params: { countries: ["US"] } },
        pf({ allow: ["tor"] }),
      ]),
    ).toEqual(["tor-1"]);
  });
});

describe("syncProtocolMembership", () => {
  it("checking a protocol includes its outbounds", () => {
    expect(
      syncProtocolMembership([], FLEET, [], [pf({ allow: ["psiphon"] })]),
    ).toEqual(["psiphon-1", "psiphon-2"]);
  });

  it("keeps hand-picked members the allowlist never covered", () => {
    expect(
      syncProtocolMembership(["relay-9"], FLEET, [], [pf({ allow: ["psiphon"] })]),
    ).toEqual(["relay-9", "psiphon-1", "psiphon-2"]);
  });

  it("unchecking a protocol takes away exactly what it included", () => {
    expect(
      syncProtocolMembership(
        ["relay-9", "psiphon-1", "psiphon-2"],
        FLEET,
        [pf({ allow: ["psiphon"] })],
        [pf({})],
      ),
    ).toEqual(["relay-9"]);
  });

  it("swapping protocols swaps the covered fleet, keeping the rest", () => {
    expect(
      syncProtocolMembership(
        ["relay-9", "psiphon-1", "psiphon-2"],
        FLEET,
        [pf({ allow: ["psiphon"] })],
        [pf({ allow: ["tor"] })],
      ),
    ).toEqual(["relay-9", "tor-1"]);
  });

  it("widening the allowlist only adds; narrowing only removes covered ids", () => {
    expect(
      syncProtocolMembership(
        ["psiphon-1", "psiphon-2"],
        FLEET,
        [pf({ allow: ["psiphon"] })],
        [pf({ allow: ["psiphon", "tor"] })],
      ),
    ).toEqual(["psiphon-1", "psiphon-2", "tor-1"]);
  });

  it("a new denylist releases the denied protocol's covered ids", () => {
    expect(
      syncProtocolMembership(
        ["psiphon-1", "psiphon-2", "tor-1"],
        FLEET,
        [pf({ allow: ["psiphon", "tor"] })],
        [pf({ allow: ["psiphon", "tor"], deny: ["tor"] })],
      ),
    ).toEqual(["psiphon-1", "psiphon-2"]);
  });

  it("dedupes and keeps the places of the members already there", () => {
    expect(
      syncProtocolMembership(
        ["psiphon-2", "relay-9"],
        FLEET,
        [],
        [pf({ allow: ["psiphon"] })],
      ),
    ).toEqual(["psiphon-2", "relay-9", "psiphon-1"]);
  });

  it("leaves ids the engine no longer knows alone", () => {
    // The catalog can be stale; a filter edit must not drop a stored member.
    expect(
      syncProtocolMembership(["gone-1"], FLEET, [pf({ allow: ["psiphon"] })], [pf({})]),
    ).toEqual(["gone-1"]);
  });

  it("is a no-op without an allowlist on either side", () => {
    expect(syncProtocolMembership(["tor-1"], FLEET, [], [])).toEqual(["tor-1"]);
    expect(
      syncProtocolMembership(["tor-1"], FLEET, [pf({ deny: ["psiphon"] })], [pf({ deny: [] })]),
    ).toEqual(["tor-1"]);
  });

  it("an edit that leaves coverage unchanged moves nothing", () => {
    // A latency tweak or a manually-unchecked covered id must not be undone
    // by re-materializing the whole covered set on every filter edit.
    const filters = [pf({ allow: ["psiphon"] })];
    expect(
      syncProtocolMembership(["psiphon-1"], FLEET, filters, [
        ...filters,
        { type: "latency", params: { max_ms: 300 } },
      ]),
    ).toEqual(["psiphon-1"]);
  });

  // --- cross-filter composition (the engine AND-composes all filters) ---

  it("emptying one protocol filter keeps a member another still admits", () => {
    // Two filters both allow tor; unchecking tor in the second empties it,
    // but the first still names tor — tor-1 must NOT be silently deleted.
    expect(
      syncProtocolMembership(
        ["tor-1"],
        FLEET,
        [pf({ allow: ["tor"] }), pf({ allow: ["tor"] })],
        [pf({ allow: ["tor"] }), pf({})],
      ),
    ).toEqual(["tor-1"]);
  });

  it("a second filter that rejects a protocol stops it being auto-included", () => {
    // filter1 allows psiphon; checking tor in filter2 makes the pair admit
    // nothing, so the tor fleet is NOT materialized (and the psiphon fleet the
    // pair no longer admits is released).
    expect(
      syncProtocolMembership(
        ["psiphon-1", "psiphon-2"],
        FLEET,
        [pf({ allow: ["psiphon"] }), pf({})],
        [pf({ allow: ["psiphon"] }), pf({ allow: ["tor"] })],
      ),
    ).toEqual([]);
  });

  it("removing a protocol filter releases what it covered", () => {
    expect(
      syncProtocolMembership(
        ["relay-9", "tor-1"],
        FLEET,
        [pf({ allow: ["tor"] })],
        [],
      ),
    ).toEqual(["relay-9"]);
  });

  it("removing one of two filters widens coverage to the survivor", () => {
    // Disjoint pair admits nothing; dropping the tor filter leaves psiphon
    // named, so the psiphon fleet joins.
    expect(
      syncProtocolMembership(
        [],
        FLEET,
        [pf({ allow: ["psiphon"] }), pf({ allow: ["tor"] })],
        [pf({ allow: ["psiphon"] })],
      ),
    ).toEqual(["psiphon-1", "psiphon-2"]);
  });
});

describe("withProtocolList", () => {
  it("omits the key when the list comes out empty", () => {
    expect(withProtocolList({ allow: ["tor"] }, "allow", [])).toEqual({});
  });

  it("normalizes like the engine and preserves other keys", () => {
    expect(
      withProtocolList({ deny: ["tor"], note: "x" }, "allow", ["PSIPHON", "psiphon"]),
    ).toEqual({ deny: ["tor"], note: "x", allow: ["psiphon"] });
  });
});

describe("addProtocol", () => {
  it("writes a trimmed, lowercased name (what the engine reads back)", () => {
    expect(addProtocol({}, "allow", "  Tor ")).toEqual({ allow: ["tor"] });
  });

  it("appends to the existing list and preserves other keys", () => {
    expect(
      addProtocol({ allow: ["psiphon"], deny: ["tor"] }, "allow", "geph"),
    ).toEqual({ allow: ["psiphon", "geph"], deny: ["tor"] });
  });

  it("is a no-op for a blank name or one already listed", () => {
    expect(addProtocol({ allow: ["tor"] }, "allow", "   ")).toEqual({ allow: ["tor"] });
    expect(addProtocol({ allow: ["tor"] }, "allow", "TOR")).toEqual({ allow: ["tor"] });
  });
});

describe("protocolChoices", () => {
  it("offers the fleet's protocols, sorted and lowercase", () => {
    expect(protocolChoices(FLEET, {})).toEqual(["mihomo-vmess", "psiphon", "tor"]);
  });

  it("keeps protocols the stored params name even when the fleet lacks them", () => {
    // Editing a pool must not silently drop an allowlist entry the fleet no
    // longer has — the chip still renders so the reader can see and uncheck it.
    expect(protocolChoices(FLEET, { allow: ["geph"], deny: ["i2p"] })).toEqual([
      "geph",
      "i2p",
      "mihomo-vmess",
      "psiphon",
      "tor",
    ]);
  });

  it("keeps a stored blank entry visible (the engine reads it as reject-all)", () => {
    expect(protocolChoices(FLEET, { allow: [""] })).toContain("");
  });

  it("is empty for an empty fleet and empty params", () => {
    expect(protocolChoices([], {})).toEqual([]);
  });
});

describe("memberOptions", () => {
  it("groups the fleet by protocol, sorted, ids sorted within", () => {
    const groups = memberOptions(FLEET, []);
    expect(groups.map((g) => g.label)).toEqual(["mihomo-vmess", "psiphon", "tor"]);
    expect(groups[1]?.options.map((o) => o.value)).toEqual(["psiphon-1", "psiphon-2"]);
  });

  it("gives stored ids the engine no longer knows a Not configured option", () => {
    // A select whose value matches no option renders blank — dropping the
    // stored id here would blank the member and lose it on the next save.
    const groups = memberOptions(FLEET, ["gone-1", "psiphon-1", "gone-1", ""]);
    const last = groups[groups.length - 1];
    expect(last?.label).toBe("Not configured");
    expect(last?.options).toEqual([
      { value: "gone-1", label: "gone-1 (not configured)" },
    ]);
  });

  it("has no Not configured group when every member is known", () => {
    const groups = memberOptions(FLEET, ["psiphon-1"]);
    expect(groups.map((g) => g.label)).not.toContain("Not configured");
  });
});