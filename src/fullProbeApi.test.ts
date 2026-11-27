// src/fullProbeApi.test.ts — the item routes' 404 means "the job is gone",
// not "this engine has no such endpoint": a pruned or restart-lost job must
// read as a missing job (and stay classifiable by status), while the
// collection routes keep the older-engine wording.

import { describe, expect, it } from "vitest";
import { GooseApiError } from "@goose-network/goose-sdk";
import type { Goose } from "@goose-network/goose-sdk";
import {
  applyFullProbe,
  cancelFullProbe,
  fullProbeJobGone,
  getFullProbe,
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
