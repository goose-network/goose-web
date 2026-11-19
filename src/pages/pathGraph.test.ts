// src/pages/pathGraph.test.ts — the graph walk, the labels and the wording
// rules that turn a `core.PathGraph` into a rendered path. Every case is a
// wire shape the engine actually produces (or an older/odd one it must not
// crash on), taken from internal/core/path.go's Snapshot ordering and the
// router's dispatch/probe observations.

import { describe, expect, it } from "vitest";
import type { PathEdge, PathGraph, PathNode } from "../runApi";
import {
  arrowGlyph,
  buildPathView,
  legCountSummary,
  legLabel,
  nodeLabel,
  pathHaystack,
  pathTitle,
  synthesizePathFromChain,
} from "./pathGraph";
import { failureLabel } from "./probeSpec";

/** A graph whose walk must succeed; fails the test with a readable message
 *  rather than throwing on a property of undefined. */
function view(g: PathGraph) {
  const v = buildPathView(g);
  if (v === undefined) throw new Error("buildPathView returned undefined");
  return v;
}

// --- the shapes the engine emits -------------------------------------------

/** Snapshot() reorders nodes local-first, proxies in dial order, target last,
 *  and a direct route's dispatch graph is local → target on one stack leg. */
const DIRECT_GRAPH: PathGraph = {
  nodes: [
    { id: "local", kind: "local" },
    {
      id: "target",
      kind: "target",
      address: "example.com:443",
      addressSource: "socket",
      host: "example.com",
      port: "443",
    },
  ],
  edges: [
    {
      from: "local",
      to: "target",
      kind: "stack",
      target: "example.com:443",
      duration: 81_000_000,
      observed: true,
      success: true,
    },
  ],
};

/** One proxy hop: the dial leg is timed, the arrival tunnel leg is not
 *  separately timed (noteUpstreamArrival observes it with Untimed, so the
 *  engine omits `duration` — omitempty — rather than sending 0). */
const PROXY_GRAPH: PathGraph = {
  nodes: [
    { id: "local", kind: "local" },
    {
      id: "proxy:relay-1",
      kind: "proxy",
      outboundID: "relay-1",
      address: "203.0.113.9:8443",
      addressSource: "socket",
      attempt: 1,
    },
    {
      id: "target",
      kind: "target",
      address: "example.com:443",
      addressSource: "configured",
      host: "example.com",
      port: "443",
    },
  ],
  edges: [
    {
      from: "local",
      to: "proxy:relay-1",
      kind: "dial",
      target: "example.com:443",
      duration: 42_000_000,
      observed: true,
      success: true,
    },
    {
      from: "proxy:relay-1",
      to: "target",
      kind: "tunnel",
      target: "example.com:443",
      observed: true,
      success: true,
    },
  ],
};

/** dialPoolSnapshot: attempt 1 refused, attempt 2 wins. Every attempt leaves
 *  "local" (each LegDial's From is LastNodeID, which stays "local" until a leg
 *  succeeds), attempt>1 nodes carry the "#n" id suffix, and only the winner is
 *  followed by an arrival tunnel leg. */
const FAILOVER_GRAPH: PathGraph = {
  nodes: [
    { id: "local", kind: "local" },
    {
      id: "proxy:relay-1#1",
      kind: "proxy",
      outboundID: "relay-1",
      address: "203.0.113.9:8443",
      addressSource: "configured",
      attempt: 1,
    },
    {
      id: "proxy:relay-2#2",
      kind: "proxy",
      outboundID: "relay-2",
      address: "198.51.100.7:1080",
      addressSource: "socket",
      attempt: 2,
    },
    {
      id: "target",
      kind: "target",
      address: "example.com:443",
      addressSource: "configured",
      host: "example.com",
      port: "443",
    },
  ],
  edges: [
    {
      from: "local",
      to: "proxy:relay-1#1",
      kind: "dial",
      target: "example.com:443",
      duration: 30_000_000_000,
      observed: true,
      success: false,
      error: "dial tcp 203.0.113.9:8443: connect: connection refused",
      phase: "connect",
      reason: "connect_refused",
    },
    {
      from: "local",
      to: "proxy:relay-2#2",
      kind: "dial",
      target: "example.com:443",
      duration: 51_000_000,
      observed: true,
      success: true,
    },
    {
      from: "proxy:relay-2#2",
      to: "target",
      kind: "tunnel",
      target: "example.com:443",
      observed: true,
      success: true,
    },
  ],
};

/** Router.Dial seeds the recorder (AddLocal + AddTarget) before anything
 *  dials, so a request that died in route resolution has both nodes and zero
 *  edges — the target isolated, nothing to walk. */
const NO_EDGES_GRAPH: PathGraph = {
  nodes: [
    { id: "local", kind: "local" },
    {
      id: "target",
      kind: "target",
      address: "example.com:443",
      addressSource: "configured",
      host: "example.com",
      port: "443",
    },
  ],
  edges: [],
};

/** A reachability-probe row: Chain [HopLocal, outboundID], Target the
 *  outbound's own server address, and NO target node — the probe never had a
 *  destination beyond the server itself. */
