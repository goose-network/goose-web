// src/runApi.test.ts — which answers from POST /api/exit-checks/run mean "the
// round is still going". Getting this wrong either polls a finished round
// forever or tells the reader a failed one is still running.

import { describe, expect, it } from "vitest";
import { stillRunning } from "./runApi";

describe("stillRunning", () => {
  it("is false for a completed round, which carries its checks", () => {
    expect(stillRunning({ status: "complete", checks: [] })).toBe(false);
  });

  it("is true for the new engine's 202: it waited 25s and stopped waiting", () => {
    expect(
      stillRunning({
        status: "accepted",
        message: "exit-IP check round still running; results appear in GET /api/exit-checks",
      }),
    ).toBe(true);
  });

  it("is true for an older engine's 202, which sends no status at all", () => {
    expect(stillRunning({ error: "exit-IP check round started" })).toBe(true);
  });

  it("is false for any other status, so a failure is not polled as a round in flight", () => {
    expect(stillRunning({ status: "error", message: "no outbounds to check" })).toBe(false);
  });
});
