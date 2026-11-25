// src/components/FilterSelect.test.ts — the pure logic behind the filterable
// picker: folding probe rows to a latest verdict per route, narrowing the
// choices by keyword and by that verdict, and flattening them for the open box.
// These are the parts a long fleet makes load-bearing — a wrong filter hides the
// route the reader came to pick, and a wrong sort promotes a broken route over a
// working one — so they are tested directly, the way ChipPicker's logic is.

import { describe, expect, it } from "vitest";
import {
  displayLabel,
  matchesMetric,
  metricLabel,
  metricTone,
  routeMetrics,
  visibleOptions,
  type RouteMetric,
} from "./FilterSelect";
import type { OptionGroup } from "./StringList";

const GROUPS: OptionGroup[] = [
  {
    label: "Pools",
    options: [
      { value: "fast", label: "fast" },
      { value: "slow", label: "slow" },
    ],
  },
  {
    label: "Outbounds",
    options: [
      { value: "relay-a", label: "relay-a" },
      { value: "relay-b", label: "relay-b" },
    ],
  },
];

describe("routeMetrics", () => {
  it("keeps the newest verdict per route (rows arrive newest-first)", () => {
    const m = routeMetrics([
      { route: "outbound:a", success: true, latency: 5_000_000 },
      { route: "outbound:a", success: false, reason: "proxy_timeout" },
      { route: "pool:p", success: false, reason: "connect_refused" },
    ]);
    expect(m.get("outbound:a")).toEqual({ ok: true, latencyNs: 5_000_000 });
    expect(m.get("pool:p")).toEqual({ ok: false, reason: "connect_refused" });
  });

  it("drops rows with no usable route ref", () => {
    const m = routeMetrics([{ success: true }, { route: "", success: true }]);
    expect(m.size).toBe(0);
  });

  it("a success without a timing is ok, not zero-latency", () => {
    expect(routeMetrics([{ route: "direct", success: true }]).get("direct")).toEqual({ ok: true });
  });

  it("a failure without a reason carries no reason key", () => {
    expect(routeMetrics([{ route: "outbound:x", success: false }]).get("outbound:x")).toEqual({ ok: false });
  });
});

describe("matchesMetric", () => {
  const ok: RouteMetric = { ok: true, latencyNs: 1 };
  const fail: RouteMetric = { ok: false, reason: "tls_cert" };
  it("all passes everything, including unprobed", () => {
    expect(matchesMetric(ok, "all")).toBe(true);
    expect(matchesMetric(fail, "all")).toBe(true);
    expect(matchesMetric(undefined, "all")).toBe(true);
  });
  it("ok passes only a successful verdict", () => {
    expect(matchesMetric(ok, "ok")).toBe(true);
    expect(matchesMetric(fail, "ok")).toBe(false);
    expect(matchesMetric(undefined, "ok")).toBe(false);
  });
  it("failed passes a probed failure, never an unprobed route", () => {
    expect(matchesMetric(fail, "failed")).toBe(true);
    expect(matchesMetric(ok, "failed")).toBe(false);
    // unprobed is not failed: the engine has not tried it
    expect(matchesMetric(undefined, "failed")).toBe(false);
  });
  it("unprobed passes only the absent verdict", () => {
    expect(matchesMetric(undefined, "unprobed")).toBe(true);
    expect(matchesMetric(ok, "unprobed")).toBe(false);
    expect(matchesMetric(fail, "unprobed")).toBe(false);
  });
});