const REACHABILITY_GRAPH: PathGraph = {
  nodes: [
    { id: "local", kind: "local" },
    {
      id: "proxy:work",
      kind: "proxy",
      outboundID: "work",
      address: "203.0.113.9:8443",
      addressSource: "socket",
      attempt: 1,
    },
  ],
  edges: [
    {
      from: "local",
      to: "proxy:work",
      kind: "stack",
      duration: 12_000_000,
      observed: true,
      success: true,
    },
  ],
};

// --- buildPathView: the walk ------------------------------------------------

describe("buildPathView", () => {
  it("returns undefined for no graph at all", () => {
    expect(buildPathView(undefined)).toBeUndefined();
  });

  it("returns undefined for a graph with neither nodes nor edges", () => {
    expect(buildPathView({ nodes: [], edges: [] })).toBeUndefined();
    // Snapshot() returns nil — the key is absent — for a row that recorded
    // nothing, which reads as `{}` once JSON round-trips an empty object.
    expect(buildPathView({})).toBeUndefined();
  });

  it("walks a direct route into a two-step strip with no proxy node", () => {
    const v = view(DIRECT_GRAPH);
    expect(v.strip.map((s) => s.id)).toEqual(["local", "target"]);
    expect(v.stripLinks).toHaveLength(1);
    expect(v.stripLinks[0]!.kind).toBe("stack");
    expect(v.extras).toHaveLength(0);
    // A direct route is the ABSENCE of a proxy: nothing may invent one.
    expect(v.steps.filter((s) => s.kind === "proxy")).toHaveLength(0);
    expect(v.failed).toBe(false);
    expect(v.failure).toBe("");
  });

  it("walks a single proxy hop, keeping the untimed tunnel leg on the strip", () => {
    const v = view(PROXY_GRAPH);
    expect(v.strip.map((s) => s.label)).toEqual([
      "local",
      "relay-1",
      "example.com:443",
    ]);
    expect(v.stripLinks).toHaveLength(2);
    expect(v.stripLinks.map((l) => l.kind)).toEqual(["dial", "tunnel"]);
    // stripLinks is index-aligned with strip.slice(1).
    expect(v.stripLinks).toHaveLength(v.strip.length - 1);
    expect(v.stripLinks[0]!.timed).toBe(true);
    expect(v.stripLinks[0]!.duration).toBe(42_000_000);
    // The engine OMITS duration for an untimed leg; absent and 0 are the same
    // fact, and neither may render as "0ns".
    expect(v.stripLinks[1]!.timed).toBe(false);
    expect(v.stripLinks[1]!.duration).toBe(0);
  });

  it("treats an explicit zero duration as untimed", () => {
    const g: PathGraph = {
      nodes: [{ id: "local", kind: "local" }, { id: "target", kind: "target" }],
      edges: [
        { from: "local", to: "target", kind: "stack", duration: 0, observed: true, success: true },
      ],
    };
    const v = view(g);
    expect(v.stripLinks[0]!.timed).toBe(false);
  });

  it("takes the winning attempt and keeps every failed attempt in extras", () => {
    const v = view(FAILOVER_GRAPH);
    expect(v.strip.map((s) => s.id)).toEqual([
      "local",
      "proxy:relay-2#2",
      "target",
    ]);
    expect(v.stripLinks).toHaveLength(2);
    expect(v.extras).toHaveLength(1);
    expect(v.extras[0]!.onStrip).toBe(false);
    expect(v.extras[0]!.to).toBe("proxy:relay-1#1");
    expect(v.extras[0]!.ok).toBe(false);
    // The loser keeps its OWN classification, not a copy of the row's.
    expect(v.extras[0]!.failure).toBe("connection refused");
    expect(v.extras[0]!.phase).toBe("connect");
    expect(v.extras[0]!.reason).toBe("connect_refused");
    expect(v.extras[0]!.detail).toBe(
      "dial tcp 203.0.113.9:8443: connect: connection refused",
    );
    // A route that eventually won still contains a failed leg.
    expect(v.failed).toBe(true);
    // The view's headline failure is the strip's when the strip has one, else
    // the first extra's — here the strip succeeded, so the attempt that died.
    expect(v.failure).toBe("connection refused");
    expect(legCountSummary(v)).toBe("3 legs · 1 failed");
  });

  it("exposes the attempt number on a failover node, and 0 without one", () => {
    const v = view(FAILOVER_GRAPH);
    const byId = new Map(v.steps.map((s) => [s.id, s]));
    expect(byId.get("proxy:relay-2#2")!.attempt).toBe(2);
    expect(byId.get("proxy:relay-1#1")!.attempt).toBe(1);
    expect(byId.get("local")!.attempt).toBe(0);
    expect(view(PROXY_GRAPH).steps.find((s) => s.id === "local")!.attempt).toBe(0);
  });

  it("marks a node reached only when a SUCCESSFUL leg arrived at it", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:r", kind: "proxy", outboundID: "r" },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        {
          from: "local",
          to: "proxy:r",
          kind: "dial",
          observed: true,
          success: false,
          error: "dial tcp: connect: connection refused",
          phase: "connect",
          reason: "connect_refused",
        },
      ],
    };
    const v = view(g);
    expect(v.strip.map((s) => s.id)).toEqual(["local", "proxy:r"]);
    // The local node is reached by fiat: the request started there.
    expect(v.steps.find((s) => s.id === "local")!.reached).toBe(true);
    expect(v.steps.find((s) => s.id === "proxy:r")!.reached).toBe(false);
    expect(v.steps.find((s) => s.id === "target")!.reached).toBe(false);
    expect(v.failed).toBe(true);
    expect(v.failure).toBe("connection refused");
    // The failed leg IS the strip's only leg, so it renders as the strip's
    // broken arrow rather than as a leftover.
    expect(v.stripLinks[0]!.onStrip).toBe(true);
    expect(v.extras).toHaveLength(0);
  });

  it("falls back to the phase words when a leg keeps no usable reason", () => {
    const g: PathGraph = {
      nodes: [{ id: "local", kind: "local" }, { id: "target", kind: "target" }],
      edges: [
        {
          from: "local",
          to: "target",
          kind: "stack",
          observed: true,
          success: false,
          error: "boom",
          phase: "connect",
          reason: "unknown",
        },
      ],
    };
    // "unknown" carries no information, so probeSpec lets the phase speak;
    // assert against the shared function rather than re-pinning its string.
    expect(view(g).failure).toBe(failureLabel("connect", "unknown"));
    expect(view(g).stripLinks[0]!.failure).toBe(failureLabel("connect", "unknown"));
  });

  it("words a leg with neither phase nor reason as a bare failure", () => {
    const g: PathGraph = {
      nodes: [{ id: "local", kind: "local" }, { id: "target", kind: "target" }],
      edges: [
        { from: "local", to: "target", kind: "stack", observed: true, success: false, error: "boom" },
      ],
    };
    expect(view(g).failure).toBe(failureLabel(undefined, undefined));
    expect(view(g).failure).toBe("request failed");
  });

  it("keeps a leg whose phase the classifier bounded away but whose reason survived", () => {
    // classifyLeg bounds the phase to what one leg could have reached and can
    // legitimately leave it EMPTY while keeping the reason.
    const g: PathGraph = {
      nodes: [{ id: "local", kind: "local" }, { id: "target", kind: "target" }],
      edges: [
        {
          from: "local",
          to: "target",
          kind: "stack",
          observed: true,
          success: false,
          error: "i/o timeout",
          reason: "timeout",
        },
      ],
    };
    const link = view(g).stripLinks[0]!;
    expect(link.phase).toBe("");
    expect(link.reason).toBe("timeout");
    expect(link.failure).toBe("timed out");
  });

  it("walks a route-resolution failure as a lone local node with no legs", () => {
    const v = view(NO_EDGES_GRAPH);
    expect(v.strip.map((s) => s.id)).toEqual(["local"]);
    expect(v.links).toHaveLength(0);
    // The target is still a node — the row should say what it tried to reach —
    // but nothing reached it.
    expect(v.steps).toHaveLength(2);
    expect(v.steps.find((s) => s.id === "target")!.reached).toBe(false);
    expect(legCountSummary(v)).toBe("no legs");
  });

  it("walks a multi-hop chain through every hop in order", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a", kind: "proxy", outboundID: "a", attempt: 1 },
        { id: "proxy:b", kind: "proxy", outboundID: "b", attempt: 1 },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        { from: "local", to: "proxy:a", kind: "dial", observed: true, success: true },
        { from: "proxy:a", to: "proxy:b", kind: "tunnel", observed: true, success: true },
        { from: "proxy:b", to: "target", kind: "tunnel", observed: true, success: true },
      ],
    };
    const v = view(g);
    expect(v.strip.map((s) => s.label)).toEqual(["local", "a", "b", "example.com:443"]);
    expect(v.stripLinks).toHaveLength(3);
    expect(v.extras).toHaveLength(0);
  });

  it("walks the collapsed re-dial as the route and keeps the superseded leg in the pane", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a", kind: "proxy", outboundID: "a", attempt: 1 },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        { from: "local", to: "proxy:a", kind: "dial", observed: true, success: true },
        {
          from: "local",
          to: "target",
          kind: "dial",
          collapsed: true,
          observed: true,
          success: true,
        },
      ],
    };
    const v = view(g);
    // Both legs leave local and both succeeded, but the collapsed one
    // re-dialed from the engine host and superseded whatever the earlier leg
    // established — it is the leg the request actually rode, so it is the
    // strip's route and the earlier success is pane material.
    expect(v.strip.map((s) => s.id)).toEqual(["local", "target"]);
    expect(v.stripLinks).toHaveLength(1);
    expect(v.stripLinks[0]!.collapsed).toBe(true);
    expect(v.extras).toHaveLength(1);
    expect(v.extras[0]!.to).toBe("proxy:a");
    expect(v.extras[0]!.onStrip).toBe(false);
  });

  it("walks the engine's real collapsed chain: the wasted tunnel stays in the pane", () => {
    // dialOutbound's collapsed branch, as the engine's own
    // TestDispatchPathMarksCollapsedHop pins it: a chain hop that cannot be
    // dialed through the previous conn (tunnel plugins implement no
    // ChainDialer) re-dials FROM LOCAL, and the tunnel the hop before it
    // established is still recorded — wasted, but real. Edges in observation
    // order; the collapsed dial and the target handshake it covered are the
    // legs that carried the request.
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a", kind: "proxy", outboundID: "a" },
        {
          id: "proxy:b",
          kind: "proxy",
          outboundID: "b",
          address: "203.0.113.40:1080",
          addressSource: "socket",
        },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        { from: "local", to: "proxy:a", kind: "dial", target: "example.com:443", duration: 900_000_000, observed: true, success: true },
        { from: "proxy:a", to: "proxy:b", kind: "tunnel", target: "example.com:443", observed: true, success: true },
        { from: "local", to: "proxy:b", kind: "dial", target: "example.com:443", duration: 120_000_000, collapsed: true, observed: true, success: true },
        { from: "proxy:b", to: "target", kind: "tunnel", target: "example.com:443", observed: true, success: true },
      ],
    };
    const v = view(g);
    // The strip is the route that carried the request: local → b → target.
    // The superseded hop does not appear on it, and the walk does not visit
    // it at all — proxy:a is only reachable over the wasted tunnel.
    expect(v.strip.map((s) => s.id)).toEqual(["local", "proxy:b", "target"]);
    expect(v.stripLinks.map((l) => l.kind)).toEqual(["dial", "tunnel"]);
    expect(v.stripLinks[0]!.collapsed).toBe(true);
    // The collapsed dial was bracketed on its own, so the strip arrow into
    // b shows a measured span rather than the wasted tunnel's "untimed".
    expect(v.stripLinks[0]!.timed).toBe(true);
    // Both proxy:a legs stay pane material, flagged off-strip.
    expect(v.extras.map((l) => `${l.from}->${l.to}`)).toEqual([
      "local->proxy:a",
      "proxy:a->proxy:b",
    ]);
    expect(v.extras.every((l) => !l.onStrip)).toBe(true);
    // Labels, not ids — and no superseded hop in the route a reader hovers.
    expect(pathTitle(v)).toBe("local → b → example.com:443");
    // A collapse reports what happened, not what was useful: nothing is
    // missing from this graph, so no caveat fires.
    expect(v.partial).toBe(false);
    expect(v.cycle).toBe(false);
    expect(v.partialReported).toBe(false);
    expect(v.synthesized).toBe(false);
    expect(v.failed).toBe(false);
    expect(v.failure).toBe("");
  });

  it("keeps a leg the engine could not observe, flagged as unobserved", () => {
    // The engine's documented partial-graph case: a plugin dialed where the
    // engine could not bracket it. Its OTHER legs are observed, which is what
    // keeps the graph from reading as synthesized-from-config.
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:p", kind: "proxy", outboundID: "p", attempt: 1 },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        { from: "local", to: "proxy:p", kind: "dial", duration: 9_000_000, observed: true, success: true },
        { from: "proxy:p", to: "target", kind: "dial", observed: false, success: true },
      ],
      partial: true,
    };
    const v = view(g);
    expect(v.links.find((l) => !l.observed)).toBeDefined();
    expect(v.partial).toBe(true);
    // The engine itself reported the graph incomplete; the walk found no
    // cycle of its own.
    expect(v.partialReported).toBe(true);
    expect(v.cycle).toBe(false);
    expect(v.synthesized).toBe(false);
  });

  it("reads a partial graph whose EVERY leg is unobserved as synthesized", () => {
    // The detection's known limit, pinned so it cannot drift: no engine
    // producer emits observed:false on every leg (path.go sets Observed:true
    // on both its edge literals), so all-unobserved + partial is the
    // structural signature of synthesizePathFromChain — and of nothing else.
    const g: PathGraph = {
      nodes: [{ id: "local", kind: "local" }, { id: "target", kind: "target" }],
      edges: [
        { from: "local", to: "target", kind: "dial", observed: false, success: true },
      ],
      partial: true,
    };
    expect(view(g).synthesized).toBe(true);
  });

  it("passes partial and dropped through, defaulting both to falsy", () => {
    const v = view({
      nodes: [
        { id: "local", kind: "local" },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        { from: "local", to: "target", kind: "stack", observed: true, success: true },
      ],
      partial: true,
      dropped: 3,
    });
    expect(v.partial).toBe(true);
    expect(v.partialReported).toBe(true);
    expect(v.cycle).toBe(false);
    expect(v.dropped).toBe(3);
    expect(view(DIRECT_GRAPH).partial).toBe(false);
    expect(view(DIRECT_GRAPH).dropped).toBe(0);
  });

  it("terminates on a cycle and flags the graph partial", () => {
    // The engine refuses self-loops and bounds nested upstreams, but a graph is
    // data: a malformed or future one must not hang the page.
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a", kind: "proxy", outboundID: "a", attempt: 1 },
        { id: "proxy:b", kind: "proxy", outboundID: "b", attempt: 1 },
      ],
      edges: [
        { from: "local", to: "proxy:a", kind: "dial", observed: true, success: true },
        { from: "proxy:a", to: "proxy:b", kind: "tunnel", observed: true, success: true },
        { from: "proxy:b", to: "proxy:a", kind: "tunnel", observed: true, success: true },
      ],
    };
    const v = view(g);
    expect(v.partial).toBe(true);
    // `partial` has two possible causes, and the pane's wording may only
    // claim the one that happened: here the WALK met the cycle, the wire
    // never said the graph was incomplete.
    expect(v.cycle).toBe(true);
    expect(v.partialReported).toBe(false);
    // The walk stopped before re-entering proxy:a, so the closing leg is an
    // extra rather than a strip arrow into a node already on the strip.
    expect(v.strip.map((s) => s.id)).toEqual(["local", "proxy:a", "proxy:b"]);
    expect(v.extras).toHaveLength(1);
    expect(v.extras[0]!.from).toBe("proxy:b");
  });

  it("does not throw on a leg pointing at an id the node list lacks", () => {
    const g: PathGraph = {
      nodes: [{ id: "local", kind: "local" }],
      edges: [
        { from: "local", to: "proxy:ghost", kind: "dial", observed: true, success: true },
      ],
    };
    const v = view(g);
    // A dangling leg cannot become a strip arrow (there is no chip for it);
    // it stays in the pane, labeled with the raw id — the only honest label.
    expect(v.strip.map((s) => s.id)).toEqual(["local"]);
    expect(v.extras).toHaveLength(1);
    expect(v.extras[0]!.route).toBe("local → proxy:ghost");
  });

  it("renders nodes in wire order even if an engine sends the target first", () => {
    const g: PathGraph = {
      nodes: [
        { id: "target", kind: "target", address: "example.com:443" },
        { id: "local", kind: "local" },
      ],
      edges: [
        { from: "local", to: "target", kind: "stack", observed: true, success: true },
      ],
    };
    const v = view(g);
    // `steps` (the node table) follows the wire; the STRIP still starts at
    // local, because the walk starts there regardless of node order.
    expect(v.steps.map((s) => s.id)).toEqual(["target", "local"]);
    expect(v.strip.map((s) => s.id)).toEqual(["local", "target"]);
  });

  it("survives duplicate node ids by resolving each to its first occurrence", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "target", kind: "target", address: "example.com:443" },
        { id: "target", kind: "target", address: "other.example:80" },
      ],
      edges: [
        { from: "local", to: "target", kind: "stack", observed: true, success: true },
      ],
    };
    const v = view(g);
    expect(v.strip.map((s) => s.id)).toEqual(["local", "target"]);
    expect(v.steps).toHaveLength(3);
    // First occurrence wins, so the label is stable rather than
    // whichever duplicate the Map happened to keep last.
    expect(v.strip[1]!.label).toBe("example.com:443");
  });

  it("passes an address with no provenance through as an empty source", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:p", kind: "proxy", outboundID: "p", address: "1.2.3.4:1080" },
      ],
      edges: [
        { from: "local", to: "proxy:p", kind: "dial", observed: true, success: true },
      ],
    };
    const step = view(g).steps.find((s) => s.id === "proxy:p")!;
    expect(step.address).toBe("1.2.3.4:1080");
    expect(step.addressSource).toBe("");
  });

  it("renders a tunnel-plugin proxy node that has no address at all", () => {
    // psiphon/tor/geph have no dialable socket address for the engine to
    // record; the node still has an outbound id to be known by.
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:psiphon-1", kind: "proxy", outboundID: "psiphon-1", attempt: 1 },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        { from: "local", to: "proxy:psiphon-1", kind: "dial", observed: true, success: true },
        { from: "proxy:psiphon-1", to: "target", kind: "tunnel", observed: true, success: true },
      ],
      partial: true,
    };
    const v = view(g);
    const step = v.steps.find((s) => s.id === "proxy:psiphon-1")!;
    expect(step.address).toBe("");
    expect(step.label).toBe("psiphon-1");
    expect(v.strip.map((s) => s.label)).toEqual([
      "local",
      "psiphon-1",
      "example.com:443",
    ]);
  });

  it("walks a reachability graph, which has no target node", () => {
    const v = view(REACHABILITY_GRAPH);
    expect(v.strip.map((s) => s.id)).toEqual(["local", "proxy:work"]);
    expect(v.steps.filter((s) => s.kind === "target")).toHaveLength(0);
    expect(v.failed).toBe(false);
  });

  it("prefers the first successful leg when several leave one node", () => {
    // Two winners out of the same node, neither collapsed (a graph no engine
    // produces today — the engine's own two-winner shape is the collapsed
    // chain above, where the re-dial wins): the walk must be deterministic —
    // first in wire order.
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a", kind: "proxy", outboundID: "a", attempt: 1 },
        { id: "proxy:b", kind: "proxy", outboundID: "b", attempt: 1 },
        { id: "target", kind: "target", address: "example.com:443" },
      ],
      edges: [
        { from: "local", to: "proxy:a", kind: "dial", observed: true, success: true },
        { from: "local", to: "proxy:b", kind: "dial", observed: true, success: true },
        { from: "proxy:b", to: "target", kind: "tunnel", observed: true, success: true },
      ],
    };
    const v = view(g);
    expect(v.strip.map((s) => s.id)).toEqual(["local", "proxy:a"]);
    expect(v.extras.map((l) => l.to)).toEqual(["proxy:b", "target"]);
  });

  it("takes the last attempt when none of them succeeded", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a#1", kind: "proxy", outboundID: "a", attempt: 1 },
        { id: "proxy:b#2", kind: "proxy", outboundID: "b", attempt: 2 },
      ],
      edges: [
        {
          from: "local",
          to: "proxy:a#1",
          kind: "dial",
          observed: true,
          success: false,
          error: "dial tcp: i/o timeout",
          phase: "connect",
          reason: "connect_timeout",
        },
        {
          from: "local",
          to: "proxy:b#2",
          kind: "dial",
          observed: true,
          success: false,
          error: "dial tcp: connect: connection refused",
          phase: "connect",
          reason: "connect_refused",
        },
      ],
    };
    const v = view(g);
    expect(v.strip.map((s) => s.id)).toEqual(["local", "proxy:b#2"]);
    expect(v.extras).toHaveLength(1);
    expect(v.extras[0]!.to).toBe("proxy:a#1");
    // The headline failure is the strip's own leg: the last attempt, which is
    // where the row gave up.
    expect(v.failure).toBe("connection refused");
    expect(legCountSummary(v)).toBe("2 legs · 2 failed");
  });

  it("walks a two-step strip made of a single stack leg", () => {
    const v = view(REACHABILITY_GRAPH);
    expect(v.strip).toHaveLength(2);
    expect(v.stripLinks).toHaveLength(1);
    expect(v.links).toHaveLength(1);
  });
});

