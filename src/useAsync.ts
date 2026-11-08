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

/** The re-seed rule behind useSeededDraft, split out to be testable without a
 *  DOM. It answers "should the draft be (re-)seeded from `source` now?":
 *
 *  - no source yet (still loading): no — there is nothing to seed from;
 *  - no draft yet: yes — the first load seeds it;
 *  - otherwise only when a save asked for a refresh *and* a load has arrived
 *    since the hook last looked. Both halves matter: a background reload must
 *    not clobber what the reader is typing, and a refresh must not be spent on
 *    the source that was already in hand when it was asked for — that one
 *    still holds the pre-save value.
 *
 *  `sourceArrived` is the hook's business, not the caller's: it compares the
 *  source against the one its effect last saw.
 */
export function seedsDraft<S, D>(
  draft: D | null,
  source: S | undefined,
  sourceArrived: boolean,
  stale: boolean,
): boolean {
  if (source === undefined) return false;
  if (draft === null) return true;
  return stale && sourceArrived;
}

/**
 * useSeededDraft holds an edit draft seeded from asynchronously loaded data.
 *
 * It seeds on the first load and then survives later loads, so a background
 * refresh cannot clobber what the reader is typing. After a successful save,
 * call `refresh()`: the *next* load re-seeds the draft from what the server
 * actually stored. Re-seeding at save time instead would flash the pre-save
 * state, because the reload it asks for has not landed yet.
 *
 * A refresh whose reload *fails* leaves the flag set, so the load after it
 * re-seeds — the draft converges on what the server holds, at the cost of any
 * edit typed in between. That is the deliberate trade: the alternative is a
 * draft that never re-syncs after one failed round trip.
 *
 * `refreshKey` is `refresh()` for a save made by a *different* card: pass a
 * counter that the saving card bumps. It is read inside the seeding effect
 * rather than by an effect of the caller's own, because the reload it follows
 * can land in the same commit — an effect declared after this hook's would set
 * the flag too late for that load, and nothing would run it again.
 *
 * `draft === null` means "nothing loaded yet"; the card should render nothing
 * until it is set.
 */
export function useSeededDraft<S, D>(
  source: S | undefined,
  seed: (s: S) => D,
  refreshKey = 0,
) {
  const [draft, setDraft] = useState<D | null>(null);
  const stale = useRef(false);
  // The source object last looked at — not the one last seeded from. Recording
  // only the seeds would leave every later load looking new, so a refresh asked
  // for while a reload was in flight would be spent on the source already in
  // hand and the load carrying the saved value would arrive too late for it.
  const seenSource = useRef<S | undefined>(undefined);
  const seenKey = useRef(refreshKey);

  useEffect(() => {
    // seedsDraft's first rule, restated for the compiler: it is what narrows
    // `source` for the seed call below.
    if (source === undefined) return;
    if (refreshKey !== seenKey.current) {
      seenKey.current = refreshKey;
      stale.current = true;
    }
    const arrived = source !== seenSource.current;
    seenSource.current = source;
    if (!seedsDraft(draft, source, arrived, stale.current)) return;
    stale.current = false;
    setDraft(seed(source));
  }, [source, draft, seed, refreshKey]);

  const refresh = useCallback(() => {
    stale.current = true;
  }, []);

  return { draft, setDraft, refresh };
}
