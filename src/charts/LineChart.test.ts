// src/charts/LineChart.test.ts — x-label thinning: labels stay evenly spaced
// and both ends always survive, at any width-driven max.

import { describe, expect, it } from "vitest";
import { labelIndices } from "./LineChart";

describe("labelIndices", () => {
  it("is empty without points", () => {
    expect(labelIndices(0, 6)).toEqual([]);
  });

  it("keeps the single point", () => {
    expect(labelIndices(1, 6)).toEqual([0]);
  });

  it("keeps every index when max allows", () => {
    expect(labelIndices(3, 6)).toEqual([0, 1, 2]);
  });

  it("spaces evenly and keeps both ends", () => {
    expect(labelIndices(16, 6)).toEqual([0, 3, 6, 9, 12, 15]);
    expect(labelIndices(10, 4)).toEqual([0, 3, 6, 9]);
  });

  it("never repeats or reverses an index", () => {
    for (let n = 1; n <= 40; n++) {
      for (let max = 2; max <= 8; max++) {
        const idx = labelIndices(n, max);
        expect(idx[0]).toBe(0);
        expect(idx[idx.length - 1]).toBe(n - 1);
        for (let i = 1; i < idx.length; i++) {
          expect(idx[i]! > idx[i - 1]!).toBe(true);
        }
      }
    }
  });
});
