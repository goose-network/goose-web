// e2e/fixtures.mjs — deterministic sample data for visual review.
//
// The engine records metrics only when its metrics DB is writable, which is
// not guaranteed on a dev box. Screenshots stub the read-only observation
// endpoints so the dashboard, exit-IP and probe tables always render with
// realistic rows; CRUD pages keep talking to the real engine.

const MIN = 60_000;

/** Failure-reason slugs the metrics stub cycles through (`core.RequestMetric.
 *  Reason`) — the same vocabulary the engine classifies with. Every fourth
 *  failed row gets none, standing in for a row recorded before classification
 *  existed, which the table must still render as a plain "failed". */
const METRIC_REASONS = ["connect_timeout", "dns_nxdomain", "proxy_timeout"];

// --- the observed network path (`core.PathGraph`) ---------------------------
//
// The engine records every persisted row's trip through the network as an
// adjacency list: a node for the engine host, one for each proxy server the
// request actually rode, one for the target, and an edge per leg it observed
// between them. internal/core/path.go is the source of truth for the field
// names below, and for two Go details that shape every graph in this file:
//
//   - `duration`, `attempt`, `address`, `addressSource`, `host`, `port`,
//     `target`, `collapsed`, `error`, `phase`, `reason` and `dropped` are all
//     `omitempty`, so a zero value NEVER reaches the wire. An untimed leg
//     therefore has no `duration` key at all — 0 would read as "instant" — and
//     a graph that dropped nothing has no `dropped` key.
//   - `observed` and `success` carry no omitempty, so every edge has both.
//
// Nodes come out in path order (local first, proxies in dial order, target
// last) and edges in observation order, which is what Snapshot() enforces.
// `chain` and `path` are separate fields: path.go calls the graph "strictly
// additive" over Chain, which keeps the configured route identity, so the two
// are not expected to line up hop for hop.

/** Split a "host:port" dial string back into the halves a target node stores
 *  separately. `port` is a string on the wire, not a number. */
function splitHostPort(hostPort) {
  const i = hostPort.lastIndexOf(":");
  return [hostPort.slice(0, i), hostPort.slice(i + 1)];
}

/** The engine host, where every path starts. AddLocal records an ID and a kind
 *  and nothing else — this node is the engine, not a socket it dialed. */
function pathLocal() {
  return { id: "local", kind: "local" };
}

/** A proxy server the request rode.
 *
 *  `addressSource` says how the address was learned: "socket" is the peer the
 *  engine really connected to, adopted only from a conn the leg produced, so a
 *  dial that failed leaves the address "configured" — what the outbound's
 *  config says the server is. Omit `address` entirely for a tunnel plugin
 *  (tor, psiphon, geph): its shape is a circuit, not a dialable host:port, so
 *  there is no address to record.
 *
 *  `attempt` is the 1-based pool attempt, absent when the node was not one of
 *  several. Only the second attempt on gets its own node ID
 *  ("proxy:<outboundID>#<n>"), so every failed member keeps its own address,
 *  error and classification instead of being overwritten by the winner. */
function pathProxy({ outboundID, address, addressSource, attempt }) {
  const node = {
    id: `proxy:${outboundID}${attempt > 1 ? `#${attempt}` : ""}`,
    kind: "proxy",
    outboundID,
  };
  if (address) {
    node.address = address;
    node.addressSource = addressSource;
  }
  if (attempt) node.attempt = attempt;
  return node;
}

/** The request's destination. `host`/`port` are the requested name; `address`
 *  is what the engine saw on the socket once a dial resolved it — the same
 *  split a probe row's own `dialAddr` field makes. A target reached through a
 *  proxy tunnel keeps its configured address, because no conn of its own was
 *  ever read off a socket; a bare stack dial adopts the resolved peer. */
function pathTarget({ host, port, address, addressSource = "configured" }) {
  return { id: "target", kind: "target", address, addressSource, host, port };
}

