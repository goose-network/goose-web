// src/pages/pathGraph.ts — turning a row's observed network path
// (`core.PathGraph`, declared in runApi.ts) into something a table cell can
// render: which nodes form the route, which leg each arrow is, and what every
// absent field means.
//
// The wire shape is an adjacency list: nodes (the engine host "local", each
// proxy server actually dialed, the target) and edges (one per observed leg,
// each with its own span, outcome and failure classification). A pool failover
// records one edge per attempt, so the graph routinely holds more legs than the
// route has hops — `buildPathView` walks it into a single strip (the winning
// route) while keeping every leftover leg (failed attempts, legs a collapse
// superseded, legs a plugin made where the engine could not see) in the pane.
//
// Honesty rules, mirroring the engine's own:
// - `duration` absent or 0 means "not separately timed", never "instantaneous"
//   — `timed` gates every duration render.
// - `observed: false` means the engine could not bracket the leg; it renders
//   with a flag rather than silently looking measured.
// - a node only counts as `reached` when a SUCCESSFUL leg arrived at it, so a
//   target nobody reached renders muted instead of implying arrival.
// - nothing is invented: an address the engine did not record stays absent, a
//   dangling edge id renders raw rather than through a guessed label, and a
//   route synthesized from the row's configured chain (an older engine sent no
//   graph) is flagged "configured route, not measured".
//
// Pure functions only — no React, no jsdom needed — and PathStrip.tsx renders
// exactly what this module hands it.

import type { PathEdge, PathGraph, PathNode } from "../runApi";
import { failureLabel } from "./probeSpec";

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

/** One node, ready to render. Every field is total ("" / 0 when the wire
 *  omitted it) so a component never re-decides what absent means. */
export interface PathStep {
  /** the engine's node id ("local", "target", "proxy:<outboundID>[#<n>]",
   *  "server:<host:port>") — an identity, not a label */
  id: string;
  /** reader label: outbound id for a proxy, host:port for a target */
  label: string;
  /** `core.NodeKind` as sent; an unknown kind renders as itself */
  kind: string;
  /** "" when the engine recorded no address (a tunnel-protocol hop has no
   *  dialable socket address — not observable is not the same as empty) */
  address: string;
  /** `core.AddrSource`: "socket" (the peer really connected to),
   *  "configured" (what config claims), or "" (no provenance sent) */
  addressSource: string;
  outboundID: string;
  /** 1-based failover attempt; 0 means the node was not one of several */
  attempt: number;
  /** a successful leg arrived here (the local node is reached by fiat: the
   *  request demonstrably started there) */
  reached: boolean;
}

/** One leg between two nodes, ready to render. */
export interface PathLink {
  /** raw node ids — identity for keys; `route` is the reader-facing pair */
  from: string;
  to: string;
  /** "relay-1 → example.com:443" — node labels, never raw ids (except for an
   *  id the graph's own node list does not contain, where the id IS the info) */
  route: string;
  /** `core.LegKind` as sent */
  kind: string;
  kindLabel: string;
  /** nanoseconds; 0 when untimed — render only when `timed` */
  duration: number;
  timed: boolean;
  ok: boolean;
  /** classified failure words (probeSpec's vocabulary), "" on success */
  failure: string;
  phase: string;
  reason: string;
  /** the raw Go error string, "" when the wire sent none */
  detail: string;
  /** the dial string handed to this leg, "" when absent */
  target: string;
  /** false only when the engine said it could not see the leg */
  observed: boolean;
  collapsed: boolean;
  /** true when this leg is one of the strip's arrows; false when it only
   *  appears in the pane (a failed failover attempt, a cycle, a dangling leg) */
  onStrip: boolean;
}

