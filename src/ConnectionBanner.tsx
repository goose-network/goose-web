// src/ConnectionBanner.tsx — engine URL + token controls and live status.

import { useState } from "react";
import { useSdk } from "./sdk";

export function ConnectionBanner() {
  const { connection, setConnection, connecting, connectionError } = useSdk();
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [token, setToken] = useState(connection.token ?? "");

  if (!editing) {
    return (
      <div className="conn-banner">
        <span
          className={`conn-dot ${connectionError === null ? (connecting ? "" : "ok") : "bad"}`}
          aria-hidden="true"
        />
        <span className="conn-msg">
          {connection.baseUrl === ""
            ? "same-origin engine"
            : connection.baseUrl}
          {connecting
            ? " — connecting…"
            : connectionError === null
              ? " — connected"
              : ` — ${connectionError}`}
        </span>
        <button onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }

  return (
    <div className="conn-banner">
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
        <label>
          Engine URL
          <input
            type="text"
            value={baseUrl}
            placeholder="http://127.0.0.1:9090 (empty = same origin)"
            onChange={(e) => setBaseUrl(e.target.value)}
            size={30}
          />
        </label>
        <label>
          Token
          <input
            type="password"
            value={token}
            placeholder="bearer token (optional)"
            onChange={(e) => setToken(e.target.value)}
            size={20}
          />
        </label>
        <button type="submit" className="primary">
          Connect
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setBaseUrl(connection.baseUrl);
            setToken(connection.token ?? "");
          }}
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