// --- why a view is partial --------------------------------------------------

describe("the partial provenance fields", () => {
  // `partial` merges two causes; `cycle` and `partialReported` keep them
  // apart so the pane's wording claims only what happened. A renderer must
  // branch on `synthesized` first: the synthesizer sets partial:true on the
  // wire, so a synthesized view reads partialReported=true.

  it("is all-false for a complete engine graph", () => {
    const v = view(DIRECT_GRAPH);
    expect(v.partial).toBe(false);
    expect(v.cycle).toBe(false);
    expect(v.partialReported).toBe(false);
    expect(v.synthesized).toBe(false);
  });

  it("reports the engine's own partial flag without a cycle", () => {
    const v = view({ ...PROXY_GRAPH, partial: true });
    expect(v.partial).toBe(true);
    expect(v.cycle).toBe(false);
    expect(v.partialReported).toBe(true);
    expect(v.synthesized).toBe(false);
  });

  it("sets cycle without partialReported when only the walk met a cycle", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a", kind: "proxy", outboundID: "a", attempt: 1 },
      ],
      edges: [
        { from: "local", to: "proxy:a", kind: "dial", observed: true, success: true },
        { from: "proxy:a", to: "local", kind: "tunnel", observed: true, success: true },
      ],
    };
    const v = view(g);
    expect(v.partial).toBe(true);
    expect(v.cycle).toBe(true);
    expect(v.partialReported).toBe(false);
    expect(v.synthesized).toBe(false);
  });

  it("keeps both causes distinguishable when a cycle lands in a reported-partial graph", () => {
    const g: PathGraph = {
      nodes: [
        { id: "local", kind: "local" },
        { id: "proxy:a", kind: "proxy", outboundID: "a", attempt: 1 },
      ],
      edges: [
        { from: "local", to: "proxy:a", kind: "dial", observed: true, success: true },
        { from: "proxy:a", to: "local", kind: "tunnel", observed: true, success: true },
      ],
      partial: true,
    };
    const v = view(g);
    expect(v.partial).toBe(true);
    expect(v.cycle).toBe(true);
    expect(v.partialReported).toBe(true);
    // Some legs observed: an engine graph, not one this module invented.
    expect(v.synthesized).toBe(false);
  });

  it("reads a synthesized view as partialReported without a cycle", () => {
    // The synthesizer marks its graph partial:true as the marker the
    // `synthesized` heuristic reads — so partialReported is true on the
    // wire's behalf, and wording must branch on `synthesized` first.
    const v = view(synthesizePathFromChain(["relay-1"], "example.com:443"));
    expect(v.partial).toBe(true);
    expect(v.cycle).toBe(false);
    expect(v.partialReported).toBe(true);
    expect(v.synthesized).toBe(true);
  });

  it("is never synthesized without partialReported, and never cycles on a straight chain", () => {
    // Synthesis requires g.partial === true (it is one of the heuristic's
    // conjuncts), so synthesized without partialReported is unreachable;
    // pinned so a future tweak of the heuristic cannot silently allow it.
    const v = view(synthesizePathFromChain(["a", "b"], "example.com:443"));
    expect(v.synthesized).toBe(true);
    expect(v.partialReported).toBe(true);
    expect(v.cycle).toBe(false);
  });
});

