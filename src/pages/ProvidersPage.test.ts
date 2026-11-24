// src/pages/ProvidersPage.test.ts — the edit form's plugin-help lookup must
// never crash on an unknown plugin. The engine is plugin-agnostic and surfaces
// auto-seeded zero-config providers (geph/tor/openrung) and external plugins
// that the form's tailored EXAMPLES map does not enumerate; indexing it
// directly used to throw ("can't access property urlPlaceholder … undefined")
// and white-screen the page when editing such a provider.

import { describe, expect, it } from "vitest";
import { pluginHelp, withPrefix } from "./ProvidersPage";

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