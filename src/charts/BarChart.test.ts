// src/charts/BarChart.test.ts — the "Other" fold and bar geometry helpers.

import { describe, expect, it } from "vitest";
import { barRows } from "./BarChart";

describe("barRows", () => {
  it("keeps a small list sorted by value, no fold", () => {
    const { rows, total } = barRows(
      [
        { label: "b", value: 2 },
        { label: "a", value: 9 },
        { label: "c", value: 5 },
      ],
      8,
    );
    expect(rows.map((r) => r.label)).toEqual(["a", "c", "b"]);
    expect(rows.every((r) => r.other !== true)).toBe(true);
    expect(total).toBe(16);
  });

  it("folds the tail into an 'Other' bar beyond maxBars", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => ({
      label: `bar-${v}`,
      value: v,
    }));
    const { rows, total } = barRows(data, 8);
    // 7 head bars + 1 "Other" = 8 rows total
    expect(rows).toHaveLength(8);
    expect(rows[rows.length - 1]?.label).toBe("Other");
    expect(rows[rows.length - 1]?.value).toBe(1 + 2 + 3); // the three smallest
    expect(total).toBe(55);
  });

  it("handles an empty dataset", () => {
    expect(barRows([], 8)).toEqual({ rows: [], total: 0 });
  });
});