// --- labels -----------------------------------------------------------------

describe("nodeLabel", () => {
  it("always calls the engine host 'local'", () => {
    expect(nodeLabel({ id: "local", kind: "local" })).toBe("local");
    // Even if it somehow carries an address: the host is the host.
    expect(nodeLabel({ id: "local", kind: "local", address: "127.0.0.1" })).toBe(
      "local",
    );
  });

  it("knows a proxy by its outbound id, then its address, then its id", () => {
    expect(
      nodeLabel({
        id: "proxy:relay-1",
        kind: "proxy",
        outboundID: "relay-1",
        address: "203.0.113.9:8443",
      }),
    ).toBe("relay-1");
    expect(nodeLabel({ id: "proxy:x", kind: "proxy", address: "1.2.3.4:1080" })).toBe(
      "1.2.3.4:1080",
    );
    expect(nodeLabel({ id: "proxy:x", kind: "proxy" })).toBe("proxy:x");
  });

  it("knows a target by its address, else host:port, else host, else id", () => {
    expect(
      nodeLabel({ id: "target", kind: "target", address: "example.com:443" }),
    ).toBe("example.com:443");
    expect(nodeLabel({ id: "target", kind: "target", host: "example.com", port: "443" })).toBe(
      "example.com:443",
    );
    // A portless target (probeOneHTTP defaults 443/80 only for the dial):
    // host alone, not "example.com:undefined".
    expect(nodeLabel({ id: "target", kind: "target", host: "example.com" })).toBe(
      "example.com",
    );
    expect(nodeLabel({ id: "target", kind: "target" })).toBe("target");
  });

  it("falls back to the caller's word, and to an em dash by default", () => {
    expect(nodeLabel(undefined)).toBe("—");
    expect(nodeLabel(undefined, "nothing")).toBe("nothing");
    expect(nodeLabel({ kind: "target" }, "nothing")).toBe("nothing");
  });

  it("labels a kind this build does not know by address, else id", () => {
    // An engine node id like "server:<host:port>" carries the locator twice;
    // the address is the readable one, and the id is what survives without it.
    expect(nodeLabel({ id: "server:1.2.3.4:1080", kind: "server", address: "1.2.3.4:1080" })).toBe(
      "1.2.3.4:1080",
    );
    expect(nodeLabel({ id: "server:1.2.3.4:1080", kind: "server" })).toBe(
      "server:1.2.3.4:1080",
    );
  });
});