/** Everything PathStrip needs for one row. */
export interface PathView {
  /** every node in wire order, including ones no leg reached */
  steps: PathStep[];
  /** every leg: the strip's route first, then the leftovers in wire order */
  links: PathLink[];
  /** the walked route: local → … → target (or as far as legs got) */
  strip: PathStep[];
  /** index-aligned with strip.slice(1): stripLinks[i] is the leg into
   *  strip[i + 1] */
  stripLinks: PathLink[];
  /** the legs the walk did not take */
  extras: PathLink[];
  /** the engine flagged the graph incomplete, or the walk met a cycle */
  partial: boolean;
  /** the walk met a cycle: `partial` is true for two very different reasons,
   *  and the pane's wording must not blame plugin blind-spotting for what was
   *  only the walk stopping */
  cycle: boolean;
  /** `g.partial === true` on the wire: the ENGINE itself said the graph may
   *  be missing legs. A synthesized view reads true here too (the synthesizer
   *  marks its graph partial), so a renderer must branch on `synthesized`
   *  first */
  partialReported: boolean;
  /** nodes the engine's cap cut */
  dropped: number;
  /** any leg anywhere failed (a failover that eventually won still has a
   *  failed attempt in it) */
  failed: boolean;
  /** words for the first failure: strip legs first, then extras; "" when
   *  nothing failed */
  failure: string;
  /** the engine sent no graph and this view was built from the row's
   *  configured chain — configuration, not measurement */
  synthesized: boolean;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** Walks a graph into a route strip plus every leg it holds. Returns
 *  undefined when there is nothing to draw: no graph at all, or a graph with
 *  neither nodes nor edges (which is also what `Snapshot()` returns for a
 *  request that recorded nothing).
 *
 *  The walk starts at the local node (else the first node), and at each node
 *  takes the leg that ACTUALLY carried the request onward, in this order of
 *  preference:
 *  1. a successful leg marked `collapsed` — the engine could not dial this hop
 *     through the previous conn, so it threw that conn away and re-dialed from
 *     its own host: the collapsed leg superseded whatever the earlier leg out
 *     of this node established, and both legs report success;
 *  2. else the first successful leg — a pool failover's winner;
 *  3. else, when none succeeded, the last one: the furthest attempt the row
 *     got to.
 *  It stops at the target, at a node with no outgoing legs, at a leg pointing
 *  somewhere the node list does not contain (a dangling leg is pane material,
 *  not a strip arrow), and at a cycle — which sets `cycle` (and through it
 *  `partial`), because a graph that loops is a graph the walk could not
 *  finish. */
export function buildPathView(g: PathGraph | undefined): PathView | undefined {
  if (g === undefined) return undefined;
  const nodes = g.nodes ?? [];
  const edges = g.edges ?? [];
  if (nodes.length === 0 && edges.length === 0) return undefined;

  // First occurrence wins, so a (malformed) graph with duplicate ids resolves
  // every id to one node and the walk below always terminates.
  const nodeById = new Map<string, PathNode>();
  for (const n of nodes) {
    const id = n.id ?? "";
    if (id !== "" && !nodeById.has(id)) nodeById.set(id, n);
  }

  // Outgoing leg indices per node id, in wire order — the walk prefers a
  // collapsed winner and otherwise the earliest successful attempt, so order
  // is meaningful.
  const outgoing = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const from = e.from ?? "";
    const list = outgoing.get(from);
    if (list === undefined) outgoing.set(from, [i]);
    else list.push(i);
  });

  const labelOf = (id: string): string => {
    if (id === "") return "—";
    const n = nodeById.get(id);
    // An id the node list does not contain: the raw id is the only honest
    // label for it.
    return n === undefined ? id : nodeLabel(n);
  };

  const start = nodes.find((n) => n.kind === "local") ?? nodes[0];
  const stripIds: string[] = [];
  const stripEdgeIdx: number[] = [];
  const visited = new Set<string>();
  let cycle = false;
  let cur = start?.id ?? "";
  // Bounded by the node count: every iteration either breaks or moves to a
  // node not yet visited.
  for (let guard = 0; guard <= nodes.length + 1; guard++) {
    if (cur === "" || visited.has(cur)) break;
    visited.add(cur);
    stripIds.push(cur);
    if (nodeById.get(cur)?.kind === "target") break;
    const outs = outgoing.get(cur);
    if (outs === undefined) break;
    let pick = -1;
    for (const i of outs) {
      const e = edges[i];
      if (e?.success !== true) continue;
      // A collapsed leg re-dialed from the engine host and superseded whatever
      // the earlier leg out of this node established, so it — not the earlier
      // success — is the leg the request rode on.
      if (e.collapsed === true) {
        pick = i;
        break;
      }
      if (pick === -1) pick = i;
    }
    if (pick === -1) pick = outs[outs.length - 1] ?? -1;
    if (pick === -1) break;
    // Resolve the destination BEFORE taking the leg: a dangling or cyclic leg
    // stays an extra rather than becoming a strip arrow into nothing.
    const nxt = edges[pick]?.to ?? "";
    if (nxt === "" || !nodeById.has(nxt)) break;
    if (visited.has(nxt)) {
      cycle = true;
      break;
    }
    stripEdgeIdx.push(pick);
    cur = nxt;
  }

  // `reached` is about successful arrival: a node only a FAILED leg points at
  // (the isolated target of a request that died on its first dial) renders
  // muted rather than implying the request got there.
  const arrivedOk = new Set<string>();
  for (const e of edges) {
    if (e.success === true && e.to !== undefined && e.to !== "") {
      arrivedOk.add(e.to);
    }
  }

  const steps: PathStep[] = nodes.map((n) => {
    const id = n.id ?? "";
    return {
      id,
      label: nodeLabel(n),
      kind: n.kind ?? "",
      address: n.address ?? "",
      addressSource: n.addressSource ?? "",
      outboundID: n.outboundID ?? "",
      attempt: n.attempt ?? 0,
      reached: n.kind === "local" ? true : arrivedOk.has(id),
    };
  });

  const stripSet = new Set(stripEdgeIdx);
  const makeLink = (e: PathEdge, onStrip: boolean): PathLink => {
    const from = e.from ?? "";
    const to = e.to ?? "";
    const ok = e.success === true;
    return {
      from,
      to,
      route: `${labelOf(from)} → ${labelOf(to)}`,
      kind: e.kind ?? "",
      kindLabel: legLabel(e.kind),
      duration: e.duration ?? 0,
      // Absent and 0 are the same fact: the engine omits `duration` (omitempty)
      // for a leg it did not separately time, and an explicit 0 would render
      // as "0ns" — instantaneous — which it does not mean.
      timed: e.duration !== undefined && e.duration > 0,
      ok,
      failure: ok ? "" : failureLabel(e.phase, e.reason),
      phase: e.phase ?? "",
      reason: e.reason ?? "",
      detail: e.error ?? "",
      target: e.target ?? "",
      // `observed` carries no omitempty on the wire, so absent can only mean a
      // hand-built graph; claim visibility, not its absence, without evidence.
      observed: e.observed !== false,
      collapsed: e.collapsed === true,
      onStrip,
    };
  };

  const stripLinks: PathLink[] = [];
  for (const i of stripEdgeIdx) {
    const e = edges[i];
    if (e !== undefined) stripLinks.push(makeLink(e, true));
  }
  const extras: PathLink[] = [];
  edges.forEach((e, i) => {
    if (!stripSet.has(i)) extras.push(makeLink(e, false));
  });
  const links = [...stripLinks, ...extras];

  const stepById = new Map<string, PathStep>();
  for (const s of steps) {
    if (!stepById.has(s.id)) stepById.set(s.id, s);
  }
  const strip: PathStep[] = [];
  for (const id of stripIds) {
    const s = stepById.get(id);
    if (s !== undefined) strip.push(s);
  }

  const firstFailed =
    stripLinks.find((l) => !l.ok) ?? extras.find((l) => !l.ok);

  return {
    steps,
    links,
    strip,
    stripLinks,
    extras,
    partial: g.partial === true || cycle,
    cycle,
    partialReported: g.partial === true,
    dropped: g.dropped ?? 0,
    failed: links.some((l) => !l.ok),
    failure: firstFailed?.failure ?? "",
    // Every leg the engine itself records sets observed:true (path.go's two
    // PathEdge literals), so a partial graph whose legs are ALL unobserved can
    // only be one this module synthesized from configuration below.
    synthesized:
      g.partial === true &&
      edges.length > 0 &&
      edges.every((e) => e.observed === false),
  };
}

