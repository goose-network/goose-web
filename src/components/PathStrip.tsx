// src/components/PathStrip.tsx — one row's observed network path, drawn inside
// a single table cell.
//
// The engine records every persisted row's trip through the network as an
// adjacency list (`core.PathGraph`): the engine host, each proxy server the
// request actually rode and the target are nodes, and each leg the engine
// observed between them is an edge carrying that leg's own span, outcome and —
// on failure — its classification. This renders that list twice over: once as a
// compact strip of the route the request took, once as a folded pane holding
// every leg and every node. A cell has room for the shape of a path and not
// for its detail, and a pool failover burns several attempts of which exactly
// one is the route — so the strip shows the winner and the pane keeps the
// losers, each with its own error.
//
// All the graph walking, labeling and wording lives in src/pages/pathGraph.ts
// and is unit-tested there; this file only renders what `buildPathView` hands
// it. That split is deliberate: the repo has no jsdom and no testing-library,
// so a .tsx component cannot be tested at all, and nothing that can be wrong
// belongs in one.
//
// No graph-drawing library and no row expansion: `DataTable` has neither a
// colSpan nor an expandable row, and the established idiom for detail inside a
// cell is a <details> — see `ResponseDetail` in ProbesPage.

import { Fragment } from "react";
import { formatDuration } from "../format";
import type { PathGraph } from "../runApi";
import {
  arrowGlyph,
  buildPathView,
  legCountSummary,
  pathTitle,
  synthesizePathFromChain,
  type PathLink,
  type PathStep,
  type PathView,
} from "../pages/pathGraph";

/** Reader words for `core.NodeKind`. The kinds are a closed set in the engine
 *  (path.go's NodeLocal/NodeProxy/NodeTarget), but a newer engine could add
 *  one, so an unknown kind falls back to the slug itself rather than a guess. */
const KIND_WORDS: Record<string, string> = {
  local: "the engine host",
  proxy: "proxy server",
  target: "request target",
};

/** Reader words for `core.AddrSource` — the column that says how trustworthy
 *  an address is. */
const SOURCE_WORDS: Record<string, string> = {
  socket: "socket peer",
  configured: "config",
};

export function PathStrip({
  path,
  chain,
  target,
}: {
  /** the row's observed path (`core.PathGraph`); absent on an older engine and
   *  on a row whose path was never observed */
  path?: PathGraph | undefined;
  /** the row's configured route (`core.RequestMetric.Chain`), used only to
   *  draw something when the engine sent no path graph */
  chain?: string[] | undefined;
  /** the row's target host:port, ditto */
  target?: string | undefined;
}) {
  // An engine older than the path recorder has no graph to send, but the row
  // still names the route it was configured with — worth drawing, and flagged
  // as configuration so it cannot be read as a measurement.
  const view =
    buildPathView(path) ?? buildPathView(synthesizePathFromChain(chain, target));
  // Neither: a row with no path and no chain, or an empty graph. An em dash,
  // not an empty strip — the cell has to say "nothing observed".
  if (view === undefined) return <span className="hint">—</span>;

  return (
    <div className="path-cell">
      <div className="path-strip" title={pathTitle(view)}>
        {view.strip.map((step, i) => {
          // stripLinks is index-aligned with strip.slice(1), so the leg into
          // this node is one back. A missing entry means the walk stopped
          // short of the chip, which is the pane's business, not an arrow.
          const link = i > 0 ? view.stripLinks[i - 1] : undefined;
          return (
            <Fragment key={`${i}:${step.id}`}>
              {link !== undefined && <LegArrow link={link} />}
              <NodeChip step={step} synthesized={view.synthesized} />
            </Fragment>
          );
        })}
        {view.synthesized && (
          <span className="path-flag">configured route, not measured</span>
        )}
      </div>

      <details className="path-detail">
        <summary>{legCountSummary(view)}</summary>
        {view.partial && <p className="hint">{partialNote(view)}</p>}
        {view.links.length === 0 && (
          <p className="hint">No legs were observed on this row.</p>
        )}
        <ol className="path-legs">
          {view.links.map((link, i) => (
            <LegRow
              key={`${i}:${link.from}->${link.to}`}
              link={link}
              synthesized={view.synthesized}
            />
          ))}
        </ol>
        <NodeTable view={view} />
      </details>
    </div>
  );
}

