// src/components/FormCard.tsx — the draft-editor shell every create/edit form
// lives in: title, save/cancel, Esc-to-close, and a guard so closing a dirty
// form is a decision rather than an accident.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Notice } from "./Notice";

export interface FormCardProps {
  title: string;
  children: ReactNode;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean | undefined;
  saveLabel?: string | undefined;
  /** true while the draft differs from what the server last confirmed */
  dirty?: boolean | undefined;
  /** server-side rejection of the last save */
  error?: string | null | undefined;
  onDismissError?: (() => void) | undefined;
}

export function FormCard({
  title,
  children,
  onSave,
  onCancel,
  saving = false,
  saveLabel = "Save",
  dirty = false,
  error = null,
  onDismissError,
}: FormCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [discardArmed, setDiscardArmed] = useState(false);

  // Move focus into the form when it opens, so keyboard users land on the
  // first field instead of staying on the "New …" button they just pressed.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      "input:not([type=checkbox]), select, textarea",
    );
    first?.focus();
  }, []);

  const requestCancel = () => {
    if (dirty && !discardArmed) {
      setDiscardArmed(true);
      return;
    }
    onCancel();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.contains(document.activeElement)) {
        e.preventDefault();
        requestCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="card" ref={ref} role="region" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        {children}
        {error !== null && (
          <Notice onDismiss={onDismissError}>{error}</Notice>
        )}
        {discardArmed && (
          <Notice kind="info">
            Discard unsaved changes?{" "}
            <button type="button" className="danger" onClick={onCancel}>
              Discard
            </button>{" "}
            <button type="button" onClick={() => setDiscardArmed(false)}>
              Keep editing
            </button>
          </Notice>
        )}
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : saveLabel}
          </button>
          <button type="button" onClick={requestCancel} disabled={saving}>
            {dirty && discardArmed ? "Discard changes?" : "Cancel"}
          </button>
        </div>
      </form>
    </div>
  );
}
