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
    const latency = Math.round((60 + 900 * Math.abs(Math.sin(i / 5)) + (i % 7) * 40) * 1e6);
    out.push({
      id: `m-${i}`,
      inboundID: inbounds[i % inbounds.length],
      user: users[i % users.length],
      network: i % 4 === 0 ? "tcp" : "udp",
      target: `https://${hosts[i % hosts.length]}/`,
      chain: chains[i % chains.length],
      latency,
      success: ok,
      error: ok ? undefined : "dial tcp: i/o timeout",
      reason: ok ? undefined : i % 4 === 3 ? undefined : METRIC_REASONS[i % 3],
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

/** Probe history rows, shaped like core.HTTPProbe on the wire — including the
 *  leg-attribution fields: phase/reason say where and why a failure broke,
 *  dialAddr/dialVia name the first-hop server and the outbound that served
 *  it, and the phase timings are nanosecond durations. The failure shapes
 *  cover all three legs — local→proxy (connect_refused), name resolution
 *  (dns_timeout) and proxy→target (body_timeout, which keeps the partial
 *  response) — so the Failure column and its filter have rows to classify. */
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
      out.push({
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
      });
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