/** One leg. `duration` is a Go time.Duration in NANOSECONDS and must be left
 *  out (never set to 0) when the leg was not separately timed. `observed` is
 *  true on every leg the engine records — a leg it could not bracket is
 *  OMITTED with `partial` set on the graph instead — and false is reserved
 *  for a producer outside the engine (pathGraph.ts's synthesizePathFromChain),
 *  so no fixture in this file passes false. */
function pathLeg({
  from,
  to,
  kind,
  target,
  duration,
  collapsed,
  success,
  error,
  phase,
  reason,
}) {
  const edge = { from, to, kind };
  if (target) edge.target = target;
  if (duration > 0) edge.duration = duration;
  edge.observed = true;
  if (collapsed) edge.collapsed = true;
  edge.success = success;
  if (error) edge.error = error;
  if (phase) edge.phase = phase;
  if (reason) edge.reason = reason;
  return edge;
}

/** The sum of a graph's timed legs, in nanoseconds. */
function pathSpan(graph) {
  return graph.edges.reduce((total, edge) => total + (edge.duration ?? 0), 0);
}

/** The phase a failed leg's reason is classified with. These pairings are the
 *  engine's — internal/router/errclass.go returns each of these reasons with
 *  exactly one phase — and classifyLeg keeps them for the legs below: it drops
 *  a "dns" phase on a leg that did not leave the engine host and a "proxy"
 *  phase on a bare stack dial to the target, and no leg that fails here is
 *  either. Both keys stay absent when the row has no reason, so an unclassified
 *  row's leg keeps its raw error and claims no verdict of its own. */
const LEG_PHASE_BY_REASON = {
  connect_timeout: "connect",
  dns_nxdomain: "dns",
  proxy_timeout: "proxy",
};

/** The failure fields of a metrics row's broken leg: the row's own error
 *  string and the row's own reason, so the path pane and the Failure column
 *  can never disagree about one row. */
function pathFailure(row) {
  return {
    error: row.error,
    phase: LEG_PHASE_BY_REASON[row.reason],
    reason: row.reason,
  };
}

/** Shape (a): one proxy hop, arrived — the common case.
 *
 *  The dial leg's dial string is the REQUEST target, not the server's own
 *  address: on the final hop dialLayers hands the plugin `meta.Target()` and
 *  the server's address is what the node carries. The handshake toward the
 *  target happens inside that same bracketed call, so the recorder writes a
 *  second leg for it that was never separately timed.
 *
 *  On a failed row the dial is the leg that broke and the target node stands
 *  alone: a leg that never happened is not recorded, so nothing may be invented
 *  toward a destination the request never reached. */
function pathSingleProxyHop(row, hostPort) {
  const [host, port] = splitHostPort(hostPort);
  const arrived = row.success;
  const edges = [
    pathLeg({
      from: "local",
      to: "proxy:relay-1",
      kind: "dial",
      target: hostPort,
      duration: 42_300_000,
      success: arrived,
      ...(arrived ? null : pathFailure(row)),
    }),
  ];
  if (arrived) {
    edges.push(
      pathLeg({
        from: "proxy:relay-1",
        to: "target",
        kind: "tunnel",
        target: hostPort,
        success: true,
      }),
    );
  }
  return {
    nodes: [
      pathLocal(),
      pathProxy({
        outboundID: "relay-1",
        address: "203.0.113.9:1080",
        addressSource: arrived ? "socket" : "configured",
      }),
      pathTarget({ host, port, address: hostPort }),
    ],
    edges,
  };
}

/** Shape (b): a pool failover — one node and one leg PER ATTEMPT. Attempt 1
 *  burns its dial timeout and keeps its own address, error and classification;
 *  attempt 2 arrives and handshakes toward the target inside the same call, so
 *  the destination is reached only through the winner. The loser's address
 *  stays "configured": its dial produced no conn to read a peer off.
 *
 *  Attempts come from dialPoolSnapshot, which numbers them as it walks a pool's
 *  members, so a multi-attempt graph is a route-dial fact rather than something
 *  every dispatched request can produce: the dispatch path picks one member per
 *  chain layer and dials it.
 *
 *  On a failed row both members lost, so there is no arrival leg, the target
 *  stands alone, and the last attempt carries the row's own error — the member
 *  the pool tried last is the one the graph blames. */
