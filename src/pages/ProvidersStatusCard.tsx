// src/pages/ProvidersStatusCard.tsx — live plugin observability.
//
// The engine tracks every dynamic provider's lifecycle and polls; plugins
// can add their own self-assessment through the StatusReporter contract
// (which tunnel is up, how many servers the signed list holds, ...). This
// card surfaces both so "is my provider working?" is one glance, not a
// docker-logs session.

import { useEffect } from "react";
import { useSdk } from "../sdk";
import { useAsync } from "../useAsync";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { formatTime } from "../format";
import type { ProviderStatus } from "@goose-network/goose-sdk";

// REFRESH_MS is the poll cadence: fast enough to catch a tunnel flipping
// to established, slow enough to be background noise on the admin API.
const REFRESH_MS = 5000;

export function ProvidersStatusCard() {
  const { goose } = useSdk();
  const { data, error, loading, reload } = useAsync(() => goose.listProviderStatus(), [goose]);

  // Live views go stale in seconds (polls, downloads, tunnels flipping
  // state), so the card refreshes on a timer — the useAsync hook keeps the
  // previous render visible while the next fetch is in flight.
  useEffect(() => {
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);

  const rows = data ?? [];
  const failing = rows.filter((p) => p.state === "error").length;

  const columns: Array<Column<ProviderStatus>> = [
    { key: "id", header: "ID", className: "mono", render: (p) => p.id },
    {
      key: "plugin",
      header: "Plugin",
      render: (p) => <span className="pill">{p.provider || "—"}</span>,
    },
    {
      key: "state",
      header: "State",
      render: (p) => (
        <>
          <StatePill state={p.state} />{" "}
          {p.message && (
            <span className="hint" style={{ margin: 0 }} title={p.message}>
              {p.message}
            </span>
          )}
        </>
      ),
    },
    {
      key: "engine",
      header: "Engine view",
      render: (p) => (
        <span className="hint" style={{ margin: 0 }}>
          {p.outbound_count} outbounds · polled {formatTime(p.last_poll_at)}
          {p.state === "running" ? " ✓" : ""}
        </span>
      ),
    },
    {
      key: "pools",
      header: "Pools",
      className: "mono",
      render: (p) => (p.pools ?? []).join(", ") || "—",
    },
    {
      key: "pluginstatus",
      header: "Plugin report",
      render: (p) =>
        p.plugin ? (
          <span className="hint" style={{ margin: 0 }}>
            <strong>{p.plugin.state}</strong>
            {p.plugin.message ? ` — ${p.plugin.message}` : ""}
            {pluginFacts(p).length > 0 && ` · ${pluginFacts(p).join(" · ")}`}
          </span>
        ) : (
          <span className="hint" style={{ margin: 0 }}>
            —
          </span>
        ),
    },
  ];

  return (
    <div className="card" data-testid="provider-status">
      <h3>
        Live provider status{" "}
        {rows.length > 0 && (
          <span className={failing > 0 ? "pill warn" : "pill ok"}>
            {failing > 0 ? `${failing} failing` : "all healthy"}
          </span>
        )}
      </h3>
      <DataTable
        caption="Live provider observability"
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id ?? p.provider ?? "?"}
        loading={loading && rows.length === 0}
        error={error}
        onRetry={reload}
        empty={
          <EmptyState
            title="No providers running"
            hint="Providers appear here as soon as one is configured — including ones that failed to start."
          />
        }
      />
    </div>
  );
}

// statePillClass maps the engine's phase words onto the shared pill classes.
export function statePillClass(state: string | undefined): string {
  if (state === "running") return "pill ok";
  if (state === "error") return "pill fail";
  if (state === "stopped") return "pill";
  return "pill warn"; // starting, establishing, and plugin-specific phases
}

// StatePill renders the engine's phase words with the shared pill classes.
function StatePill({ state }: { state: string | undefined }) {
  return <span className={statePillClass(state)}>{state || "—"}</span>;
}

// pluginFacts renders a plugin's detail map into "key value" fragments for
// the report column. Slices and scalars render as-is; values that need a
// table of their own (e.g. the psiphon pinned-tunnel list) still show their
// size. Exported for the page tests.
export function pluginFacts(p: ProviderStatus): string[] {
  const facts: string[] = [];
  for (const [k, v] of Object.entries(p.plugin?.details ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) facts.push(`${k}: ${v.length}`);
      continue;
    }
    facts.push(`${k}: ${String(v)}`);
  }
  return facts;
}
