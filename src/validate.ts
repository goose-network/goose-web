// src/validate.ts — client-side field checks.
//
// The admin API rejects bad configs with a 400 after a round trip; catching
// the obvious mistakes in the form means the reader learns about them at the
// field, immediately, instead of in an error banner later.

/** Non-empty after trimming. */
export function required(value: string | undefined, message: string): string | null {
  return value === undefined || value.trim() === "" ? message : null;
}

const HOST_PORT = /^[^\s:]+(\.[^\s:]+)*:(\d+)$|^\[[0-9a-fA-F:]+]:(\d+)$/;

/** `host:port` or `[v6]:port` with a plausible port number. */
export function hostPort(value: string | undefined, message: string): string | null {
  if (value === undefined || value.trim() === "") return message;
  const v = value.trim();
  if (!HOST_PORT.test(v)) return message;
  const port = Number(v.split(":").pop());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return message;
  return null;
}

/** Absolute http(s) URL. */
export function httpUrl(value: string | undefined, message: string): string | null {
  if (value === undefined || value.trim() === "") return message;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? null : message;
  } catch {
    return message;
  }
}

/**
 * upstream_proxy route on a provider spec: empty (fetch direct, the default),
 * "direct", "access", "outbound:<id>", "pool:<id>", or a bare pool/outbound
 * id. Whitespace anywhere, or a prefix with no id after it, are the typos
 * worth catching in the form; the engine resolves the rest.
 */
export function upstreamRoute(
  value: string | undefined,
  message: string,
): string | null {
  if (value === undefined || value.trim() === "") return null;
  const v = value.trim();
  if (/\s/.test(v)) return message;
  for (const prefix of ["outbound:", "pool:"]) {
    if (v.startsWith(prefix) && v.length === prefix.length) return message;
  }
  return null;
}

/** Merge field errors, dropping nulls; empty object means "valid". */
export function collect(
  entries: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v !== null) out[k] = v;
  }
  return out;
}
