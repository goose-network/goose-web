// src/components/StringList.tsx — editor for string arrays (pool outbounds,
// chain layers, check sites…).
//
// Order is meaningful for several of these (a chain traverses its layers in
// order), so the editor offers move up/down alongside add/remove instead of
// making the reader delete-and-retype to reorder.
//
// Rows are free-text inputs by default. Passing `options` swaps each row's
// input for a <select> over those grouped choices, for lists whose values are
// ids of other configured things (chain layers pick from the engine's pools
// and outbounds) rather than text the reader invents.

import { FilterSelect, type RouteMetric } from "./FilterSelect";

/** One <optgroup>: a titled run of choices. */
export interface OptionGroup {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

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
  /** grouped choices; when given, each row renders a <select> instead of a
   *  text input. Every current value must be among them (or "") — a select
   *  whose value matches no option renders blank — so a caller with stored
   *  values the engine no longer knows must list them itself (see
   *  ChainsPage.layerOptions). In select mode `placeholder` labels the
   *  leading empty option that a freshly added row starts on. */
  options?: ReadonlyArray<OptionGroup> | undefined;
  /** render each row as a filterable picker (type to narrow, filter by probe
   *  result) instead of a plain <select>. Only meaningful with `options`; a
   *  long fleet of choices is what earns it. */
  filterable?: boolean | undefined;
  /** latest probe verdict per choice value, for the filterable rows' metric
   *  pills and filters. Absent leaves the picker a plain keyword filter. */
  metrics?: ReadonlyMap<string, RouteMetric> | undefined;
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
  options,
  filterable = false,
  metrics,
}: StringListProps) {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= values.length) return;
    const next = [...values];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  const edit = (i: number, value: string) => {
    const next = [...values];
    next[i] = value;
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
            {options === undefined ? (
              <input
                id={i === 0 ? id : undefined}
                type="text"
                className={mono ? "mono" : undefined}
                value={v}
                placeholder={placeholder}
                aria-label={`${label}, entry ${i + 1}`}
                onChange={(e) => edit(i, e.target.value)}
              />
            ) : filterable ? (
              <FilterSelect
                id={i === 0 ? id : `${id}-${i}`}
                value={v}
                onChange={(nv) => edit(i, nv)}
                groups={options}
                placeholder={placeholder ?? "(choose…)"}
                metrics={metrics}
                mono={mono}
                ariaLabel={`${label}, entry ${i + 1}`}
              />
            ) : (
              <select
                id={i === 0 ? id : undefined}
                className={mono ? "mono" : undefined}
                value={v}
                aria-label={`${label}, entry ${i + 1}`}
                onChange={(e) => edit(i, e.target.value)}
              >
                {/* "Add" pushes "", and a select whose value matches no option
                    renders blank — the placeholder names the unchosen state. */}
                <option value="">{placeholder}</option>
                {options.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
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
