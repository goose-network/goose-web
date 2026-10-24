// src/pages/ChainProbesCard.tsx — auto-chain reachability probes.
//
// Pools with an access filter are probed: can the engine dial each member's
// server directly, and when the local network blocks it, can an access
// proxy relay to it? Members unreachable both ways are dropped from
// routing; members reachable only via relay get the relay prepended
// automatically.

import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
import { formatTime } from "../format";

export function ChainProbesCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(
    () => goose.listChainProbes(),
    [goose],
  );

  const rows = data ?? [];

  return (
    <div className="card">
      <div className="toolbar">
        <h2>Reachability probes (auto chains)</h2>
        <div className="spacer" />
        <button onClick={reload} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="hint">
        Latest verdicts for members of access-filtered pools. Relay-hop
        chains are built automatically from these results.
      </p>
      {error !== null ? (
        <div className="error-box">Failed to load probes: {error}</div>
      ) : rows.length === 0 && !loading ? (
        <div className="empty">
          No probes yet — configure a pool with an access filter
          (access_pool_id) to enable auto chains.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Outbound</th>
                <th>Pool</th>
                <th>Server</th>
                <th>Direct</th>
                <th>Via relay</th>
                <th>Relay</th>
                <th>Probed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const alive = p.direct?.ok === true || p.relay?.ok === true;
                return (
                  <tr key={p.outboundID ?? p.address}>
                    <td className="mono">{p.outboundID ?? ""}</td>
                    <td className="mono">{p.poolID ?? ""}</td>
                    <td className="mono">{p.address ?? "—"}</td>
                    <td>
                      <Verdict ok={p.direct?.ok === true} error={p.direct?.error} />
                    </td>
                    <td>
                      <Verdict ok={p.relay?.ok === true} error={p.relay?.error} />
                    </td>
                    <td className="mono">{p.relayVia ?? "—"}</td>
                    <td>
                      <span className={alive ? "ok" : "bad"}>
                        {alive ? "routed" : "dropped"}
                      </span>{" "}
                      {formatTime(p.relay?.at ?? p.direct?.at ?? "")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Verdict({ ok, error }: { ok: boolean; error: string | undefined }) {
  if (ok) return <span className="ok">reachable</span>;
  if (error === undefined) return <span>unknown</span>;
  return (
    <span className="bad" title={error}>
      blocked
    </span>
  );
}