// ---------------------------------------------------------------------------
// Synthesizing from a configured chain
// ---------------------------------------------------------------------------

/** Row-kind sentinels and the route reference "direct" are not hops. "local"
 *  and "probe" name the KIND of row a chain belongs to (core.HopLocal on
 *  reachability rows, core.HopProbe on HTTP-probe rows); "direct" is the
 *  ABSENCE of a proxy, exactly as it is in the engine — synthesizing a proxy
 *  node called "direct" would show a hop that does not exist. */
const CHAIN_SENTINELS = new Set(["local", "probe", "direct"]);

/** Builds a graph from a row's configured route (`chain`) and target, for
 *  rows from an engine older than path observation: the route is still worth
 *  drawing, but every leg is `observed: false` and the graph is `partial`, so
 *  `buildPathView` flags the result "configured route, not measured" and no
 *  leg can be mistaken for a timing. A probe row's chain names the route
 *  REFERENCE ("pool:x", "outbound:a"), which is honest here for the same
 *  reason: this is configuration, not observation.
 *
 *  With neither a hop nor a target there is nothing to draw, and the graph is
 *  empty — `buildPathView` turns that into undefined, i.e. an em dash.
 *
 *  The synthesized legs carry `success: true` because a configured route has no
 *  failure of its own to report — NOT as a claim that the request succeeded
 *  (the row's own status says that, and the "configured route, not measured"
 *  flag is what stops the strip being read as an outcome). They carry no
 *  `kind` either: the engine never classified these legs, and guessing ("dial"
 *  on a proxy→target leg) would print a classification it did not make —
 *  `legLabel` renders the omission as its documented "unknown". */
