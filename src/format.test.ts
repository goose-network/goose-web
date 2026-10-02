// src/format.test.ts — display helpers (formatDuration / compact / formatTime).

import { describe, expect, it } from "vitest";
import { compact, formatDuration, formatTime } from "./format";

describe("formatDuration (Go time.Duration nanoseconds)", () => {
  it("renders sub-microsecond values in ns", () => {
    expect(formatDuration(1)).toBe("1ns");
    expect(formatDuration(999)).toBe("999ns");
  });

  it("renders microseconds and milliseconds with one decimal", () => {
    expect(formatDuration(1_500)).toBe("1.5µs");
    expect(formatDuration(2_500_000)).toBe("2.5ms");
  });

  it("rounds large magnitudes to whole units", () => {
    expect(formatDuration(2_400_000_000)).toBe("2.4s");
    expect(formatDuration(12_600_000_000)).toBe("13s"); // 12.6 >= 10 -> whole
    expect(formatDuration(240_000_000_000)).toBe("4m0.0s");
    expect(formatDuration(372_500_000_000)).toBe("6m13s"); // 12.5 rounds up
  });

  it("returns an em dash for missing/NaN input", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("compact", () => {
  it("leaves sub-1000 counts untouched", () => {
    expect(compact(0)).toBe("0");
    expect(compact(8)).toBe("8");
    expect(compact(999)).toBe("999");
  });

  it("folds thousands and millions with a suffix", () => {
    expect(compact(1_284)).toBe("1.3K");
    expect(compact(12_900)).toBe("12.9K");
    expect(compact(128_000)).toBe("128K");
    expect(compact(4_200_000)).toBe("4.2M");
  });
});

describe("formatTime", () => {
  it("returns an em dash for missing values", () => {
    expect(formatTime(undefined)).toBe("—");
    expect(formatTime("")).toBe("—");
  });

  it("passes through unparseable strings", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });

  it("formats a parseable timestamp as HH:MM:SS-ish local time", () => {
    const iso = "2026-10-02T09:15:30Z";
    const out = formatTime(iso);
    // Only assert shape: the exact string is locale/timezone dependent.
    expect(out).toMatch(/^\d{1,2}:\d{2}:\d{2}([^\d].*)?$/);
    expect(out).not.toBe(iso);
  });
});