describe("legLabel", () => {
  it("words each leg kind the engine emits", () => {
    expect(legLabel("dial")).toBe("dial");
    expect(legLabel("tunnel")).toBe("tunnel");
    expect(legLabel("stack")).toBe("stack");
    expect(legLabel("pass-through")).toBe("pass-through");
  });

  it("humanizes a slug from a newer engine instead of guessing", () => {
    expect(legLabel("quic_handshake")).toBe("quic handshake");
    expect(legLabel("some-new-kind")).toBe("some new kind");
  });

  it("says 'unknown' rather than nothing for an absent kind", () => {
    expect(legLabel(undefined)).toBe("unknown");
    expect(legLabel("")).toBe("unknown");
  });
});

describe("arrowGlyph", () => {
  it("is an arrow when the leg carried the request and a cross when it broke", () => {
    expect(arrowGlyph(true)).toBe("→");
    expect(arrowGlyph(false)).toBe("✕");
    // Shape, not just color: the two glyphs differ without any styling.
    expect(arrowGlyph(true)).not.toBe(arrowGlyph(false));
  });
});

// --- summaries, titles, search ---------------------------------------------

describe("pathTitle", () => {
  it("joins the route's labels and appends what broke", () => {
    expect(pathTitle(view(PROXY_GRAPH))).toBe(
      "local → relay-1 → example.com:443",
    );
    expect(pathTitle(view(FAILOVER_GRAPH))).toBe(
      "local → relay-2 → example.com:443 · connection refused",
    );
  });
});

