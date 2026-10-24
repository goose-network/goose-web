// e2e/fixtures.mjs — deterministic sample data for visual review.
//
// The engine records metrics only when its metrics DB is writable, which is
// not guaranteed on a dev box. Screenshots stub the three read-only observation
// endpoints so the dashboard, exit-IP and probe tables always render with
// realistic rows; CRUD pages keep talking to the real engine.

const MIN = 60_000;

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

function probes() {
  const at = new Date(Date.now() - 4 * MIN).toISOString();
  return [
    {
      outboundID: "relay-1",
      poolID: "pool-relay",
      address: "10.0.0.1:1080",
      direct: { ok: true, at },
      relay: { ok: true, at },
      relayVia: "",
    },
    {
      outboundID: "relay-2",
      poolID: "pool-relay",
      address: "10.0.0.2:1080",
      direct: { ok: false, error: "dial tcp 10.0.0.2:1080: connect: no route to host", at },
      relay: { ok: true, at },
      relayVia: "relay-1",
    },
    {
      outboundID: "relay-3",
      poolID: "pool-relay",
      address: "10.0.0.3:1080",
      direct: { ok: false, error: "i/o timeout", at },
      relay: { ok: false, error: "relay refused", at },
      relayVia: "",
    },
  ];
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
  await page.route("**/api/chains/probes", (r) => r.fulfill(json(probes())));
}
