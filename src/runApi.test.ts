// src/runApi.test.ts — which answers from POST /api/exit-checks/run mean "the
// round is still going". Getting this wrong either polls a finished round
// forever or tells the reader a failed one is still running.

import { describe, expect, it } from "vitest";
import { GooseApiError } from "@goose-network/goose-sdk";
import type { Goose } from "@goose-network/goose-sdk";
import { runProbes, stillProbing, stillRunning } from "./runApi";

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

describe("stillProbing", () => {
  it("is false for the finished records, which arrive as an array", () => {
    expect(stillProbing([])).toBe(false);
    expect(stillProbing([{ id: "p1", route: "direct", success: true }])).toBe(false);
  });

  it("is false for a null body — a complete empty round, not one in flight", () => {
    expect(stillProbing(null)).toBe(false);
  });

  it("is true for the engine's 202 accepted object", () => {
    expect(
      stillProbing({
        status: "accepted",
        message: "probe round still running; results appear in GET /api/probes/results",
      }),
    ).toBe(true);
  });

  it("is true for any object body, including an older engine's shape", () => {
    expect(stillProbing({})).toBe(true);
  });
});

describe("runProbes", () => {
  // Only goose.client.send is exercised; the rest of the SDK is irrelevant here.
  const fakeGoose = (send: () => Promise<unknown>): Goose =>
    ({ client: { send } }) as unknown as Goose;
  const req = { targets: ["https://example.com"] };

  it("returns the records of a fast round unchanged", async () => {
    const rows = [{ id: "p1", route: "direct", target: "https://example.com", success: true }];
    const res = await runProbes(fakeGoose(async () => rows), req);
    expect(res).toEqual(rows);
    expect(stillProbing(res)).toBe(false);
  });

  it("returns the accepted object of a 202 round", async () => {
    const accepted = { status: "accepted", message: "probe round still running" };
    const res = await runProbes(fakeGoose(async () => accepted), req);
    expect(stillProbing(res)).toBe(true);
  });

  it("converts a front proxy's 504 into accepted, so the round is polled", async () => {
    const goose = fakeGoose(async () => {
      throw new GooseApiError(
        504,
        "<html>504 Gateway Time-out</html>",
        "goose API: 504 Gateway Time-out",
      );
    });
    const res = await runProbes(goose, req);
    expect(res).toEqual({ status: "accepted" });
    expect(stillProbing(res)).toBe(true);
  });

  it("does NOT mask a 502 — a dead engine is a failure, not a round in flight", async () => {
    const goose = fakeGoose(async () => {
      throw new GooseApiError(502, "<html>502 Bad Gateway</html>", "goose API: 502 Bad Gateway");
    });
    await expect(runProbes(goose, req)).rejects.toThrow("502");
  });

  it("surfaces a 400 as the caller's mistake", async () => {
    const goose = fakeGoose(async () => {
      throw new GooseApiError(
        400,
        { error: "probes: targets is required" },
        "probes: targets is required",
      );
    });
    await expect(runProbes(goose, req)).rejects.toThrow("targets is required");
  });
});
