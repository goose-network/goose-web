// src/pages/outboundExamples.ts — the protocol catalog for the outbound form,
// and the per-protocol example its Config (JSON) field shows while that
// protocol is selected. Same idea as the provider form's PluginHelp: what the
// plugin parses, at the moment of configuration.
//
// The example shapes are the ones the engine's plugins actually read:
// goose's own http/socks5/direct plugins, the psiphon plugin's tunnel config,
// mihomo-plugin (cfg["proxy"] goes to mihomo's own ParseProxy, so it is a
// Clash-dialect mapping and MUST carry a matching "type"), and
// singbox-plugin (cfg["proxy"] is the same Clash/mihomo field dialect —
// server/port/cipher/… — which its converter maps onto sing-box options; the
// protocol already picks the type, so the mapping needs none).

import type { JsonExample } from "../components/KvEditor";

// Protocols registered by the engine's plugin set (include/register.go).
// mihomo-*/singbox-* outbounds are normally created by their provider
// plugins from a subscription, but manual creation stays possible.
export const PROTOCOLS = [
  "direct",
  "http",
  "socks5",
  "psiphon",
  "mihomo-ss",
  "mihomo-vmess",
  "mihomo-vless",
  "mihomo-trojan",
  "mihomo-socks5",
  "mihomo-http",
  "singbox-socks",
  "singbox-http",
  "singbox-shadowsocks",
  "singbox-vmess",
  "singbox-vless",
  "singbox-trojan",
  "singbox-snell",
  "singbox-ssh",
  "singbox-anytls",
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

/** One mihomo-* example: the config is a Clash proxy mapping under "proxy",
 *  and mihomo's parser dispatches on the mapping's own "type", so it must
 *  match the protocol's suffix. */
function mihomoExample(
  type: string,
  mapping: Record<string, unknown>,
): JsonExample {
  return {
    note: `Built by the embedded mihomo core from one Clash-dialect proxy mapping under “proxy”, whose “type” must be “${type}”. TLS types also take “tls”, “sni”/“servername” and “skip-cert-verify”; “network”: “ws” adds a “ws-opts” object. A mihomo provider normally creates these from a subscription.`,
    config: { proxy: { type, ...mapping } },
  };
}

/** One singbox-* example: the same Clash/mihomo field dialect under "proxy"
 *  (the converter reads server/port and the protocol's own credential keys);
 *  the sing-box type comes from the protocol, not the mapping. */
function singboxExample(
  mapping: Record<string, unknown>,
  extra = "",
): JsonExample {
  return {
    note: `Built by the embedded sing-box core. “proxy” carries a Clash/mihomo-style mapping — “server”, “port” and the keys shown; the protocol picks the sing-box type.${extra} A singbox provider normally creates these from a subscription.`,
    config: { proxy: mapping },
  };
}

const EXAMPLES: Record<Protocol, JsonExample> = {
  direct: {
    note: "No config — the engine dials targets itself, through its own network stack.",
    config: {},
  },
  http: {
    note: "An upstream HTTP(S) proxy. “address” (host:port) is required; “username” and “password” only for an authenticated proxy.",
    config: {
      address: "proxy.example.com:8080",
      username: "user",
      password: "sekret",
    },
  },
  socks5: {
    note: "An upstream SOCKS5 proxy. “address” (host:port) is required; “username” and “password” only for an authenticated proxy.",
    config: {
      address: "proxy.example.com:1080",
      username: "user",
      password: "sekret",
    },
  },
  psiphon: {
    note: "Rides a running psiphon provider's tunnel: “tunnel” is the provider's outbound ID (default “psiphon”). With no “server” the general tunnel picks any exit; “server” pins one IP from the provider's live list, “region” biases the exit country. The provider normally creates one outbound per server itself.",
    config: { tunnel: "psiphon" },
  },
  "mihomo-ss": mihomoExample("ss", {
    name: "ss-example",
    server: "ss.example.com",
    port: 8388,
    cipher: "aes-256-gcm",
    password: "sekret",
  }),
  "mihomo-vmess": mihomoExample("vmess", {
    name: "vmess-example",
    server: "vmess.example.com",
    port: 443,
    uuid: "2714c8b8-8d0a-4c0d-a8f2-4a09c1d6f5e4",
    alterId: 0,
    cipher: "auto",
    tls: true,
    servername: "vmess.example.com",
  }),
  "mihomo-vless": mihomoExample("vless", {
    name: "vless-example",
    server: "vless.example.com",
    port: 443,
    uuid: "2714c8b8-8d0a-4c0d-a8f2-4a09c1d6f5e4",
    tls: true,
    servername: "vless.example.com",
  }),
  "mihomo-trojan": mihomoExample("trojan", {
    name: "trojan-example",
    server: "trojan.example.com",
    port: 443,
    password: "sekret",
    sni: "trojan.example.com",
  }),
  "mihomo-socks5": mihomoExample("socks5", {
    name: "socks5-example",
    server: "proxy.example.com",
    port: 1080,
    username: "user",
    password: "sekret",
  }),
  "mihomo-http": mihomoExample("http", {
    name: "http-example",
    server: "proxy.example.com",
    port: 8080,
    username: "user",
    password: "sekret",
  }),
  "singbox-socks": singboxExample({
    server: "proxy.example.com",
    port: 1080,
    username: "user",
    password: "sekret",
  }),
  "singbox-http": singboxExample({
    server: "proxy.example.com",
    port: 8080,
    username: "user",
    password: "sekret",
  }),
  "singbox-shadowsocks": singboxExample(
    {
      server: "ss.example.com",
      port: 8388,
      cipher: "aes-256-gcm",
      password: "sekret",
    },
    " “cipher” becomes sing-box's “method”.",
  ),
  "singbox-vmess": singboxExample({
    server: "vmess.example.com",
    port: 443,
    uuid: "2714c8b8-8d0a-4c0d-a8f2-4a09c1d6f5e4",
    alterId: 0,
    tls: true,
    sni: "vmess.example.com",
  }),
  "singbox-vless": singboxExample({
    server: "vless.example.com",
    port: 443,
    uuid: "2714c8b8-8d0a-4c0d-a8f2-4a09c1d6f5e4",
    flow: "xtls-rprx-vision",
    tls: true,
    sni: "vless.example.com",
  }),
  "singbox-trojan": singboxExample({
    server: "trojan.example.com",
    port: 443,
    password: "sekret",
    sni: "trojan.example.com",
  }),
  "singbox-snell": singboxExample({
    server: "snell.example.com",
    port: 443,
    psk: "c2VrcmV0LXByZS1zaGFyZWQta2V5",
    version: 4,
  }),
  "singbox-ssh": singboxExample({
    server: "ssh.example.com",
    port: 22,
    username: "user",
    password: "sekret",
  }),
  "singbox-anytls": singboxExample({
    server: "anytls.example.com",
    port: 443,
    password: "sekret",
  }),
};

/** The example for one protocol, or undefined for a protocol this build's
 *  catalog does not cover (a spec loaded from an engine that registers more,
 *  e.g. tor or geph) — no example beats a wrong one. */
export function outboundExample(protocol: string): JsonExample | undefined {
  return (EXAMPLES as Record<string, JsonExample | undefined>)[protocol];
}