function pathPoolFailover(row, hostPort) {
  const [host, port] = splitHostPort(hostPort);
  const won = row.success;
  const edges = [
    pathLeg({
      from: "local",
      to: "proxy:relay-1",
      kind: "dial",
      target: hostPort,
      duration: 5_001_400_000,
      success: false,
      error: "dial tcp 203.0.113.9:1080: i/o timeout",
      phase: "connect",
      reason: "connect_timeout",
    }),
    pathLeg({
      from: "local",
      to: "proxy:relay-2#2",
      kind: "dial",
      target: hostPort,
      duration: 38_700_000,
      success: won,
      ...(won ? null : pathFailure(row)),
    }),
  ];
  if (won) {
    edges.push(
      pathLeg({
        from: "proxy:relay-2#2",
        to: "target",
        kind: "tunnel",
        target: hostPort,
        success: true,
      }),
    );
  }
  return {
    nodes: [
      pathLocal(),
      pathProxy({
        outboundID: "relay-1",
        address: "203.0.113.9:1080",
        addressSource: "configured",
        attempt: 1,
      }),
      pathProxy({
        outboundID: "relay-2",
        address: "203.0.113.40:1080",
        addressSource: won ? "socket" : "configured",
        attempt: 2,
      }),
      pathTarget({ host, port, address: hostPort }),
    ],
    edges,
  };
}

/** Shape (c): a tunnel plugin hop the engine collapsed — the four-edge shape
 *  dialOutbound's collapsed branch really emits (router.go + core/path.go's
 *  through-fold; the engine's TestDispatchPathMarksCollapsedHop pins it).
 *
 *  `tor-1` is a tunnel plugin: its shape is a circuit, not a host:port, so its
 *  node carries no address at all. The engine dialed it from local (edge 1,
 *  timed) and that call's handshake reached toward `relay-2`, which the
 *  through-fold records as a second, untimed leg (edge 2). But `relay-2` could
 *  not be dialed THROUGH the tor conn — tunnel plugins implement no
 *  ChainDialer — so the engine threw the tor tunnel away ("prev is NOT
 *  consumed; the caller closes it") and re-dialed `relay-2` from the engine
 *  host: edge 3, `collapsed`, timed, From local. Edge 4 is the handshake
 *  toward the target inside that same bracketed call, so it is real but
 *  untimed. The graph reports what happened, not what was useful: the wasted
 *  tor legs stay in it.
 *
 *  The strip's route is therefore local → relay-2 → target — buildPathView
 *  prefers the collapsed winner over the earlier successful leg out of local,
 *  because the collapse superseded it — and the pane keeps both tor-1 legs as
 *  off-strip material. A collapse sets NO `partial`: nothing is missing from
 *  this graph. Neither proxy node carries an `attempt`: chain hops register
 *  through AddProxy, and only a pool failover numbers its attempts.
 *
 *  `relay-2`'s address is the peer the collapsed dial read off its own socket
 *  on success ("socket"); a failed dial produced no conn, so the node keeps
 *  what config says ("configured"). On a failed row the collapsed re-dial
 *  itself succeeded — the engine got to `relay-2` from local — and the failure
 *  lands on the tunnel leg into the target, carrying the row's own error and
 *  classification so the pane and the Failure column cannot disagree. */
function pathCollapsedTunnel(row, hostPort) {
  const [host, port] = splitHostPort(hostPort);
  const arrived = row.success;
  return {
    nodes: [
      pathLocal(),
      pathProxy({ outboundID: "tor-1" }),
      pathProxy({
        outboundID: "relay-2",
        address: "203.0.113.40:1080",
        addressSource: arrived ? "socket" : "configured",
      }),
      pathTarget({ host, port, address: hostPort }),
    ],
    edges: [
      pathLeg({
        from: "local",
        to: "proxy:tor-1",
        kind: "dial",
        target: hostPort,
        duration: 900_000_000,
        success: true,
      }),
      pathLeg({
        from: "proxy:tor-1",
        to: "proxy:relay-2",
        kind: "tunnel",
        target: hostPort,
        success: true,
      }),
      pathLeg({
        from: "local",
        to: "proxy:relay-2",
        kind: "dial",
        target: hostPort,
        duration: 120_000_000,
        collapsed: true,
        success: true,
      }),
      pathLeg({
        from: "proxy:relay-2",
        to: "target",
        kind: "tunnel",
        target: hostPort,
        success: arrived,
        ...(arrived ? null : pathFailure(row)),
      }),
    ],
  };
}

