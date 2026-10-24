// src/components/DataTable.tsx — one table with every state a list can be in.
//
// Loading (skeleton), error (with retry), empty (with a nudge) and populated
// all render from the same component, so no page can ship a table that
// forgets one of them.

import type { ReactNode } from "react";
import { Notice } from "./Notice";

export interface Column<T> {
  /** stable identity for React keys on cells */
  key: string;
  header: ReactNode;
  /** class for both th and td, e.g. "num" or "mono" */
  className?: string | undefined;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** shown instead of the table when there are no rows and no error */
  empty?: ReactNode | undefined;
  /** row under the table: counts, pagination, … */
  foot?: ReactNode | undefined;
  /** accessible name for the table */
  caption: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  empty,
  foot,
  caption,
}: DataTableProps<T>) {
  if (error !== null) {
    return (
      <Notice onDismiss={onRetry === undefined ? undefined : () => onRetry()}>
        {error}
        {onRetry !== undefined && (
          <>
            {" "}
            <button type="button" className="ghost" onClick={onRetry}>
              Retry
            </button>
          </>
        )}
      </Notice>
    );
  }

  if (loading && rows.length === 0) {
    return <TableSkeleton cols={columns.length} />;
  }

  if (rows.length === 0) {
    return (
      <>
        {empty ?? <div className="empty">Nothing here yet.</div>}
        {foot}
      </>
    );
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={c.className}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody style={loading ? { opacity: 0.55 } : undefined}>
            {rows.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {foot}
    </>
  );
}

/** Placeholder rows for the first load: same shape as the real table. */
export function TableSkeleton({
  cols,
  rows = 4,
}: {
  cols: number;
  rows?: number | undefined;
}) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div className="skeleton-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <span
              className="skeleton"
              key={c}
              style={{ maxWidth: `${Math.round(90 / cols)}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint !== undefined && <div>{hint}</div>}
      {action !== undefined && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
