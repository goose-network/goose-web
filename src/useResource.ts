// src/useResource.ts — the CRUD state machine every resource page shares.
//
// Inbounds, outbounds, pools, chains and providers all do the same dance:
// list, open a draft, save, delete, report. Keeping it here means the five
// pages differ only in their form and their columns — and that a fix to the
// flow (confirm-before-delete, save feedback, validation) lands everywhere
// at once.

import { useCallback, useMemo, useState } from "react";
import { errMessage, useAsync } from "./useAsync";
import { useToast } from "./components/Notice";

export interface ResourceApi<T> {
  list: () => Promise<T[]>;
  save: (draft: T) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
}

export interface UseResourceOpts<T> {
  api: ResourceApi<T>;
  /** re-list when these change (usually just the Goose instance) */
  deps: unknown[];
  idOf: (row: T) => string;
  /** the draft a "New …" click starts from */
  blank: () => T;
  /** materialize optional containers so the form never guards undefined */
  normalize?: (row: T) => T;
  /** singular noun for messages: "inbound" */
  noun: string;
  /** client-side checks; non-empty result blocks the save */
  validate?: (draft: T) => Record<string, string>;
}

export function useResource<T>(opts: UseResourceOpts<T>) {
  const { api, idOf, blank, normalize = (r: T) => r, noun, validate } = opts;
  const { toast } = useToast();

  const { data, error, loading, reload } = useAsync(api.list, opts.deps);

  const [draft, setDraft] = useState<T | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const items = useMemo(() => data ?? [], [data]);

  const startCreate = useCallback(() => {
    setDraft(blank());
    setIsNew(true);
    setSaveError(null);
    setFieldErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEdit = useCallback(
    (row: T) => {
      setDraft(normalize(row));
      setIsNew(false);
      setSaveError(null);
      setFieldErrors({});
    },
    [normalize],
  );

  const cancel = useCallback(() => {
    setDraft(null);
    setSaveError(null);
    setFieldErrors({});
  }, []);

  const save = useCallback(async () => {
    if (draft === null) return;
    const errs = validate?.(draft) ?? {};
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setSaveError(null);
    try {
      await api.save(draft);
      const id = idOf(draft);
      toast(`${noun} “${id}” saved`);
      setDraft(null);
      reload();
    } catch (err) {
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, validate, api, idOf, noun, toast, reload]);

  const remove = useCallback(
    async (row: T) => {
      const id = idOf(row);
      try {
        await api.remove(id);
        toast(`${noun} “${id}” deleted`);
        reload();
      } catch (err) {
        toast(`Could not delete ${noun} “${id}”: ${errMessage(err)}`, "bad");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, idOf, noun, toast, reload],
  );

  return {
    items,
    loading,
    error,
    reload,
    idOf,
    draft,
    setDraft,
    isNew,
    startCreate,
    startEdit,
    cancel,
    saving,
    save,
    saveError,
    dismissSaveError: () => setSaveError(null),
    fieldErrors,
    remove,
  };
}

/** Shared shape of the id/required check every resource needs. */
export function requireId(id: string | undefined, label: string): Record<string, string> {
  return id === undefined || id.trim() === "" ? { id: `${label} is required` } : {};
}