describe("metricLabel / metricTone", () => {
  it("words a success as its latency, an untimed success as ok", () => {
    expect(metricLabel({ ok: true, latencyNs: 120_000_000 })).toBe("120ms");
    expect(metricLabel({ ok: true })).toBe("ok");
  });
  it("words a failure as its reason humanized, or bare failed", () => {
    expect(metricLabel({ ok: false, reason: "proxy_timeout" })).toBe("proxy timeout");
    expect(metricLabel({ ok: false })).toBe("failed");
  });
  it("words an unprobed route as unprobed", () => {
    expect(metricLabel(undefined)).toBe("unprobed");
  });
  it("tones ok / fail / warn(unprobed)", () => {
    expect(metricTone({ ok: true })).toBe("ok");
    expect(metricTone({ ok: false })).toBe("fail");
    expect(metricTone(undefined)).toBe("warn");
  });
});

describe("visibleOptions", () => {
  const metrics = new Map<string, RouteMetric>([
    ["fast", { ok: true, latencyNs: 10_000_000 }],
    ["slow", { ok: true, latencyNs: 900_000_000 }],
    ["relay-a", { ok: false, reason: "connect_refused" }],
    // relay-b deliberately unprobed
  ]);

  it("always offers the clear row first, regardless of filter", () => {
    const shown = visibleOptions(GROUPS, "", metrics, "ok", false, false, "(choose)");
    expect(shown[0]).toEqual({ value: "", label: "(choose)", group: "", kind: "empty" });
  });

  it("narrows by keyword across value, label and verdict words", () => {
    const byId = visibleOptions(GROUPS, "relay", undefined, "all", false, false, "(choose)");
    expect(byId.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual(["relay-a", "relay-b"]);
    // typing a verdict word finds the routes that carry it
    const byVerdict = visibleOptions(GROUPS, "unprobed", metrics, "all", false, false, "(choose)");
    expect(byVerdict.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual(["relay-b"]);
  });

  it("does not leak the phantom 'unprobed' keyword when metrics are absent", () => {
    // Degraded mode (failed/absent probe fetch): no pills or chips are shown,
    // so the verdict word must not sit in the keyword haystack. "probe" should
    // match only ids/labels containing it, not the whole fleet via
    // metricLabel(undefined) === "unprobed".
    const groups: OptionGroup[] = [
      {
        label: "Outbounds",
        options: [
          { value: "probe-relay", label: "probe-relay" },
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
      },
    ];
    const degraded = visibleOptions(groups, "probe", undefined, "all", false, false, "(choose)");
    expect(degraded.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual(["probe-relay"]);
    // With metrics present the verdict word is intended: "unprobed" finds the
    // routes that genuinely carry no verdict.
    const m = new Map<string, RouteMetric>([["probe-relay", { ok: true, latencyNs: 1 }]]);
    const withMetrics = visibleOptions(groups, "unprobed", m, "all", false, false, "(choose)");
    expect(withMetrics.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual(["alpha", "beta"]);
  });

  it("narrows by the metric filter", () => {
    const ok = visibleOptions(GROUPS, "", metrics, "ok", false, false, "(choose)");
    expect(ok.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual(["fast", "slow"]);
    const failed = visibleOptions(GROUPS, "", metrics, "failed", false, false, "(choose)");
    expect(failed.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual(["relay-a"]);
    const unprobed = visibleOptions(GROUPS, "", metrics, "unprobed", false, false, "(choose)");
    expect(unprobed.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual(["relay-b"]);
  });

  it("sorts reachable routes fastest first, sinking failed and unprobed", () => {
    const shown = visibleOptions(GROUPS, "", metrics, "all", true, false, "(choose)");
    const choices = shown.filter((o) => o.kind === "choice").map((o) => o.value);
    // Pools group stays together and ascends by latency; the broken/unprobed
    // outbounds follow, never promoted above a working route.
    expect(choices).toEqual(["fast", "slow", "relay-a", "relay-b"]);
  });

  it("reorders a mixed group fastest-first and sinks failed/unprobed (not group order)", () => {
    // One group, listed out of order with mixed verdicts, so the expected order
    // cannot be produced by group order alone: the ascending-latency sort AND
    // the Infinity sink for failed/unprobed are both load-bearing here. A
    // regression that drops the sort, or sinks broken routes to 0 instead of
    // Infinity (promoting them above working ones), must fail this.
    const mixed: OptionGroup[] = [
      {
        label: "Routes",
        options: [
          { value: "never", label: "never" },
          { value: "broken", label: "broken" },
          { value: "ok-slow", label: "ok-slow" },
          { value: "ok-fast", label: "ok-fast" },
        ],
      },
    ];
    const m = new Map<string, RouteMetric>([
      ["broken", { ok: false, reason: "connect_refused" }],
      ["ok-slow", { ok: true, latencyNs: 900_000_000 }],
      ["ok-fast", { ok: true, latencyNs: 10_000_000 }],
      // "never" deliberately unprobed
    ]);
    const shown = visibleOptions(mixed, "", m, "all", true, false, "(choose)");
    expect(shown.filter((o) => o.kind === "choice").map((o) => o.value)).toEqual([
      "ok-fast",
      "ok-slow",
      "never",
      "broken",
    ]);
  });

  it("keeps each value once even when two groups offer it", () => {
    const dup: OptionGroup[] = [
      { label: "A", options: [{ value: "x", label: "x" }] },
      { label: "B", options: [{ value: "x", label: "x again" }] },
    ];
    const shown = visibleOptions(dup, "", undefined, "all", false, false, "(choose)");
    expect(shown.filter((o) => o.value === "x")).toHaveLength(1);
  });

  it("offers a Use row for typed text that names no choice, only when allowed", () => {
    const allowed = visibleOptions(GROUPS, "access", undefined, "all", false, true, "(choose)");
    const custom = allowed.find((o) => o.kind === "custom");
    expect(custom).toEqual({ value: "access", label: "Use “access”", group: "", kind: "custom" });
    // not allowed → no custom row
    const denied = visibleOptions(GROUPS, "access", undefined, "all", false, false, "(choose)");
    expect(denied.some((o) => o.kind === "custom")).toBe(false);
  });

  it("does not offer a Use row when the typed text already names a choice", () => {
    const shown = visibleOptions(GROUPS, "fast", undefined, "all", false, true, "(choose)");
    expect(shown.some((o) => o.kind === "custom")).toBe(false);
    expect(shown.some((o) => o.kind === "choice" && o.value === "fast")).toBe(true);
  });

  it("still offers a Use row when the named choice is hidden by the metric filter", () => {
    // relay-a is probed-failed, so under "ok" it is filtered out of `seen`.
    // allowCustom must still let the reader commit it verbatim — suppression
    // keys off the FILTERED choices, not every value the groups offer. Without
    // this, typing a failed route under "Reachable" yields only the clear row
    // and Enter would wipe the upstream to "" (direct).
    const shown = visibleOptions(GROUPS, "relay-a", metrics, "ok", false, true, "(choose)");
    expect(shown.some((o) => o.kind === "choice" && o.value === "relay-a")).toBe(false);
    expect(shown.find((o) => o.kind === "custom")).toEqual({
      value: "relay-a",
      label: "Use “relay-a”",
      group: "",
      kind: "custom",
    });
  });

  it("shows just the clear row when nothing matches", () => {
    const shown = visibleOptions(GROUPS, "zzz-nothing", undefined, "all", false, false, "(choose)");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.kind).toBe("empty");
  });
});

describe("displayLabel", () => {
  it("shows the placeholder for the empty choice", () => {
    expect(displayLabel("", GROUPS, "(choose)")).toBe("(choose)");
  });
  it("shows a choice's label when offered", () => {
    expect(displayLabel("relay-a", GROUPS, "(choose)")).toBe("relay-a");
  });
  it("shows the raw value when nothing offers it (a ghost or custom route)", () => {
    expect(displayLabel("gone-9", GROUPS, "(choose)")).toBe("gone-9");
    expect(displayLabel("access", GROUPS, "(choose)")).toBe("access");
  });
});