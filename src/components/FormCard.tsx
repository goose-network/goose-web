// src/components/FormCard.tsx — the draft-editor shell every create/edit form
// lives in: title, save/cancel, Esc-to-close, and a guard so closing a dirty
// form is a decision rather than an accident.
//
// `variant` picks the chrome, never the behavior: either the bordered card a
// page puts its create form in, or the same form inline in a table cell under
// the row being edited. Both get one and the same <form>, footer, dirty guard
// and error notice, so moving an editor from the top of a page into the table
// changes where it renders and nothing about how it behaves.

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
  /** "card" (default): the bordered panel a page puts its create form in.
   *  "inline": no chrome of its own, for a form already sitting in a table
   *  cell — the table is inside the page's card, which is the surface the
   *  form renders on, so a card there reads as a box in a box. The cell
   *  supplies the spacing and the row above supplies the tint. Form, footer,
   *  guard and notices are identical either way. */
  variant?: "card" | "inline" | undefined;
  /** Take focus when the form mounts (default). Pass false when this mount is
   *  a *re-location* rather than an opening: a page that moves an already-open
   *  editor between placements would otherwise pull focus off whatever the
   *  operator was typing in — usually the filter box that moved it. */
  autoFocus?: boolean | undefined;
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
  variant = "card",
  autoFocus = true,
}: FormCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [discardArmed, setDiscardArmed] = useState(false);
  const inline = variant === "inline";

  // Move focus into the form when it opens, so keyboard users land on the
  // first field instead of staying on the "New …" / "Edit" button they just
  // pressed. Skipping disabled fields matters here and not just cosmetically:
  // Esc below only fires while focus is inside the form, and an id field locked
  // for the row being edited cannot take focus, so focusing "the first field"
  // unconditionally would leave focus out on the table and make Esc do nothing.
  useEffect(() => {
    if (!autoFocus) return;
    const first = ref.current?.querySelector<HTMLElement>(
      "input:not([type=checkbox]):not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    if (inline) {
      // Focus' own scroll would yank a long table around. Suppress it and
      // instead pull the editor just far enough into view — block: "nearest"
      // is a no-op when it already is — so the row it hangs off stays where the
      // operator left it and the page does not jump to the top of the table.
      first?.focus({ preventScroll: true });
      ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    first?.focus();
  }, [autoFocus, inline]);

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

  // One form body for both variants: the fields, the save rejection, the
  // two-step discard guard and the footer are not the kind of thing to keep in
  // sync by hand. Only the surrounding chrome differs.
  const body = (
    <>
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
    </>
  );

  if (inline) {
    return (
      <div className="form-inline" ref={ref} role="region" aria-label={title}>
        {body}
      </div>
    );
  }

  return (
    <div className="card" ref={ref} role="region" aria-label={title}>
      {body}
    </div>
  );
}
