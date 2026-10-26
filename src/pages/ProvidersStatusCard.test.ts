// src/pages/ProvidersStatusCard.test.ts — derivations behind the provider
// observability card: pill classes per state, and the plugin detail map's
// rendering into report fragments.

import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "@goose-network/goose-sdk";
import { pluginFacts, statePillClass } from "./ProvidersStatusCard";

describe("statePillClass", () => {
  it("maps the engine phases onto the shared pills", () => {
    expect(statePillClass("running")).toBe("pill ok");
    expect(statePillClass("error")).toBe("pill fail");
    expect(statePillClass("stopped")).toBe("pill");
    expect(statePillClass("starting")).toBe("pill warn");
    expect(statePillClass("establishing")).toBe("pill warn");
    expect(statePillClass(undefined)).toBe("pill warn");
  });
});

describe("pluginFacts", () => {
  const status = (details: Record<string, unknown>): ProviderStatus =>
    ({ plugin: { state: "running", details } }) as unknown as ProviderStatus;

  it("renders scalars as key: value", () => {
    expect(pluginFacts(status({ servers_in_list: 9, upstream_proxy: false }))).toEqual([
      "servers_in_list: 9",
      "upstream_proxy: false",
    ]);
  });

  it("renders arrays as their size and skips empty ones and nulls", () => {
    expect(
      pluginFacts(status({ pinned_tunnels: ["1.2.3.4", "5.6.7.8"], open_connections: 2, none: null, empty: [] })),
    ).toEqual(["pinned_tunnels: 2", "open_connections: 2"]);
  });

  it("yields nothing without a report", () => {
    expect(pluginFacts({} as ProviderStatus)).toEqual([]);
    expect(pluginFacts(status({}))).toEqual([]);
  });
});
