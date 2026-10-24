// src/components/SearchInput.test.ts — the client-side table filter.

import { describe, expect, it } from "vitest";
import { matches } from "./SearchInput";

describe("matches", () => {
  it("an empty needle matches everything", () => {
    expect(matches("anything", "")).toBe(true);
    expect(matches("anything", "   ")).toBe(true);
  });

  it("is a case-insensitive substring test", () => {
    expect(matches("in-socks 127.0.0.1:18080", "SOCKS")).toBe(true);
    expect(matches("pool-relay", "relay")).toBe(true);
    expect(matches("pool-relay", "direct")).toBe(false);
  });
});
