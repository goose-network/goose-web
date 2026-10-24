// src/components/ConfirmButton.tsx — two-step destructive action.
//
// Deletes here hit a live engine with no undo, so a single stray click must
// not be enough. First click arms the button (it says what will happen and
// turns solid); second click does it. Arming expires on its own and Esc or a
// click anywhere else disarms, so an armed delete can't sit waiting to fire.

import { useEffect, useRef, useState } from "react";

const ARM_MS = 4000;

export interface ConfirmButtonProps {
  onConfirm: () => void;
  /** idle label, e.g. "Delete" */
  label?: string | undefined;
  /** armed label; defaults to "Confirm <label>" */
  confirmLabel?: string | undefined;
  className?: string | undefined;
  title?: string | undefined;
  disabled?: boolean | undefined;
}

export function ConfirmButton({
  onConfirm,
  label = "Delete",
  confirmLabel,
  className = "danger",
  title,
  disabled = false,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const ref = useRef<HTMLButtonElement>(null);

  const disarm = () => {
    setArmed(false);
    window.clearTimeout(timer.current);
  };

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") disarm();
    };
    // Capture phase: a click on the armed button itself must not disarm it.
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) disarm();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick, true);
    timer.current = window.setTimeout(disarm, ARM_MS);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick, true);
      window.clearTimeout(timer.current);
    };
  }, [armed]);

  return (
    <button
      ref={ref}
      type="button"
      className={`${className}${armed ? " armed" : ""}`}
      title={title ?? (armed ? "Click again to confirm" : label)}
      disabled={disabled}
      aria-label={armed ? confirmLabel ?? `Confirm ${label.toLowerCase()}` : label}
      onClick={() => {
        if (armed) {
          disarm();
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? (confirmLabel ?? `Confirm ${label.toLowerCase()}?`) : label}
    </button>
  );
}