/** The glyph between two chips, carrying the leg's own outcome so a reader can
 *  see where a path broke without opening the pane. */
function LegArrow({ link }: { link: PathLink }) {
  return (
    <span
      className={link.ok ? "path-arrow" : "path-arrow bad"}
      title={arrowTitle(link)}
    >
      {arrowGlyph(link.ok)}
    </span>
  );
}

/** One node of the strip. A chip is never an empty box: a tunnel plugin
 *  (psiphon, tor, geph) has no dialable socket address for the engine to
 *  record, so it renders its label and says in the title that the address was
 *  not observable. On a synthesized strip the reason is different — the row
 *  carries no graph at all, so nothing was observable — and the title says
 *  that instead. */
function NodeChip({
  step,
  synthesized,
}: {
  step: PathStep;
  synthesized: boolean;
}) {
  return (
    <span className={chipClass(step)} title={nodeTitle(step, synthesized)}>
      <span className="mono">{step.label}</span>
      {/* The engine numbers failover attempts from 1 and omits the number when
          the node was not one of several, so 0 means "no attempt to show". */}
      {step.attempt > 0 && <sup className="path-attempt">{step.attempt}</sup>}
    </span>
  );
}

/** One leg of the pane: route, kind, span, dial string, then every caveat the
 *  engine attached to it and — on failure — the classified words with the raw
 *  Go error under them. On a synthesized view the caveat is different: these
 *  legs are this module's own invention from configuration, so an unobserved
 *  leg says where it came from rather than blaming an engine blindspot that
 *  was never reported — and the leg claims no outcome (see `legClass`). */
function LegRow({
  link,
  synthesized,
}: {
  link: PathLink;
  synthesized: boolean;
}) {
  return (
    <li className={legClass(link, synthesized)}>
      <span className="path-leg-route mono">{link.route}</span>
      <span className="path-leg-kind">{link.kindLabel}</span>
      {/* formatDuration would print "0ns" for an untimed leg, and 0 means
          "not separately timed" on the wire, never "instant" — hence the gate. */}
      <span className="path-leg-time">
        {link.timed ? formatDuration(link.duration) : "—"}
      </span>
      {link.target !== "" && (
        <span className="path-leg-target mono">dial string {link.target}</span>
      )}
      {!link.timed && <span className="path-leg-flag">not separately timed</span>}
      {!link.onStrip && (
        <span className="path-leg-flag">not shown on the path above</span>
      )}
      {link.collapsed && (
        <span className="path-leg-flag">chain collapsed: re-dialed from local</span>
      )}
      {!link.observed && (
        <span className="path-leg-flag">
          {synthesized
            ? "not observed — taken from this row's configured route"
            : "the engine could not see this leg"}
        </span>
      )}
      {!link.ok && link.failure !== "" && (
        <span className="path-leg-why">{link.failure}</span>
      )}
      {!link.ok && link.detail !== "" && (
        <code className="path-leg-err mono">{link.detail}</code>
      )}
    </li>
  );
}

/** Every node the engine recorded, including the ones no leg reached: a total
 *  failure leaves the target isolated, and the row should still say what it was
 *  trying to reach. On a synthesized view the nodes came from configuration,
 *  not from the engine, so the caption must not claim an observed path. */
