// src/sdk.tsx — React glue for the goose TS SDK.
//
// The Goose instance is built from connection settings held in localStorage
// (baseUrl + optional bearer token) so the UI survives reloads without a
// build-time config. In dev, Vite proxies /api to the engine, so the
// default baseUrl is same-origin.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Goose, GooseApiError } from "@goose-network/goose-sdk";

export interface Connection {
  baseUrl: string;
  token?: string;
}

const STORAGE_KEY = "goose-web.connection";

function loadConnection(): Connection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const v = JSON.parse(raw) as Partial<Connection>;
      if (typeof v.baseUrl === "string" && v.baseUrl !== "") {
        return {
          baseUrl: v.baseUrl,
          ...(v.token === undefined || typeof v.token !== "string"
            ? {}
            : { token: v.token }),
        };
      }
    }
  } catch {
    // corrupted or unavailable storage; fall through to the default
  }
  return { baseUrl: "" };
}

interface SdkContextValue {
  goose: Goose;
  connection: Connection;
  setConnection: (c: Connection) => void;
  /** true while a connection change is being verified against the engine */
  connecting: boolean;
  /** last connection error, or null when connected */
  connectionError: string | null;
}

const SdkContext = createContext<SdkContextValue | null>(null);

export function SdkProvider({ children }: { children: ReactNode }) {
  const [connection, setConnectionState] = useState<Connection>(loadConnection);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Empty baseUrl means same-origin (the Vite dev proxy or a co-deployed
  // static build); the SDK then hits "/api/..." relative URLs.
  const goose = useMemo(
    () =>
      new Goose(
        connection.baseUrl,
        connection.token === undefined ? undefined : connection.token,
      ),
    [connection],
  );

  // Verify on mount and on every connection change so the header can show
  // connected/failed state instead of every panel failing one request later.
  const cancelVerify = useRef(false);
  useEffect(() => {
    cancelVerify.current = false;
    setConnecting(true);
    goose
      .getEngine()
      .then(() => {
        if (!cancelVerify.current) setConnectionError(null);
      })
      .catch((err: unknown) => {
        if (cancelVerify.current) return;
        setConnectionError(
          err instanceof GooseApiError
            ? `API error ${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
        );
      })
      .finally(() => {
        if (!cancelVerify.current) setConnecting(false);
      });
    return () => {
      cancelVerify.current = true;
    };
  }, [goose]);

  const setConnection = useCallback((c: Connection) => {
    setConnectionState(c);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    } catch {
      // storage unavailable; connection just won't persist
    }
  }, []);

  const value = useMemo(
    () => ({ goose, connection, setConnection, connecting, connectionError }),
    [goose, connection, setConnection, connecting, connectionError],
  );

  return <SdkContext.Provider value={value}>{children}</SdkContext.Provider>;
}

export function useSdk(): SdkContextValue {
  const v = useContext(SdkContext);
  if (v === null) throw new Error("useSdk must be used inside <SdkProvider>");
  return v;
}
