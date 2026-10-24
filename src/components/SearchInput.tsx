// src/components/SearchInput.tsx — client-side filter box for long tables.

export interface SearchInputProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  label?: string | undefined;
}

export function SearchInput({
  id,
  value,
  onChange,
  placeholder = "Filter…",
  label = "Filter",
}: SearchInputProps) {
  return (
    <div className="search-wrap">
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Case-insensitive substring match across a row's searchable text. */
export function matches(haystack: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return n === "" || haystack.toLowerCase().includes(n);
}
