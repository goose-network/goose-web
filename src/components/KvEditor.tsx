// src/components/KvEditor.tsx — free-form JSON params editor for filter /
// selector / outbound config maps (schema: {[key: string]: unknown}).

import { useEffect, useState } from "react";

export interface KvEditorProps {
  id: string;
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (value: Record<string, unknown>) => void;
}

export function KvEditor({ id, label, value, onChange }: KvEditorProps) {
  // Edit as pretty-printed JSON text; validate on change and commit only
  // when it parses. The full JSON shape stays reachable (nested arrays for
  // country lists, etc.) without building a per-plugin schema UI.
  const [text, setText] = useState(() => pretty(value));
  const [parseError, setParseError] = useState<string | null>(null);

  // Follow external resets (draft reloaded from server) when the incoming
  // value no longer matches what our text last produced.
  useEffect(() => {
    const current = text.trim() === "" ? "{}" : text;
    try {
      const parsed = JSON.parse(current) as Record<string, unknown>;
      if (JSON.stringify(parsed) !== JSON.stringify(value ?? {})) {
        setText(pretty(value));
        setParseError(null);
      }
    } catch {
      // mid-edit; leave the text alone
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (t: string) => {
    setText(t);
    if (t.trim() === "") {
      setParseError(null);
      onChange({});
      return;
    }
    try {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      setParseError(null);
      onChange(parsed);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="field kv-editor">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={3}
        className="mono"
        value={text}
        onChange={(e) => update(e.target.value)}
        spellCheck={false}
      />
      {parseError !== null && (
        <div role="alert" style={{ color: "var(--status-critical)" }}>
          {parseError}
        </div>
      )}
    </div>
  );
}

function pretty(v: Record<string, unknown> | undefined): string {
  const obj = v ?? {};
  return Object.keys(obj).length === 0 ? "" : JSON.stringify(obj, null, 2);
}