describe("legCountSummary", () => {
  it("counts legs, singular and plural, and only mentions failures that exist", () => {
    expect(legCountSummary(view(DIRECT_GRAPH))).toBe("1 leg");
    expect(legCountSummary(view(PROXY_GRAPH))).toBe("2 legs");
    expect(legCountSummary(view(NO_EDGES_GRAPH))).toBe("no legs");
    expect(legCountSummary(view(FAILOVER_GRAPH))).toBe("3 legs · 1 failed");
  });
});

describe("pathHaystack", () => {
  it("indexes node ids, outbound ids, addresses and every leg's failure words", () => {
    const hay = pathHaystack(FAILOVER_GRAPH);
    expect(hay).toContain("relay-1");
    expect(hay).toContain("203.0.113.9:8443");
    expect(hay).toContain("example.com");
    expect(hay).toContain("connect_refused");
    expect(hay).toContain("connection refused");
    // A filter for the losing attempt's address finds the row.
    expect(hay).toContain("proxy:relay-1#1");
  });

  it("is empty for an absent graph, so a filter matches nothing extra", () => {
    expect(pathHaystack(undefined)).toBe("");
    expect(pathHaystack({})).toBe("");
  });
});

// --- synthesizing from a configured chain ----------------------------------

describe("synthesizePathFromChain", () => {
  it("builds local → proxy → target from a chain and target", () => {
    const g = synthesizePathFromChain(["relay-1"], "example.com:443");
    expect(g.nodes?.map((n) => n.id)).toEqual([
      "local",
      "proxy:relay-1",
      "target",
    ]);
    expect(g.edges).toHaveLength(2);
    expect(g.partial).toBe(true);
    // The engine never classified these legs, so none may carry a kind: a
    // stamped "dial" on a proxy→target leg would print a classification that
    // was never made. legLabel renders the omission as "unknown".
    expect(g.edges?.every((e) => e.kind === undefined)).toBe(true);
    // Every leg unobserved and the graph partial: that combination is what
    // buildPathView reads as "configured route, not measured".
    expect(g.edges?.every((e) => e.observed === false)).toBe(true);
    const v = view(g);
    expect(v.synthesized).toBe(true);
    expect(v.links.every((l) => l.kind === "")).toBe(true);
    expect(v.links.every((l) => l.kindLabel === "unknown")).toBe(true);
    expect(v.strip.map((s) => s.label)).toEqual([
      "local",
      "relay-1",
      "example.com:443",
    ]);
  });

  it("skips the 'local' row-kind sentinel rather than drawing it as a hop", () => {
    // A reachability row's chain is [HopLocal, outboundID]: "local" names the
    // row kind, not a proxy.
    const g = synthesizePathFromChain(["local", "work"], "203.0.113.9:8443");
    expect(g.nodes?.map((n) => n.id)).toEqual([
      "local",
      "proxy:work",
      "target",
    ]);
  });

  it("skips the 'probe' row-kind sentinel and keeps the route reference as the hop", () => {
    // An HTTP-probe row's chain is [HopProbe, route] where route is a
    // REFERENCE ("pool:x", "outbound:a", "chain:y"). Drawing the reference as
    // the hop is honest for configuration — and is why the flag must render.
    const g = synthesizePathFromChain(["probe", "pool:fast"], "https://example.com/ip");
    expect(g.nodes?.map((n) => n.id)).toEqual([
      "local",
      "proxy:pool:fast",
      "target",
    ]);
    expect(view(g).strip.map((s) => s.label)).toEqual([
      "local",
      "pool:fast",
      "https://example.com/ip",
    ]);
    expect(view(g).synthesized).toBe(true);
  });

  it("treats 'direct' as the absence of a proxy, not a proxy called direct", () => {
    const g = synthesizePathFromChain(["direct"], "example.com:443");
    expect(g.nodes?.map((n) => n.id)).toEqual(["local", "target"]);
    expect(g.nodes?.filter((n) => n.kind === "proxy")).toHaveLength(0);
    expect(view(g).strip.map((s) => s.label)).toEqual([
      "local",
      "example.com:443",
    ]);
  });

  it("builds target-only and hop-only graphs, and nothing at all from nothing", () => {
    expect(view(synthesizePathFromChain([], "example.com:443")).strip).toHaveLength(2);
    expect(view(synthesizePathFromChain(["relay-1"], undefined)).strip.map((s) => s.id)).toEqual([
      "local",
      "proxy:relay-1",
    ]);
    // No hops and no target: an empty graph, which buildPathView turns into
    // undefined — the em dash a cell shows for "nothing observed".
    expect(buildPathView(synthesizePathFromChain([], undefined))).toBeUndefined();
    expect(buildPathView(synthesizePathFromChain(undefined, ""))).toBeUndefined();
    // A chain of nothing but sentinels is still nothing to draw.
    expect(buildPathView(synthesizePathFromChain(["probe", "direct"], ""))).toBeUndefined();
  });

  it("is never mistaken for an engine graph, and an engine graph for it", () => {
    // The engine sets observed:true on every leg it records, so its partial
    // graphs stay unflagged…
    expect(view(DIRECT_GRAPH).synthesized).toBe(false);
    expect(
      view({ ...REACHABILITY_GRAPH, partial: true }).synthesized,
    ).toBe(false);
    // …and a synthesized one is always flagged.
    expect(
      view(synthesizePathFromChain(["relay-1"], "example.com:443")).synthesized,
    ).toBe(true);
  });
});