/** The three graph shapes the metrics rows cycle through, by index mod 3. Each
 *  is built from the row it sits on, so the target node names that row's own
 *  destination and the legs agree with that row's own outcome. */
const METRIC_PATHS = [pathSingleProxyHop, pathPoolFailover, pathCollapsedTunnel];

/** @param {number} n @param {number} spreadMs */
function metrics(n = 140, spreadMs = 55 * MIN) {
  const hosts = [
    "example.com:443",
    "api.github.com:443",
    "cdn.jsdelivr.net:443",
    "registry.npmjs.org:443",
    "ifconfig.me:80",
  ];
  const inbounds = ["in-http", "in-socks"];
  const users = ["", "alice", "bob"];
  const chains = [["pool-default"], ["pool-default", "pool-relay"], []];
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    // Spread unevenly so the trend line has shape, not a flat block.
    const t = now - Math.round((i / n) * spreadMs * (0.4 + 0.6 * Math.abs(Math.sin(i / 9))));
    const ok = i % 11 !== 3;
    const hostPort = hosts[i % hosts.length];
    const row = {
      id: `m-${i}`,
      inboundID: inbounds[i % inbounds.length],
      user: users[i % users.length],
      network: i % 4 === 0 ? "tcp" : "udp",
      target: `https://${hostPort}/`,
      chain: chains[i % chains.length],
      success: ok,
      error: ok ? undefined : "dial tcp: i/o timeout",
      reason: ok ? undefined : i % 4 === 3 ? undefined : METRIC_REASONS[i % 3],
    };
    // Every 7th row carries no graph at all: `path` is omitempty on the engine's
    // row, so the key is ABSENT on rows an older engine recorded, and the table
    // must fall back to drawing the configured chain for them.
    const path = i % 7 === 0 ? undefined : METRIC_PATHS[i % 3](row, hostPort);
    // A leg is part of the request it belongs to, so the row's own span cannot
    // be shorter than the legs it reports — and shape (b) burns five seconds on
    // a failed attempt, which the unpathed latency formula does not know about.
    const latency = Math.max(
      Math.round((60 + 900 * Math.abs(Math.sin(i / 5)) + (i % 7) * 40) * 1e6),
      path ? pathSpan(path) : 0,
    );
    out.push({
      ...row,
      path,
      latency,
      startedAt: new Date(t).toISOString(),
      finishedAt: new Date(t + latency / 1e6).toISOString(),
    });
  }
  return out.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
}

function exitChecks() {
  const out = [];
  const ids = ["relay-1", "relay-2", "relay-3", "psiphon-1", "sub-main-01"];
  const sites = ["ifconfig.me", "ipinfo.io", "api.ipify.org"];
  const now = Date.now();
  let k = 0;
  for (let round = 0; round < 4; round++) {
    for (const id of ids) {
      const site = sites[k % sites.length];
      const failed = id === "relay-3" && round < 2;
      out.push({
        id: `ec-${k}`,
        outboundID: id,
        site,
        exitIP: failed ? undefined : `203.0.${113 + (k % 3)}.${(k * 7) % 250}`,
        success: !failed,
        error: failed ? "proxy refused connection" : undefined,
        latency: Math.round((180 + (k * 137) % 2400) * 1e6),
        startedAt: new Date(now - round * 15 * MIN).toISOString(),
      });
      k++;
    }
  }
  return out;
}

