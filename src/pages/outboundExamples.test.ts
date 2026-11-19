// src/pages/outboundExamples.test.ts — the Config (JSON) example catalog must
// cover every protocol the form offers and stay faithful to what each plugin
// parses.

import { describe, expect, it } from "vitest";
import { outboundExample, PROTOCOLS } from "./outboundExamples";

describe("outboundExample", () => {
  it("has an example for every protocol the form offers", () => {
    for (const protocol of PROTOCOLS) {
      expect(outboundExample(protocol), `no example for ${protocol}`).toBeDefined();
    }
  });

  it("returns undefined for a protocol outside the catalog", () => {
    // An engine that registers more protocols (tor, geph) must not get a
    // wrong example — absence is the honest answer.
    expect(outboundExample("tor")).toBeUndefined();
    expect(outboundExample("")).toBeUndefined();
  });

  it("gives direct an empty config — nothing is required", () => {
    expect(outboundExample("direct")?.config).toEqual({});
  });

  it("gives http/socks5 an address", () => {
    for (const protocol of ["http", "socks5"] as const) {
      const config = outboundExample(protocol)?.config;
      expect(config, protocol).toBeDefined();
      expect(typeof config?.address, protocol).toBe("string");
      expect(config?.address, protocol).toMatch(/:\d+$/);
    }
  });

  it("gives psiphon a tunnel", () => {
    expect(outboundExample("psiphon")?.config).toEqual({ tunnel: "psiphon" });
  });

  it("keys every mihomo example's proxy mapping with the matching type", () => {
    // mihomo's ParseProxy dispatches on the mapping's own "type", so an
    // example whose type disagrees with the protocol would not build.
    for (const protocol of PROTOCOLS) {
      if (!protocol.startsWith("mihomo-")) continue;
      const proxy = outboundExample(protocol)?.config.proxy as Record<string, unknown>;
      expect(proxy?.type, `${protocol} mapping missing its type`).toBe(
        protocol.slice("mihomo-".length),
      );
      expect(proxy?.server, `${protocol} mapping missing server`).toBeTruthy();
      expect(typeof proxy?.port, `${protocol} mapping port`).toBe("number");
    }
  });

  it("gives every singbox example a proxy mapping with server and port", () => {
    for (const protocol of PROTOCOLS) {
      if (!protocol.startsWith("singbox-")) continue;
      const proxy = outboundExample(protocol)?.config.proxy as Record<string, unknown>;
      expect(proxy?.server, `${protocol} mapping missing server`).toBeTruthy();
      expect(typeof proxy?.port, `${protocol} mapping port`).toBe("number");
    }
  });

  it("carries each protocol's credential under the key its plugin reads", () => {
    // Spot-checks against the converters: singbox shadowsocks reads
    // "cipher", ssh reads "username", snell reads "psk".
    const ss = outboundExample("singbox-shadowsocks")?.config.proxy as Record<string, unknown>;
    expect(ss.cipher).toBeTruthy();
    expect(ss.password).toBeTruthy();
    const ssh = outboundExample("singbox-ssh")?.config.proxy as Record<string, unknown>;
    expect(ssh.username).toBeTruthy();
    const snell = outboundExample("singbox-snell")?.config.proxy as Record<string, unknown>;
    expect(snell.psk).toBeTruthy();
  });

  it("survives a JSON round-trip — every example is wire-safe", () => {
    for (const protocol of PROTOCOLS) {
      const example = outboundExample(protocol);
      expect(JSON.parse(JSON.stringify(example?.config)), protocol).toEqual(example?.config);
      expect((example?.note ?? "").length, `${protocol} note`).toBeGreaterThan(0);
    }
  });
});
