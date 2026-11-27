// src/fullProbeApi.test.ts — the item routes' 404 means "the job is gone",
// not "this engine has no such endpoint": a pruned or restart-lost job must
// read as a missing job (and stay classifiable by status), while the
// collection routes keep the older-engine wording.

import { describe, expect, it } from "vitest";
import { GooseApiError } from "@goose-network/goose-sdk";
import type { Goose } from "@goose-network/goose-sdk";
import {
  applyFullProbe,
  buildResultsQuery,
  cancelFullProbe,
  classifyFullProbeResults404,
  fullProbeGoneMessage,
  fullProbeJobGone,
  fullProbeResultsMissing,
  getFullProbe,
  listFullProbeResults,
  listFullProbes,
  startFullProbe,
} from "./fullProbeApi";

// Only the exercised client method is faked; the rest of the SDK is
// irrelevant here (same arrangement as runApi.test.ts).
const fakeGoose = (client: Record<string, unknown>): Goose =>
  ({ client }) as unknown as Goose;

const rejecting = (err: unknown) => () => Promise.reject(err);

describe("fullProbeJobGone", () => {
  it("is true only for a GooseApiError with status 404", () => {
    expect(fullProbeJobGone(new GooseApiError(404, {}, "not found"))).toBe(true);
    expect(fullProbeJobGone(new GooseApiError(409, {}, "job is not running"))).toBe(false);
    expect(fullProbeJobGone(new GooseApiError(503, {}, "full probing not wired"))).toBe(false);
    expect(fullProbeJobGone(new Error("not found"))).toBe(false);
    expect(fullProbeJobGone(undefined)).toBe(false);
  });
});

describe("getFullProbe", () => {
  it("words a 404 as a missing job and keeps the status classifiable", async () => {
    const goose = fakeGoose({ get: rejecting(new GooseApiError(404, { error: "not found" }, "not found")) });
    const err = await getFullProbe(goose, "fp-gone").catch((e: unknown) => e);
    expect(fullProbeJobGone(err)).toBe(true);
    expect((err as Error).message).toContain("fp-gone");
    expect((err as Error).message).not.toContain("newer engine");
  });

  it("keeps apiMessage's wording for non-404 failures", async () => {
    const goose = fakeGoose({ get: rejecting(new GooseApiError(503, {}, "full probing not wired")) });
    const err = await getFullProbe(goose, "fp-x").catch((e: unknown) => e);
    expect(fullProbeJobGone(err)).toBe(false);
    expect((err as Error).message).toContain("not wired a runner");
  });

  it("passes a successful snapshot through", async () => {
    const goose = fakeGoose({ get: () => Promise.resolve({ id: "fp-1", state: "done" }) });
    await expect(getFullProbe(goose, "fp-1")).resolves.toEqual({ id: "fp-1", state: "done" });
  });
});

describe("applyFullProbe", () => {
  it("words a 404 as a missing job, not a missing endpoint", async () => {
    const goose = fakeGoose({ send: rejecting(new GooseApiError(404, {}, "not found")) });
    const err = await applyFullProbe(goose, "fp-gone").catch((e: unknown) => e);
    expect(fullProbeJobGone(err)).toBe(true);
    expect((err as Error).message).toContain("fp-gone");
  });
});

