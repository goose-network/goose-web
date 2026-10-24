// src/pages/ChainProbesCard.tsx — auto-chain reachability probes.
//
// Pools with an access filter are probed: can the engine dial each member's
// server directly, and when the local network blocks it, can an access
// proxy relay to it? Members unreachable both ways are dropped from
// routing; members reachable only via relay get the relay prepended
// automatically.

import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { formatTime } from "../format";
import type { ProbeStatus } from "@goose-network/goose-sdk";

export function ChainProbesCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(
    () => goose.listChainProbes(),
    [goose],
  );

  const rows = data ?? [];
  const dropped = rows.filter((p) => !alive(p)).length;

  const columns: Array<Column<ProbeStatus>> = [
    { key: "ob", header: "Outbound", className: "mono", render: (p) => p.outboundID || "—" },
    { key: "pool", header: "Pool", className: "mono", render: (p) => p.poolID || "—" },
    { key: "server", header: "Server", className: "mono", render: (p) => p.address || "—" },
    { key: "direct", header: "Direct", render: (p) => <Verdict ok={p.direct?.ok === true} error={p.direct?.error} /> },
    { key: "relay", header: "Via relay", render: (p) => <Verdict ok={p.relay?.ok === true} error={p.relay?.error} /> },
    { key: "via", header: "Relay", className: "mono", render: (p) => p.relayVia || "—" },
    {
      key: "verdict",
      header: "Routing",
      render: (p) => (
        <>
          {alive(p) ? (
            <span className="pill ok">routed</span>
          ) : (
            <span className="pill fail">dropped</span>
          )}{" "}
          <span className="hint" style={{ margin: 0 }}>
            {formatTime(p.relay?.at ?? p.direct?.at ?? "")}
          </span>
        </>
      ),
    },
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2>Reachability probes (auto chains)</h2>
        {rows.length > 0 && (
          <span className={dropped > 0 ? "pill warn" : "pill ok"}>
            {dropped > 0 ? `${dropped} dropped` : "all routed"}
          </span>
        )}
        <div className="spacer" />
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="hint">
        Latest verdicts for members of access-filtered pools. Relay-hop chains
        are built automatically from these results.
      </p>
      <DataTable
        caption="Auto-chain reachability probes"
        columns={columns}
        rows={rows}
        rowKey={(p) => `${p.outboundID ?? ""}-${p.address ?? ""}`}
        loading={loading}
        error={error === null ? null : `Failed to load probes: ${error}`}
        onRetry={reload}
        empty={
          <EmptyState
            title="No probes yet"
            hint="Configure a pool with an access filter (access_pool_id) to enable auto chains."
          />
        }
      />
    </div>
  );
}

function alive(p: ProbeStatus): boolean {
  return p.direct?.ok === true || p.relay?.ok === true;
}

function Verdict({ ok, error }: { ok: boolean; error: string | undefined }) {
  if (ok) return <span className="status-ok">reachable</span>;
  if (error === undefined || error === "")
    return <span className="hint" style={{ margin: 0 }}>unknown</span>;
  return (
    <span className="status-bad" title={error}>
      blocked
    </span>
  );
}