/** The failure fields of a probe row's broken leg. The leg keeps the dial's own
 *  error; net/http's `Get "<url>": ` wrapper belongs to the row, which reports
 *  the whole request rather than one leg. Phase and reason are the row's own:
 *  classifyLeg reuses the row's classifier and then bounds the verdict to what
 *  that leg could have reached, and the two rows whose leg broke here (a proxy
 *  server that refused, a name that never resolved) both broke on the way out
 *  of the engine host, so both verdicts survive the bounding. */
function probeLegFailure(row) {
  return {
    error: row.error.replace(/^Get "[^"]*": /, ""),
    phase: row.phase,
    reason: row.reason,
  };
}

/** The observed path of one HTTP-probe row, derived from the row's own route
 *  and its own first-hop evidence (`dialAddr`, `dialVia`) so the pane and the
 *  Evidence columns cannot disagree.
 *
 *  A probe names its target node BEFORE any dial — probeOneHTTP's AddTarget,
 *  "so a probe that fails before any dial still says what it was reaching for"
 *  — which is why even the refused row carries three nodes, the last of them
 *  isolated. "direct" is the absence of a proxy rather than one, so a direct
 *  route's graph is local → target with one stack leg and no proxy node between
 *  them; a named route rides one timed dial to its server plus the untimed
 *  handshake toward the target that the same call covered; and a pool route
 *  numbers its pick as attempt 1, because a first-try success is the first
 *  attempt. */
function probePath(row) {
  const u = new URL(row.target);
  // AddTarget takes the URL's host and the port net/http will dial, which for a
  // URL with no explicit port is the scheme's default.
  const port = u.port === "" ? (u.protocol === "https:" ? "443" : "80") : u.port;
  const hostPort = `${u.hostname}:${port}`;
  const direct = row.route === "direct";
  // A body-phase failure broke AFTER the path was up: the recorder brackets
  // dials, so every leg on that row succeeded and the failure is the row's
  // phase, not a leg's.
  const broke = !row.success && row.phase !== "body";
  // The recorder brackets every route dial, successful or not, so the leg has
  // a span of its own even when the dial broke. The row above only carries
  // `routeDial` when the whole probe succeeded, so a row whose dial broke — or
  // whose failure came later, after the path was up — has no timing to copy and
  // derives the leg's span the same way this fixture derives routeDial.
  const dialSpan = row.routeDial ?? Math.round(row.latency * 0.35);
  const nodes = [pathLocal()];
  const edges = [];
  if (direct) {
    edges.push(
      pathLeg({
        from: "local",
        to: "target",
        kind: "stack",
        target: hostPort,
        duration: dialSpan,
        success: !broke,
        ...(broke ? probeLegFailure(row) : null),
      }),
    );
  } else {
    const proxyID = `proxy:${row.dialVia}`;
    nodes.push(
      pathProxy({
        outboundID: row.dialVia,
        address: row.dialAddr,
        // A refused dial produced no conn, so its server address stays what the
        // config says; the arrival adopted the peer off the socket.
        addressSource: broke ? "configured" : "socket",
        attempt: row.route.startsWith("pool:") ? 1 : undefined,
      }),
    );
    edges.push(
      pathLeg({
        from: "local",
        to: proxyID,
        kind: "dial",
        target: hostPort,
        duration: dialSpan,
        success: !broke,
        ...(broke ? probeLegFailure(row) : null),
      }),
    );
    if (!broke) {
      edges.push(
        pathLeg({
          from: proxyID,
          to: "target",
          kind: "tunnel",
          target: hostPort,
          success: true,
        }),
      );
    }
  }
  nodes.push(
    pathTarget({
      host: u.hostname,
      port,
      // A direct stack dial produced the conn the address was read off, so the
      // target node carries the resolved peer; through a tunnel there is no
      // socket of the target's own and the node keeps the requested host:port.
      address: direct && !broke ? row.dialAddr : hostPort,
      addressSource: direct && !broke ? "socket" : "configured",
    }),
  );
  return { nodes, edges };
}

