// src/components/KvEditor.tsx — free-form JSON params editor for filter /
// selector / outbound config maps (schema: {[key: string]: unknown}).

import { useEffect, useState } from "react";

/** A worked example for whatever shape the editor currently wants — the
 *  selected protocol's config, the selected selector's params. Rendered under
 *  the editor, and insertable while the editor is empty: an example you can
 *  put in the field beats one you have to copy by hand. */
export interface JsonExample {
  /** One or two sentences on what the config takes and what is optional. */
  note: string;
  /** The example object itself, as it would be committed. */
  config: Record<string, unknown>;
}

export interface KvEditorProps {
  id: string;
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (value: Record<string, unknown>) => void;
  example?: JsonExample | undefined;
}

/** Whether the editor should offer to insert its example. Inserting
 *  overwrites the text, so the offer is only honest while the editor is empty
 *  — and only when the example has something to insert. An empty-config
 *  example ("this protocol needs no config") still earns its place as the note
 *  under the field; it is just not an insertion. */
export function exampleInsertable(
  example: JsonExample | undefined,
  text: string,
): boolean {
  return (
    example !== undefined &&
    text.trim() === "" &&
    Object.keys(example.config).length > 0
  );
}

export function KvEditor({ id, label, value, onChange, example }: KvEditorProps) {
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

  // Inserting overwrites the text, so the button is offered only while the
  // editor is empty — and only when the example has something to insert.
  const insertable = exampleInsertable(example, text);

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
      {example !== undefined && (
        <div
          className="field-hint"
          style={{ display: "block", whiteSpace: "normal" }}
        >
          <span>
            {example.note}{" "}
            {insertable && (
              <button
                type="button"
                className="ghost"
                onClick={() => update(JSON.stringify(example.config, null, 2))}
              >
                Insert example
              </button>
            )}
          </span>
          <pre
            className="mono json-sample"
            style={{
              margin: "4px 0 0 0",
              padding: "8px 10px",
              borderRadius: 6,
              overflowX: "auto",
              fontSize: "0.85em",
            }}
          >
            {JSON.stringify(example.config, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function pretty(v: Record<string, unknown> | undefined): string {
  const obj = v ?? {};
  return Object.keys(obj).length === 0 ? "" : JSON.stringify(obj, null, 2);
}