describe("collection routes keep the older-engine wording", () => {
  it("startFullProbe: a 404 means the endpoint itself is absent", async () => {
    const goose = fakeGoose({ send: rejecting(new GooseApiError(404, {}, "not found")) });
    const err = await startFullProbe(goose, { target: "https://example.com" }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("newer engine");
    expect(fullProbeJobGone(err)).toBe(false);
  });

  it("listFullProbes: a 404 means the endpoint itself is absent", async () => {
    const goose = fakeGoose({ get: rejecting(new GooseApiError(404, {}, "not found")) });
    const err = await listFullProbes(goose).catch((e: unknown) => e);
    expect((err as Error).message).toContain("newer engine");
  });
});

describe("cancelFullProbe", () => {
  it("resolves false when the transport reports the job gone (404)", async () => {
    const goose = fakeGoose({ delete: () => Promise.resolve(false) });
    await expect(cancelFullProbe(goose, "fp-gone")).resolves.toBe(false);
  });

  it("resolves true on a real cancel (204)", async () => {
    const goose = fakeGoose({ delete: () => Promise.resolve(true) });
    await expect(cancelFullProbe(goose, "fp-1")).resolves.toBe(true);
  });

  it("surfaces a 409 (already finished) as a readable refusal", async () => {
    const goose = fakeGoose({ delete: rejecting(new GooseApiError(409, { error: "job is not running" }, "job is not running")) });
    await expect(cancelFullProbe(goose, "fp-1")).rejects.toThrow("job is not running");
  });
});

describe("listFullProbeResults", () => {
  it("hits the results route with the built query, encoding the job id", async () => {
    const seen: string[] = [];
    const goose = fakeGoose({
      get: (url: string) => {
        seen.push(url);
        return Promise.resolve([{ id: "r1" }]);
      },
    });
    const rows = await listFullProbeResults(goose, "fp/1", { n: 500, outcome: "failed", before: "r9" });
    expect(rows).toEqual([{ id: "r1" }]);
    expect(seen).toEqual(["/api/probes/full/fp%2F1/results?n=500&before=r9&outcome=failed"]);
  });

  it("a bare call keeps the engine's own defaults — no query at all", async () => {
    const seen: string[] = [];
    const goose = fakeGoose({
      get: (url: string) => {
        seen.push(url);
        return Promise.resolve([]);
      },
    });
    await listFullProbeResults(goose, "fp-1");
    expect(seen).toEqual(["/api/probes/full/fp-1/results"]);
  });

  it("a null body (200, no rows) reads as an empty page, not a failure", async () => {
    const goose = fakeGoose({ get: () => Promise.resolve(null) });
    await expect(listFullProbeResults(goose, "fp-1")).resolves.toEqual([]);
  });

  it("a 404 keeps its status classifiable AND the newer-engine wording", async () => {
    // The page distinguishes gone-job from old-engine by whether the job
    // snapshot loads — this call must not collapse the two into one message
    // that loses the status the capability gate reads.
    const goose = fakeGoose({ get: rejecting(new GooseApiError(404, {}, "not found")) });
    const err = await listFullProbeResults(goose, "fp-1").catch((e: unknown) => e);
    expect(fullProbeResultsMissing(err)).toBe(true);
    expect((err as Error).message).toContain("newer engine");
  });

  it("non-404 failures keep apiMessage's readable wording", async () => {
    const goose = fakeGoose({ get: rejecting(new GooseApiError(503, {}, "no runner")) });
    const err = await listFullProbeResults(goose, "fp-1").catch((e: unknown) => e);
    expect(fullProbeResultsMissing(err)).toBe(false);
    expect((err as Error).message).toContain("not wired a runner");
  });
});

describe("buildResultsQuery", () => {
  it("empty options mean the bare URL", () => {
    expect(buildResultsQuery({})).toBe("");
    expect(buildResultsQuery({ n: 0, depth: 0, outcome: "" })).toBe("");
  });
  it("carries the set fields, and only those", () => {
    expect(buildResultsQuery({ n: 100, depth: 3, last_hop: "x" })).toBe("?n=100&depth=3&last_hop=x");
  });
});

describe("fullProbeResultsMissing", () => {
  it("is true only for a GooseApiError with status 404", () => {
    expect(fullProbeResultsMissing(new GooseApiError(404, {}, "not found"))).toBe(true);
    expect(fullProbeResultsMissing(new GooseApiError(400, {}, "bad request"))).toBe(false);
    expect(fullProbeResultsMissing(new Error("not found"))).toBe(false);
  });
});

describe("classifyFullProbeResults404", () => {
  // The results-404 latch regression: on a CAPABLE engine a terminal job can
  // be evicted from the 64-job history (the parent poll stopped when it
  // finished). Refresh then 404s on /results, and reading that as "old engine"
  // permanently disabled pool-mode apply. The snapshot disambiguates FIRST.
  it("results 404 + snapshot 404 → gone: no capability latch", async () => {
    const seen: string[] = [];
    const goose = fakeGoose({
      get: (url: string) => {
        seen.push(url);
        return Promise.reject(new GooseApiError(404, {}, "not found"));
      },
    });
    await expect(classifyFullProbeResults404(goose, "fp/evicted")).resolves.toBe("gone");
    // It consults the SAME snapshot route the parent poll uses, id encoded.
    expect(seen).toEqual(["/api/probes/full/fp%2Fevicted"]);
  });

  it("results 404 + snapshot 200 → unsupported: the endpoint truly is missing", async () => {
    // Old engines serve the job snapshot but not /results.
    const goose = fakeGoose({
      get: () => Promise.resolve({ id: "fp-1", state: "done" }),
    });
    await expect(classifyFullProbeResults404(goose, "fp-1")).resolves.toBe("unsupported");
  });

  it("an unreadable snapshot is transient — neither verdict may latch", async () => {
    // A network blip or 5xx proves nothing about the engine build; the card
    // surfaces a retryable error instead of guessing gone or old.
    const goose = fakeGoose({
      get: rejecting(new GooseApiError(503, {}, "no runner")),
    });
    await expect(classifyFullProbeResults404(goose, "fp-1")).resolves.toBe("transient");
    const netDown = fakeGoose({ get: rejecting(new Error("network down")) });
    await expect(classifyFullProbeResults404(netDown, "fp-1")).resolves.toBe("transient");
  });

  it("the gone notice reuses the parent's missing-job wording verbatim", () => {
    // One string for both notices (friendlyJob's 404 rewrap and the card),
    // so they can never drift apart.
    expect(fullProbeGoneMessage("fp-9")).toBe(
      'No full-probe job "fp-9" on this engine — it was pruned from history or lost in a restart.',
    );
  });
});

describe("applyFullProbe pool mode against an older engine", () => {
  it("rewords the decoder's unknown-field 400 as the upgrade it is", async () => {
    const goose = fakeGoose({
      send: rejecting(new GooseApiError(400, {}, 'json: unknown field "mode"')),
    });
    const err = await applyFullProbe(goose, "fp-1", { mode: "pool", selector: { type: "roundrobin" } }).catch(
      (e: unknown) => e,
    );
    expect((err as GooseApiError).status).toBe(400);
    expect((err as Error).message).toContain("newer engine");
    expect((err as Error).message).toContain("Inbound per path");
  });

  it("a default-mode 400 stays the engine's own refusal — nothing to upgrade", async () => {
    const goose = fakeGoose({
      send: rejecting(new GooseApiError(400, {}, 'json: unknown field "x"')),
    });
    const err = await applyFullProbe(goose, "fp-1", {}).catch((e: unknown) => e);
    expect((err as Error).message).toBe('json: unknown field "x"');
  });

  it("a pool-mode 400 that is NOT the unknown-field rejection stays verbatim", async () => {
    const goose = fakeGoose({
      send: rejecting(new GooseApiError(400, {}, "pool id already exists")),
    });
    const err = await applyFullProbe(goose, "fp-1", { mode: "pool" }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("pool id already exists");
  });

  it("passes the pool-mode response through with its additive fields", async () => {
    const res = {
      job_id: "fp-1",
      pool_id: "fp-1-pool",
      inbound_id: "fp-1-in",
      listen: "127.0.0.1:1080",
      protocol: "socks5",
      selector: { type: "roundrobin" },
      results: [{ chain_id: "fp-1-c1" }],
    };
    const goose = fakeGoose({ send: () => Promise.resolve(res) });
    await expect(applyFullProbe(goose, "fp-1", { mode: "pool" })).resolves.toEqual(res);
  });
});