function NodeTable({ view }: { view: PathView }) {
  return (
    <table className="path-nodes">
      <caption className="sr-only">
        {view.synthesized
          ? "Every node on the configured route — nothing on this row was observed"
          : "Every node on the observed path, including the nodes no leg reached"}
      </caption>
      <thead>
        <tr>
          <th scope="col">Node</th>
          <th scope="col">Kind</th>
          <th scope="col">Address</th>
          <th scope="col">Learned from</th>
          <th scope="col" className="num">
            Attempt
          </th>
        </tr>
      </thead>
      <tbody>
        {view.steps.map((step, i) => (
          <tr
            key={`${i}:${step.id}`}
            className={step.reached ? undefined : "unreached"}
          >
            <td className="mono">{step.label}</td>
            <td>{KIND_WORDS[step.kind] ?? step.kind}</td>
            <td className="mono">{step.address === "" ? "—" : step.address}</td>
            <td>{SOURCE_WORDS[step.addressSource] ?? "—"}</td>
            <td className="num">{step.attempt > 0 ? step.attempt : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function chipClass(step: PathStep): string {
  return `path-node kind-${step.kind}${step.reached ? "" : " unreached"}`;
}

function legClass(link: PathLink, synthesized: boolean): string {
  const cls = ["path-leg"];
  // A synthesized leg was never measured, so it must not wear an outcome's
  // color: the strip's "configured route, not measured" flag and the row's
  // own Status column own the outcome, and a green leg implies measurement.
  // The base `.path-leg` rule's neutral border is what renders then.
  if (!synthesized) cls.push(link.ok ? "ok" : "bad");
  if (link.collapsed) cls.push("collapsed");
  // Extras are marked in the class as well as in words, so the pane's
  // failed attempts stay distinguishable from the route that won even in
  // grayscale — color alone is not a signal.
  if (!link.onStrip) cls.push("off-strip");
  return cls.join(" ");
}

/** Hover text for a strip arrow: what kind of leg it was, its span (or that it
 *  has none), and on failure the same words the row's status pill uses. */
function arrowTitle(link: PathLink): string {
  const parts = [
    link.kindLabel,
    link.timed ? formatDuration(link.duration) : "not separately timed",
  ];
  if (!link.ok && link.failure !== "") parts.push(link.failure);
  return parts.join(" · ");
}

/** Hover text for a node chip: the label, what kind of node it is, where its
 *  address came from, and which failover attempt produced it. */
function nodeTitle(step: PathStep, synthesized: boolean): string {
  const parts = [
    step.label,
    KIND_WORDS[step.kind] ?? step.kind,
    addressNote(step, synthesized),
  ];
  if (step.attempt > 0) parts.push(`failover attempt ${step.attempt}`);
  if (!step.reached) parts.push("no successful leg reached this node");
  return parts.filter((p) => p !== "").join(" · ");
}

/** The address clause of a chip's title, worded by provenance: `core.AddrSource`
 *  is what makes an address trustworthy, and the two cases read very
 *  differently to someone debugging an exit IP. */
function addressNote(step: PathStep, synthesized: boolean): string {
  // The local node is the engine host itself; it has no address to record,
  // which is not the same thing as an address the engine could not observe.
  if (step.kind === "local") return "";
  if (step.address === "") {
    // A synthesized node was built from a chain id or a reference: the engine
    // sent no graph, so there is no dialable socket address to have missed —
    // do not diagnose tunnel-plugin blindness that was never reported.
    return synthesized
      ? "no address in this row's configured route"
      : "no address observable — this hop has no dialable socket address";
  }
  if (step.addressSource === "socket") {
    return `${step.address} — the peer the engine really connected to`;
  }
  if (step.addressSource === "configured") {
    return step.kind === "target"
      ? `${step.address} — the requested host:port; a dial resolves the name, so the socket peer can differ`
      : `${step.address} — as configured; a proxy may sit in front of it, so the real peer can differ`;
  }
  // An address with no provenance on the wire: show it and claim nothing about
  // where it came from.
  return step.address;
}

/** The pane's caveat when the view is partial — worded by WHY it is partial,
 *  because the three causes are three different claims and only one of them
 *  is the engine reporting missing legs:
 *  - `synthesized`: this module built the graph from configuration; nothing
 *    was observed, and no plugin was ever involved (the strip's own flag says
 *    "configured route, not measured", and the pane must not contradict it);
 *  - `cycle` without `partialReported`: only the walk stopped, on a graph the
 *    engine called complete;
 *  - `partialReported`: the engine itself says legs may be missing — a plugin
 *    dialed where it could not see, or a cap cut something. */
function partialNote(view: PathView): string {
  if (view.synthesized) {
    return "This row carries no observed path: the route above is its configured route, not a measurement.";
  }
  if (view.cycle && !view.partialReported) {
    return "Incomplete path: the walk met a cycle and stopped where a leg pointed back at a node already on the strip.";
  }
  const base =
    "Incomplete path: legs may be missing — a plugin can dial where the engine cannot see.";
  if (view.dropped <= 0) return base;
  return `${base} The graph's cap cut ${view.dropped} node${
    view.dropped === 1 ? "" : "s"
  }.`;
}