export function synthesizePathFromChain(
  chain: string[] | undefined,
  target: string | undefined,
): PathGraph {
  const hops = (chain ?? []).filter(
    (h) => h !== "" && !CHAIN_SENTINELS.has(h),
  );
  const hasTarget = target !== undefined && target !== "";
  if (hops.length === 0 && !hasTarget) return { nodes: [], edges: [] };

  const nodes: PathNode[] = [{ id: "local", kind: "local" }];
  const edges: PathEdge[] = [];
  let prev = "local";
  for (const h of hops) {
    const id = `proxy:${h}`;
    nodes.push({ id, kind: "proxy", outboundID: h });
    edges.push({ from: prev, to: id, observed: false, success: true });
    prev = id;
  }
  if (hasTarget && target !== undefined) {
    nodes.push({ id: "target", kind: "target", address: target });
    edges.push({
      from: prev,
      to: "target",
      observed: false,
      success: true,
    });
  }
  return { nodes, edges, partial: true };
}

// ---------------------------------------------------------------------------
// Labels and words
// ---------------------------------------------------------------------------

/** First non-empty of `vals`. */
function pick(vals: (string | undefined)[], fallback: string): string {
  for (const v of vals) {
    if (v !== undefined && v !== "") return v;
  }
  return fallback;
}

/** Reader label for a node. A proxy is known by its outbound id (stable,
 *  configured — an address can be a socket peer adopted mid-flight, which is
 *  the right thing to SHOW but the wrong thing to call it); a target by the
 *  host:port the request asked for; the engine host is always "local". */
export function nodeLabel(n: PathNode | undefined, fallback = "—"): string {
  if (n === undefined) return fallback;
  if (n.kind === "local") return "local";
  if (n.kind === "proxy") {
    return pick([n.outboundID, n.address, n.id], fallback);
  }
  if (n.kind === "target") {
    const hostPort =
      n.host !== undefined && n.host !== ""
        ? n.port !== undefined && n.port !== ""
          ? `${n.host}:${n.port}`
          : n.host
        : "";
    return pick([n.address, hostPort, n.id], fallback);
  }
  // A kind this build does not know: show the address if there is one (a
  // reader recognizes a locator), else the engine's own id — never a guess.
  return pick([n.address, n.id], fallback);
}

/** Reader words for `core.LegKind`. The engine's slugs are already English
 *  words; a slug a newer engine adds gets humanized rather than guessed at. */
const LEG_WORDS: Record<string, string> = {
  dial: "dial",
  tunnel: "tunnel",
  stack: "stack",
  // Current engines no longer emit this slug; kept so an older or forked
  // engine's pass-through legs still render as words.
  "pass-through": "pass-through",
};

export function legLabel(kind: string | undefined): string {
  if (kind === undefined || kind === "") return "unknown";
  return LEG_WORDS[kind] ?? kind.replace(/[-_]/g, " ");
}

/** The glyph between two strip chips: an arrow when the leg carried the
 *  request, a cross when it broke — shape as well as color, so the strip
 *  reads in grayscale. */
export function arrowGlyph(ok: boolean): string {
  return ok ? "→" : "✕";
}

// ---------------------------------------------------------------------------
// Summaries and search
// ---------------------------------------------------------------------------

/** Every searchable token in a graph — node ids, outbound ids, addresses, and
 *  each leg's classification and raw error — for the page-level filter box.
 *  "" for an absent graph, which `matches()` treats as matching nothing extra. */
export function pathHaystack(g: PathGraph | undefined): string {
  if (g === undefined) return "";
  const parts: string[] = [];
  for (const n of g.nodes ?? []) {
    parts.push(n.id ?? "", n.outboundID ?? "", n.address ?? "");
    parts.push(n.host ?? "", n.port ?? "");
  }
  for (const e of g.edges ?? []) {
    parts.push(e.phase ?? "", e.reason ?? "", e.error ?? "");
  }
  return parts.filter((p) => p !== "").join(" ");
}

/** Hover text for the whole strip: the route in labels, plus what broke when
 *  something did. */
export function pathTitle(v: PathView): string {
  const route = v.strip.map((s) => s.label).join(" → ");
  return [route, v.failure].filter((p) => p !== "").join(" · ");
}

/** The pane's <summary>: how many legs the row holds and how many failed —
 *  the count that makes a failover visible without opening anything. */
export function legCountSummary(v: PathView): string {
  const n = v.links.length;
  if (n === 0) return "no legs";
  const failed = v.links.filter((l) => !l.ok).length;
  const base = `${n} leg${n === 1 ? "" : "s"}`;
  return failed === 0 ? base : `${base} · ${failed} failed`;
}
