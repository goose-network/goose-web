// src/components/StringList.tsx — editor for string arrays (pool outbounds,
// chain layers, check sites…).
//
// Order is meaningful for several of these (a chain traverses its layers in
// order), so the editor offers move up/down alongside add/remove instead of
// making the reader delete-and-retype to reorder.

export interface StringListProps {
  id: string;
  label: string;
  values: string[];
  placeholder?: string | undefined;
  onChange: (values: string[]) => void;
  /** show move up/down controls */
  ordered?: boolean | undefined;
  mono?: boolean | undefined;
  /** one line of help under the editor */
  hint?: string | undefined;
  /** label for the append button ("Add user", "Add layer", …) */
  addLabel?: string | undefined;
}

export function StringList({
  id,
  label,
  values,
  placeholder,
  onChange,
  ordered = false,
  mono = false,
  hint,
  addLabel = "Add",
}: StringListProps) {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= values.length) return;
    const next = [...values];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="field">
      <label htmlFor={id} id={`${id}-label`}>
        {label}
      </label>
      <div
        className="arr-editor"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
      >
        {values.map((v, i) => (
          <div className="item-row" key={i}>
            {ordered && <span className="row-index">{i + 1}</span>}
            <input
              id={i === 0 ? id : undefined}
              type="text"
              className={mono ? "mono" : undefined}
              value={v}
              placeholder={placeholder}
              aria-label={`${label}, entry ${i + 1}`}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            {ordered && (
              <>
                <button
                  type="button"
                  className="ghost icon"
                  disabled={i === 0}
                  aria-label={`Move ${label} entry ${i + 1} up`}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ghost icon"
                  disabled={i === values.length - 1}
                  aria-label={`Move ${label} entry ${i + 1} down`}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </>
            )}
            <button
              type="button"
              className="ghost icon"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              aria-label={`Remove ${label} entry ${i + 1}`}
            >
              ×
            </button>
          </div>
        ))}
        {values.length === 0 && (
          <div className="arr-empty">None yet.</div>
        )}
        <button type="button" onClick={() => onChange([...values, ""])}>
          {addLabel}
        </button>
      </div>
      {hint !== undefined && (
        <div className="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </div>
  );
}
