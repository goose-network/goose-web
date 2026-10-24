// src/components/Notice.tsx — inline banner + transient toast stack.
//
// Two channels, deliberately: errors that block the task at hand render
// inline where the task is (a form, a table), while confirmations of finished
// mutations are toasts that get out of the way on their own. Both are
// announced to assistive tech.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function Notice({
  kind = "error",
  onDismiss,
  children,
}: {
  kind?: "error" | "good" | "info" | undefined;
  onDismiss?: (() => void) | undefined;
  children: ReactNode;
}) {
  const cls =
    kind === "good" ? " good" : kind === "info" ? " info" : "";
  return (
    <div className={`notice${cls}`} role={kind === "info" ? "status" : "alert"}>
      <span className="notice-body">{children}</span>
      {onDismiss !== undefined && (
        <button
          type="button"
          className="dismiss"
          onClick={onDismiss}
          aria-label="Dismiss message"
        >
          ×
        </button>
      )}
    </div>
  );
}

interface Toast {
  id: number;
  text: string;
  kind: "good" | "bad";
}

interface ToastContextValue {
  toast: (text: string, kind?: "good" | "bad") => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (text: string, kind: "good" | "bad" = "good") => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { id, text, kind }]);
      window.setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast${t.kind === "bad" ? " bad" : ""}`} key={t.id}>
            <span>{t.text}</span>
            <button
              type="button"
              className="dismiss ghost"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const v = useContext(ToastContext);
  if (v === null) throw new Error("useToast must be used inside <ToastProvider>");
  return v;
}
