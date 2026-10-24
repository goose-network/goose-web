// src/components/PageHeader.tsx — one h1 per page, with its subtitle and any
// page-level actions on the same line when there is room.

import type { ReactNode } from "react";

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1 className="page-title">{title}</h1>
        {sub !== undefined && <p className="page-sub">{sub}</p>}
      </div>
      {actions !== undefined && <div className="toolbar" style={{ marginBottom: 0 }}>{actions}</div>}
    </header>
  );
}