/** Probe history rows, shaped like core.HTTPProbe on the wire — including the
 *  leg-attribution fields: phase/reason say where and why a failure broke,
 *  dialAddr/dialVia name the first-hop server and the outbound that served
 *  it, and the phase timings are nanosecond durations. The failure shapes
 *  cover all three legs — local→proxy (connect_refused), name resolution
 *  (dns_timeout) and proxy→target (body_timeout, which keeps the partial
 *  response) — so the Failure column and its filter have rows to classify.
 *  Every row also carries the observed path (`path`) those same fields are
 *  read off, so the strip and the row cannot tell different stories. */
function probes() {
  const routes = ["direct", "outbound:local-proxy", "pool:local"];
  const targets = ["https://ifconfig.me/ip", "https://api.example.com/v1/login"];
  const now = Date.now();
  const out = [];
  let k = 0;
  for (let round = 0; round < 4; round++) {
    for (const route of routes) {
      const target = targets[k % targets.length];
      const failure =
        route === "outbound:local-proxy" && round === 1
          ? {
              phase: "connect",
              reason: "connect_refused",
              error:
                "dial tcp 203.0.113.9:1080: connect: connection refused",
            }
          : route === "direct" && round === 2
            ? {
                phase: "dns",
                reason: "dns_timeout",
                error: `Get "${target}": dial tcp: lookup ${
                  target === "https://ifconfig.me/ip" ? "ifconfig.me" : "api.example.com"
                }: i/o timeout`,
              }
            : route === "pool:local" && round === 3
              ? {
                  phase: "body",
                  reason: "body_timeout",
                  // The headers arrived, so a body-phase failure keeps its
                  // status and the partial body — only the read died.
                  status: 200,
                  error:
                    "read tcp 203.0.113.40:33210->93.184.216.34:443: i/o timeout",
                }
              : null;
      const responded = failure === null || failure.status !== undefined;
      const status = responded
        ? (failure?.status ?? (k % 3 === 2 ? 404 : 200))
        : 0;
      const latency = Math.round((9 + ((k * 53) % 900)) * 1e6);
      const row = {
        id: `hp-${k}`,
        route,
        target,
        method: target.endsWith("/login") ? "POST" : "GET",
        status,
        headers: responded
          ? { "Content-Type": "application/json", "X-Echo": "yes" }
          : undefined,
        body: !responded
          ? ""
          : failure?.reason === "body_timeout"
            ? '{"hello": "wor'
            : `{"hello": "world", "n": ${k}}`,
        truncated: false,
        success: failure === null,
        error: failure?.error ?? "",
        phase: failure?.phase,
        reason: failure?.reason,
        // The first hop's evidence: a proxy route names the server and the
        // outbound behind it, a direct route names the target's own address,
        // and a dns_timeout never got far enough to record either.
        dialAddr:
          failure?.reason === "dns_timeout"
            ? undefined
            : route === "direct"
              ? "93.184.216.34:443"
              : route === "outbound:local-proxy"
                ? "203.0.113.9:1080"
                : "203.0.113.40:8080",
        dialVia:
          failure?.reason === "dns_timeout" || route === "direct"
            ? undefined
            : route === "pool:local"
              ? "local-2"
              : "local-proxy",
        routeDial: failure === null ? Math.round(latency * 0.35) : undefined,
        dns: failure === null ? Math.round(latency * 0.05) : undefined,
        connect: failure === null ? Math.round(latency * 0.1) : undefined,
        tls: failure === null ? Math.round(latency * 0.12) : undefined,
        ttfb: failure === null ? Math.round(latency * 0.2) : undefined,
        latency,
        startedAt: new Date(now - round * 15 * MIN).toISOString(),
      };
      // The graph is built from the row above, so the strip and the Evidence
      // columns read the same first hop and the same failure.
      row.path = probePath(row);
      out.push(row);
      k++;
    }
  }
  return out;
}

/** Install the stubs on a Playwright page. */
export async function stubObservability(page) {
  const json = (body) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/metrics**", (r) => r.fulfill(json(metrics())));
  await page.route("**/api/exit-checks?**", (r) => r.fulfill(json(exitChecks())));
  await page.route("**/api/exit-checks", (r) => r.fulfill(json(exitChecks())));
  await page.route("**/api/probes/results**", (r) => r.fulfill(json(probes())));
}
