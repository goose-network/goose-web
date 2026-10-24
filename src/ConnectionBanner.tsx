// src/ConnectionBanner.tsx — engine URL + token controls and live status.
//
// Lives in the topbar as a status pill: dot + one line of state, always
// visible because every page depends on the connection. Editing opens a small
// panel instead of reflowing the bar.

import { useEffect, useRef, useState } from "react";
import { useSdk } from "./sdk";

export function ConnectionBanner() {
  const { connection, setConnection, connecting, connectionError } = useSdk();
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [token, setToken] = useState(connection.token ?? "");
  const panelRef = useRef<HTMLDivElement>(null);

  // Close the editor on outside click / Esc, like any popover.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(false);
    };
    const onDown = (e: MouseEvent) => {
      if (
        e.target instanceof Node &&
        !panelRef.current?.contains(e.target) &&
        !(e.target instanceof Element && e.target.closest(".conn-banner"))
      ) {
        setEditing(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [editing]);

  const urlLabel = connection.baseUrl === "" ? "same-origin engine" : connection.baseUrl;
  const state =
    connecting ? "connecting…" : connectionError === null ? "connected" : connectionError;

  return (
    <div className="conn-banner" style={{ position: "relative" }}>
      <span
        className={`conn-dot ${connectionError === null ? (connecting ? "" : "ok") : "bad"}`}
        aria-hidden="true"
      />
      <span
        className={`conn-msg${connectionError !== null ? " bad" : ""}`}
        title={`${urlLabel} — ${state}`}
      >
        <span className="conn-url">{urlLabel} — </span>
        {state}
      </span>
      <button
        type="button"
        className="ghost icon"
        aria-expanded={editing}
        onClick={() => {
          setBaseUrl(connection.baseUrl);
          setToken(connection.token ?? "");
          setEditing((v) => !v);
        }}
      >
        {editing ? "Done" : "Change"}
      </button>

      {editing && (
        <div className="conn-panel" ref={panelRef} role="dialog" aria-label="Engine connection">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setConnection({
                baseUrl: baseUrl.trim(),
                ...(token.trim() === "" ? {} : { token: token.trim() }),
              });
              setEditing(false);
            }}
          >
            <div className="field">
              <label htmlFor="conn-url">Engine URL</label>
              <input
                id="conn-url"
                type="text"
                value={baseUrl}
                placeholder="http://127.0.0.1:9090 (empty = same origin)"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <div className="field-hint">
                Empty means same origin: the dev proxy or a co-deployed build.
              </div>
            </div>
            <div className="field">
              <label htmlFor="conn-token">Token</label>
              <input
                id="conn-token"
                type="password"
                value={token}
                placeholder="bearer token (optional)"
                autoComplete="off"
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button type="submit" className="primary">
                Connect
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
