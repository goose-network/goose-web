// src/components/fields.tsx — labelled form controls.
//
// Every control in the app goes through these so labels, hints, validation
// messages and the aria wiring (describedby / invalid) stay consistent, and
// so pages stop hand-rolling <label>+<input> pairs.

import type { ReactNode } from "react";

interface BaseProps {
  id: string;
  label: string;
  /** one line of help under the control */
  hint?: string | undefined;
  /** validation message; also sets aria-invalid */
  error?: string | null | undefined;
  className?: string | undefined;
}

function describedBy(id: string, hint?: string, error?: string | null) {
  const ids = [
    error !== null && error !== undefined ? `${id}-error` : "",
    hint !== undefined ? `${id}-hint` : "",
  ].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function Tail({
  id,
  hint,
  error,
}: {
  id: string;
  hint?: string | undefined;
  error?: string | null | undefined;
}) {
  return (
    <>
      {error !== null && error !== undefined && (
        <div className="field-error" id={`${id}-error`}>
          {error}
        </div>
      )}
      {hint !== undefined && (
        <div className="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </>
  );
}

export interface TextFieldProps extends BaseProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  type?: "text" | "password" | "url" | undefined;
  mono?: boolean | undefined;
  autoComplete?: string | undefined;
  disabled?: boolean | undefined;
  /** focus this field when the form mounts */
  autoFocus?: boolean | undefined;
}

export function TextField({
  id,
  label,
  hint,
  error,
  className,
  value,
  onChange,
  placeholder,
  type = "text",
  mono = false,
  autoComplete,
  disabled = false,
  autoFocus = false,
}: TextFieldProps) {
  return (
    <div className={`field${className !== undefined ? ` ${className}` : ""}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        className={mono ? "mono" : undefined}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => onChange(e.target.value)}
      />
      <Tail id={id} hint={hint} error={error} />
    </div>
  );
}

export interface SelectFieldProps extends BaseProps {
  value: string;
  onChange: (v: string) => void;
  /** plain strings, or {value,label} pairs */
  options: ReadonlyArray<string | { value: string; label: string }>;
  /** leading option with an empty value, e.g. "(default)" */
  emptyOption?: string | undefined;
  disabled?: boolean | undefined;
}

export function SelectField({
  id,
  label,
  hint,
  error,
  className,
  value,
  onChange,
  options,
  emptyOption,
  disabled = false,
}: SelectFieldProps) {
  return (
    <div className={`field${className !== undefined ? ` ${className}` : ""}`}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => onChange(e.target.value)}
      >
        {emptyOption !== undefined && <option value="">{emptyOption}</option>}
        {options.map((o) => {
          const opt = typeof o === "string" ? { value: o, label: o } : o;
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          );
        })}
      </select>
      <Tail id={id} hint={hint} error={error} />
    </div>
  );
}

export interface NumberFieldProps extends BaseProps {
  value: number;
  onChange: (v: number) => void;
  min?: number | undefined;
  max?: number | undefined;
  /** shown when the value is empty; the raw number stays 0-free */
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}

export function NumberField({
  id,
  label,
  hint,
  error,
  className,
  value,
  onChange,
  min,
  max,
  placeholder,
  disabled = false,
}: NumberFieldProps) {
  return (
    <div className={`field${className !== undefined ? ` ${className}` : ""}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        value={value === 0 && placeholder !== undefined ? "" : value}
        placeholder={placeholder}
        min={min}
        max={max}
        disabled={disabled}
        aria-invalid={error !== null && error !== undefined ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) =>
          onChange(e.target.value === "" ? 0 : Number(e.target.value))
        }
      />
      <Tail id={id} hint={hint} error={error} />
    </div>
  );
}

export function CheckField({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="field">
      <div className="field-check">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label htmlFor={id}>{label}</label>
      </div>
      {hint !== undefined && (
        <div className="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** A labelled block that isn't a single control (editors, lists). */
export function FieldGroup({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>
        {label}
      </span>
      <div role="group" aria-labelledby={`${id}-label`}>
        {children}
      </div>
      {hint !== undefined && <div className="field-hint">{hint}</div>}
    </div>
  );
}
