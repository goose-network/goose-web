// src/components/StringList.tsx — editor for string arrays (pool outbounds,
// chain layers, users of an inbound…).

export interface StringListProps {
  id: string;
  label: string;
  values: string[];
  placeholder?: string;
  onChange: (values: string[]) => void;
}

export function StringList({
  id,
  label,
  values,
  placeholder,
  onChange,
}: StringListProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="arr-editor">
        {values.map((v, i) => (
          <div className="item-row" key={i}>
            <input
              id={i === 0 ? id : undefined}
              type="text"
              value={v}
              placeholder={placeholder}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              aria-label={`Remove ${label} entry ${i + 1}`}
            >
              −
            </button>
          </div>
        ))}
        <button type="button" onClick={() => onChange([...values, ""])}>
          Add
        </button>
      </div>
    </div>
  );
}
