// src/pages/poolExamples.ts — the per-selector and per-filter examples the
// pool form shows under its Params (JSON) editors, and the option lists the
// selects offer. Same idea as the outbound form's protocol examples: what the
// engine actually parses, at the moment of configuration.
//
// The keys and defaults here are the engine's own (internal/selector,
// internal/filter); every param is optional and the engine defaults the
// rest — the examples show a representative shape, not a required one.

import type { JsonExample } from "../components/KvEditor";

export const SELECTORS = ["random", "roundrobin", "sticky", "leastlatency"] as const;
export const FILTERS = ["location", "latency", "protocol"] as const;

export type Selector = (typeof SELECTORS)[number];
export type FilterType = (typeof FILTERS)[number];

// ---------------------------------------------------------------------------
// Selector params
// ---------------------------------------------------------------------------

const SELECTOR_EXAMPLES: Record<Selector, JsonExample> = {
  random: {
    note: "Picks a member at random each time. Takes no params.",
    config: {},
  },
  roundrobin: {
    note: "Cycles through the members in order. Takes no params.",
    config: {},
  },
  sticky: {
    note: "Keeps the same member for a key until it expires, so a session stays put. “key” is “domain” (default) or “src+domain”; “ttl” is a Go duration string (default “10m”).",
    config: { key: "src+domain", ttl: "30m" },
  },
  leastlatency: {
    note: "Picks the member with the lowest recent latency, only switching when another is faster by more than a tolerance (default “50ms”). Give it as “tolerance_ms” (a number) or “tolerance” (a duration string).",
    config: { tolerance_ms: 100 },
  },
};

/** The example for one selector type, or undefined for an unknown one. */
export function selectorExample(type: string): JsonExample | undefined {
  return (SELECTOR_EXAMPLES as Record<string, JsonExample | undefined>)[type];
}

// ---------------------------------------------------------------------------
// Filter params
// ---------------------------------------------------------------------------

const FILTER_EXAMPLES: Record<FilterType, JsonExample> = {
  location: {
    note: "Admits members by where their server resolves to. “countries” and “provinces” are allowlists, “exclude” a denylist; all case-insensitive ISO-style codes. A member with no known location passes only when no allowlist is set.",
    config: { countries: ["us", "jp"], exclude: ["cn"] },
  },
  latency: {
    note: "Admits members by measured health. “max_ms” caps recent latency in milliseconds (or “max” as a duration string like “250ms”); “min_success” floors the success ratio (0–1). Unmeasured members pass, so a fresh pool is not locked out.",
    config: { max_ms: 300, min_success: 0.9 },
  },
  protocol: {
    note: "Admits members by protocol. “allow” is an allowlist, “deny” a denylist, of protocol names (e.g. “psiphon”, “mihomo-vmess”, “direct”); both case-insensitive.",
    config: { allow: ["psiphon", "mihomo-vmess"] },
  },
};

/** The example for one filter type, or undefined for an unknown one. */
export function filterExample(type: string): JsonExample | undefined {
  return (FILTER_EXAMPLES as Record<string, JsonExample | undefined>)[type];
}
