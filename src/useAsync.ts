// src/useAsync.ts — tiny fetch-on-mount hook shared by all panels.

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Re-run the fetch (e.g. after a mutation). */
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Refetch keeps the previous render at reduced opacity (no skeleton flash):
  // only the first load starts with data === undefined.
  const [tick, setTick] = useState(0);
  const cancel = useRef(false);

  const run = useCallback(fn, deps);

  useEffect(() => {
    cancel.current = false;
    setLoading(true);
    run()
      .then((v) => {
        if (!cancel.current) {
          setData(v);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancel.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancel.current) setLoading(false);
      });
    return () => {
      cancel.current = true;
    };
  }, [run, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, reload };
}

/** Human message for a failed mutation (4xx/5xx from the admin API). */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