// --- walkability of a synthesized graph ------------------------------------

describe("a synthesized graph walks like an observed one", () => {
  it("has one strip leg per hop and no extras", () => {
    const g = synthesizePathFromChain(["a", "b"], "example.com:443");
    const v = view(g);
    expect(v.strip).toHaveLength(4);
    expect(v.stripLinks).toHaveLength(3);
    expect(v.stripLinks).toHaveLength(v.strip.length - 1);
    expect(v.extras).toHaveLength(0);
    expect(v.failed).toBe(false);
    // No leg is timed and none is observed — configuration has no durations to
    // claim and saw nothing happen. The route renders whole because the
    // "configured route, not measured" flag is what carries the caveat.
    expect(v.links.every((l) => !l.timed)).toBe(true);
    expect(v.links.every((l) => !l.observed)).toBe(true);
    // …and no leg carries a kind the engine never sent.
    expect(v.links.every((l) => l.kindLabel === "unknown")).toBe(true);
    expect(v.synthesized).toBe(true);
  });
});

// --- the wire types stay honest about optionality ---------------------------

describe("an engine graph read from JSON", () => {
  it("tolerates every omitempty field being absent", () => {
    // `id`/`kind`/`from`/`to`/`success`/`observed` carry no omitempty; the
    // rest do. A minimal-but-valid graph:
    const nodes: PathNode[] = [
      { id: "local", kind: "local" },
      { id: "target", kind: "target" },
    ];
    const edges: PathEdge[] = [
      { from: "local", to: "target", kind: "stack", observed: true, success: true },
    ];
    const v = view({ nodes, edges });
    expect(v.strip.map((s) => s.label)).toEqual(["local", "target"]);
    expect(v.steps[1]!.address).toBe("");
    expect(v.steps[1]!.addressSource).toBe("");
    expect(v.steps[1]!.attempt).toBe(0);
    expect(v.stripLinks[0]!.target).toBe("");
    expect(v.stripLinks[0]!.detail).toBe("");
    expect(v.stripLinks[0]!.failure).toBe("");
  });
});
