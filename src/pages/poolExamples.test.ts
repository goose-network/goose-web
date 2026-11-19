// src/pages/poolExamples.test.ts — the Selector params / filter Params
// example catalog must cover every type the pool form offers and stick to the
// keys the engine parses.

import { describe, expect, it } from "vitest";
import {
  FILTERS,
  filterExample,
  SELECTORS,
  selectorExample,
} from "./poolExamples";

describe("selectorExample", () => {
  it("has an example for every selector the form offers", () => {
    for (const type of SELECTORS) {
      expect(selectorExample(type), `no example for ${type}`).toBeDefined();
    }
  });

  it("returns undefined for an unknown type", () => {
    expect(selectorExample("nope")).toBeUndefined();
  });

  it("treats the engine's \"\" selector alias as random", () => {
    // A stock engine's provider-managed "default" pool serializes type "".
    expect(selectorExample("")).toEqual(selectorExample("random"));
  });

  it("takes no params for random and roundrobin", () => {
    expect(selectorExample("random")?.config).toEqual({});
    expect(selectorExample("roundrobin")?.config).toEqual({});
  });

  it("only uses keys the engine's selector parses", () => {
    // internal/selector: sticky reads "key"/"ttl", leastlatency reads
    // "tolerance"/"tolerance_ms". An example key outside that set would be
    // silently ignored — a lie dressed as guidance.
    const allowed: Record<string, string[]> = {
      random: [],
      roundrobin: [],
      sticky: ["key", "ttl"],
      leastlatency: ["tolerance", "tolerance_ms"],
    };
    for (const type of SELECTORS) {
      const config = selectorExample(type)?.config ?? {};
      for (const key of Object.keys(config)) {
        expect(allowed[type], `${type} example uses unknown key ${key}`).toContain(key);
      }
    }
  });
});

describe("filterExample", () => {
  it("has an example for every filter the form offers", () => {
    for (const type of FILTERS) {
      expect(filterExample(type), `no example for ${type}`).toBeDefined();
    }
  });

  it("returns undefined for an unknown type", () => {
    expect(filterExample("nope")).toBeUndefined();
  });

  it("only uses keys the engine's filters parse", () => {
    // internal/filter: location reads "countries"/"provinces"/"exclude",
    // latency "max_ms"/"max"/"min_success", protocol "allow"/"deny".
    const allowed: Record<string, string[]> = {
      location: ["countries", "provinces", "exclude"],
      latency: ["max_ms", "max", "min_success"],
      protocol: ["allow", "deny"],
    };
    for (const type of FILTERS) {
      const config = filterExample(type)?.config ?? {};
      for (const key of Object.keys(config)) {
        expect(allowed[type], `${type} example uses unknown key ${key}`).toContain(key);
      }
    }
  });

  it("keeps list values lowercase, matching the form the engine normalizes to", () => {
    // The engine lowercases BOTH sides — set() on the config values and
    // Allow() on the looked-up location — so case never changes what matches.
    // Lowercase examples simply mirror the canonical form the engine stores.
    const config = filterExample("location")?.config ?? {};
    for (const key of ["countries", "provinces", "exclude"] as const) {
      for (const v of (config[key] as string[] | undefined) ?? []) {
        expect(v, `${key} value`).toBe(v.toLowerCase());
      }
    }
    const protocol = filterExample("protocol")?.config ?? {};
    for (const key of ["allow", "deny"] as const) {
      for (const v of (protocol[key] as string[] | undefined) ?? []) {
        expect(v, `${key} value`).toBe(v.toLowerCase());
      }
    }
  });
});
