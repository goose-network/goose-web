// src/pages/ProvidersPage.test.ts — the edit form's plugin-help lookup must
// never crash on an unknown plugin. The engine is plugin-agnostic and surfaces
// auto-seeded zero-config providers (geph/tor/openrung) and external plugins
// that the form's tailored EXAMPLES map does not enumerate; indexing it
// directly used to throw ("can't access property urlPlaceholder … undefined")
// and white-screen the page when editing such a provider.

import { describe, expect, it } from "vitest";
import { pluginHelp, upstreamOptions, withPrefix } from "./ProvidersPage";

describe("pluginHelp", () => {
  it("returns tailored guidance for every built-in zero-config network", () => {
    for (const name of ["psiphon", "geph", "tor", "openrung"]) {
      const info = pluginHelp(name);
      expect(info).toBeDefined();
      expect(info.title).toContain(name);
      expect(typeof info.urlPlaceholder).toBe("string");
      expect(info.paragraphs.length).toBeGreaterThan(0);
      expect(info.example).toBeDefined();
    }
  });

  it("returns tailored guidance for the subscription plugins", () => {
    for (const name of ["subscription", "mihomo", "singbox"]) {
      expect(pluginHelp(name).title).toContain(name);
    }
  });

  it("falls back instead of crashing on an unknown plugin", () => {
    const info = pluginHelp("some-external-plugin");
    expect(info).toBeDefined();
    expect(typeof info.urlPlaceholder).toBe("string");
    expect(info.paragraphs.length).toBeGreaterThan(0);
    expect(info.example).toBeDefined();
  });

  it("falls back on undefined/empty plugin names", () => {
    expect(pluginHelp(undefined)).toBeDefined();
    expect(pluginHelp("")).toBeDefined();
    expect(typeof pluginHelp(undefined).urlPlaceholder).toBe("string");
  });

  it("falls back on Object.prototype-colliding names, not inherited members", () => {
    // A plain object literal inherits Object.prototype, so a bare ?? fallback
    // would return truthy prototype members for these names and crash the
    // render. Each must yield the generic help, never a function.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const info = pluginHelp(name);
      expect(info).toBeDefined();
      expect(Array.isArray(info.paragraphs)).toBe(true);
      expect(info.paragraphs.length).toBeGreaterThan(0);
      expect(typeof info.urlPlaceholder).toBe("string");
    }
  });
});

describe("withPrefix", () => {
  it("sets the prefix without touching other keys", () => {
    expect(withPrefix({ username: "u", password: "p" }, "geph")).toEqual({
      username: "u",
      password: "p",
      prefix: "geph",
    });
  });

  it("clearing the prefix removes only that key, keeping the rest", () => {
    // The regression: clearing prefix used to replace the whole config with
    // {url}, silently dropping credentials / limit / broker_url on save.
    expect(withPrefix({ username: "u", password: "p", prefix: "geph" }, "")).toEqual({
      username: "u",
      password: "p",
    });
    expect(withPrefix({ limit: 20, broker_url: "https://b", prefix: "openrung" }, "")).toEqual({
      limit: 20,
      broker_url: "https://b",
    });
  });

  it("clearing an absent prefix leaves an empty config empty", () => {
    expect(withPrefix({}, "")).toEqual({});
  });

  it("does not mutate the input config", () => {
    const cfg = { username: "u", prefix: "old" };
    withPrefix(cfg, "");
    expect(cfg).toEqual({ username: "u", prefix: "old" });
  });
});

describe("upstreamOptions", () => {
  const values = (groups: ReturnType<typeof upstreamOptions>) =>
    groups.flatMap((g) => g.options.map((o) => o.value));

  it("offers exactly one special route: direct", () => {
    const groups = upstreamOptions([], [], "");
    expect(groups.find((g) => g.label === "Special")?.options).toEqual([
      { value: "direct", label: "direct — the engine host's network" },
    ]);
  });

  it("lists pools and outbounds as explicit prefixed refs, sorted", () => {
    const groups = upstreamOptions(["zeta", "alpha"], ["relay-b", "relay-a"], "");
    expect(groups.find((g) => g.label === "Pools")?.options.map((o) => o.value)).toEqual([
      "pool:alpha",
      "pool:zeta",
    ]);
    expect(groups.find((g) => g.label === "Outbounds")?.options.map((o) => o.value)).toEqual([
      "outbound:relay-a",
      "outbound:relay-b",
    ]);
  });

  it("does not shadow an outbound whose id is also a pool (prefixes disambiguate)", () => {
    // Unlike a bare chain layer, "pool:shared" and "outbound:shared" are distinct
    // upstream routes, so both stay offerable.
    const v = values(upstreamOptions(["shared"], ["shared"], ""));
    expect(v).toContain("pool:shared");
    expect(v).toContain("outbound:shared");
  });

  it("keeps a stored value the engine no longer knows selectable", () => {
    const groups = upstreamOptions(["fast"], ["relay-a"], "gone-9");
    expect(groups.find((g) => g.label === "Current")?.options).toEqual([
      { value: "gone-9", label: "gone-9" },
    ]);
  });

  it("does not re-list a stored value already among the choices", () => {
    for (const current of ["direct", "pool:fast", "outbound:relay-a", ""]) {
      const groups = upstreamOptions(["fast"], ["relay-a"], current);
      expect(groups.some((g) => g.label === "Current")).toBe(false);
    }
  });

  it("ignores missing and empty ids", () => {
    const groups = upstreamOptions([undefined, ""], [undefined, ""], "");
    expect(groups.some((g) => g.label === "Pools")).toBe(false);
    expect(groups.some((g) => g.label === "Outbounds")).toBe(false);
  });
});