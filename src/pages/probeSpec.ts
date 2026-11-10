// src/pages/probeSpec.ts — the pure logic behind the reachability-probe page:
// parsing a pasted raw HTTP request into form fields, building the spec both
// probe endpoints take, and evaluating the response assertions the reader
// configured.
//
// All of it lives here (not in the component) because these are the parts
// worth testing directly: a pasted request from a browser or curl has to
// survive CRLF, header colons, absolute-form targets and a missing Host line,
// and a spec built from a half-filled form has to reach the engine with its
// defaults intact rather than zeros.

import type { ProbeRunRequest } from "../runApi";
import { cleanList } from "../validate";

/** Methods the form offers. Anything else the parser accepts verbatim. */
export const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** Methods that never carry a body, per RFC 9110. */
const BODYLESS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export function carriesBody(method: string): boolean {
  return !BODYLESS.has(method.toUpperCase());
}

/** One `Name: value` pair from a pasted request. */
export interface Header {
  name: string;
  value: string;
}

export interface ParsedRequest {
  method: string;
  /** Absolute URL when the request gave enough to build one. */
  target: string;
  headers: Header[];
  body: string;
  /** Non-fatal notes: things the reader should look at before running. */
  notes: string[];
}

export type ParseResult =
  | { ok: true; request: ParsedRequest }
  | { ok: false; error: string };

// Headers the transport derives from the URL or the body itself; pasting them
// back in would either be ignored or (Content-Length) fight the real body.
// Accept-Encoding joins them because a caller-set value switches off the
// transport's transparent decode: the probe would record compressed bytes and
// every body assertion would fail on mojibake. Letting the transport negotiate
// keeps the recorded body the text the target actually sent.
const DERIVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
]);

// A request line is "METHOD TARGET [HTTP/x.y]". The version is optional —
// pastes get trimmed — but see parseRawRequest for what that costs.
const REQUEST_LINE = /^([A-Za-z][A-Za-z0-9._-]*)\s+(\S+)(?:\s+(HTTP\/[0-9.]+))?\s*$/;

/**
 * parseRawRequest turns a pasted raw HTTP request into probe fields:
 *
 *     GET /ip HTTP/1.1
 *     Host: ifconfig.me
 *     User-Agent: curl/8.0
 *
 * The request line gives the method and target, headers run to the first
 * blank line, and everything after it is the body (kept byte-for-byte —
 * a JSON body's trailing newline is the reader's, not ours to trim).
 * Absolute-form targets (`GET https://x/y`) are used as-is; otherwise the
 * Host header supplies the authority and the scheme is inferred (see
 * schemeFor), with a note saying so — a request line in origin-form carries no
 * scheme, so any answer there is a guess the reader should see.
 */
export function parseRawRequest(raw: string): ParseResult {
  const text = raw.replace(/\r\n?/g, "\n");

  // Skip leading blank lines and `#`/`//` comments — people paste a header
  // line of context along with the request.
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === "" || isComment(lines[i]!))) i++;
  if (i >= lines.length) return { ok: false, error: "Nothing to parse — paste a request." };

  const head = lines[i]!.trim();
  const m = REQUEST_LINE.exec(head);
  // Without a version token the method must at least look like one — HTTP
  // methods are case-sensitive and every client writes them uppercase. That
  // is what tells a trimmed request line ("GET /ip") from a pasted shell
  // command ("curl https://x/ip"), which would otherwise probe with method
  // CURL and fail at the target with no hint why.
  const looksLikeMethod = m !== null && (m[3] !== undefined || m[1] === m[1]!.toUpperCase());
  if (m === null || !looksLikeMethod) {
    return {
      ok: false,
      error: `First line is not a request line: “${truncate(head)}”. Expected e.g. “GET /ip HTTP/1.1” — a pasted “curl …” command is not one.`,
    };
  }
  i++;

  const method = m[1]!.toUpperCase();
  const rawTarget = m[2]!;

  const headers: Header[] = [];
  const notes: string[] = [];
  let bodyStart = -1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      bodyStart = i + 1;
      break;
    }
    // An indented continuation of the previous header (obsolete folding).
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      // No blank line before the body: treat this as the body's first line.
      bodyStart = i;
      break;
    }
    headers.push({
      name: line.slice(0, colon).trim(),
      value: line.slice(colon + 1).trim(),
    });
  }

  const body = bodyStart < 0 ? "" : lines.slice(bodyStart).join("\n");

  const host = headers.find((h) => h.name.toLowerCase() === "host")?.value ?? "";
  let target = rawTarget;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget)) {
    // origin-form: "/path?query" — needs an authority from somewhere.
    const path = rawTarget.startsWith("/") ? rawTarget : `/${rawTarget}`;
    if (host === "") {
      notes.push(
        "No absolute URL and no Host header — set the target above before running.",
      );
      target = "";
    } else {
      target = `${schemeFor(host, headers)}${host}${path}`;
      // The scheme is a guess either way, and a wrong one fails as a TLS or
      // connection error a long way from its cause.
      notes.push(`Guessed the scheme from the Host header — check ${target}.`);
    }
  }

  const kept = headers.filter(
    (h) => !DERIVED_HEADERS.has(h.name.toLowerCase()) && h.name !== "",
  );
  const dropped = headers.length - kept.length;
  if (dropped > 0) {
    notes.push(
      `Dropped ${dropped} header${dropped === 1 ? "" : "s"} the transport sets itself (Host, Content-Length, Connection, Accept-Encoding).`,
    );
  }
  if (body !== "" && !carriesBody(method)) {
    notes.push(`${method} requests do not send a body — it will be ignored.`);
  }

  return { ok: true, request: { method, target, headers: kept, body, notes } };
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("#") || t.startsWith("//");
}

/**
 * The scheme an origin-form request implies. The request line carries none, so
 * the Host header's port is the only evidence: 443 means TLS, and any other
 * explicit port is far more often a plain-HTTP listener (a dev server, a
 * proxy's own admin port) than an alternative TLS port. A Host with no port is
 * a public name, which is https by default. X-Forwarded-Proto outranks both —
 * it is what the origin itself saw.
 */
function schemeFor(host: string, headers: Header[]): string {
  const proto = headers
    .find((h) => h.name.toLowerCase() === "x-forwarded-proto")
    ?.value.trim()
    .toLowerCase();
  if (proto === "http" || proto === "https") return `${proto}://`;
  // ":digits" at the end only — a bare IPv6 literal ([::1]) has no port.
  const port = /:(\d+)$/.exec(host)?.[1] ?? "";
  if (port !== "" && port !== "443") return "http://";
  return "https://";
}

function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// The spec: one shape, two endpoints
// ---------------------------------------------------------------------------

/** Targets worth offering up front. `expect` is the status the target answers
 *  with, so adding one can prefill the assertion. The two connectivity-check
 *  URLs are the ones client stacks already probe: they answer 204 with an
 *  empty body, which says "this route reaches the internet" about as cheaply
 *  as anything can. */
export const PROBE_TARGET_PRESETS: Array<{ url: string; note: string; expect: string }> = [
  { url: "https://www.gstatic.com/generate_204", note: "empty 204", expect: "204" },
  { url: "http://connectivitycheck.gstatic.com/generate_204", note: "plain HTTP", expect: "204" },
  { url: "https://ifconfig.me/ip", note: "echoes the exit IP", expect: "200" },
  { url: "https://api.ipify.org?format=json", note: "JSON body", expect: "200" },
  { url: "https://httpbin.org/get", note: "echoes headers; rate-limited", expect: "200" },
  { url: "https://example.com", note: "static page", expect: "200" },
];

/** The fields the manual run and the schedule share. */
export interface ProbeSpecFields {
  targets: string[];
  method: string;
  headers: Header[];
  body: string;
  /** route references; empty means every built outbound */
  routes: string[];
  timeoutSec: number;
  maxBodyBytes: number;
}

/**
 * buildProbeSpec normalizes the form into the wire shape both probe endpoints
 * take, leaving out everything the reader did not touch: an omitted field
 * means "the engine's default", so a cleared timeout cannot arrive as 0 and a
 * bodyless method cannot carry a body. Targets are cleaned the way every list
 * field is — a repeated target would double the round for no extra answer.
 *
 * The result also satisfies `HTTPProbeConfig`, which is how one form drives
 * both `POST /api/probes/run` and the saved `engine.probes.http`.
 */
export function buildProbeSpec(f: ProbeSpecFields): ProbeRunRequest {
  const spec: ProbeRunRequest = { targets: cleanList(f.targets) };
  const method = f.method.trim().toUpperCase();
  if (method !== "") spec.method = method;
  const headers = headerMap(f.headers);
  if (Object.keys(headers).length > 0) spec.headers = headers;
  if (f.body !== "" && carriesBody(method)) spec.body = f.body;
  if (f.routes.length > 0) spec.routes = [...f.routes];
  if (f.timeoutSec > 0) spec.timeout_seconds = f.timeoutSec;
  if (f.maxBodyBytes > 0) spec.max_body_bytes = f.maxBodyBytes;
  return spec;
}

/** Headers as the wire wants them: one name -> value map. Names are matched
 *  case-insensitively and the last row wins, because the engine sets them on
 *  an `http.Header` — "Accept" and "accept" are one header there, so sending
 *  both would leave which value arrives up to Go's map iteration order. The
 *  surviving row keeps the reader's own spelling. Rows the transport derives
 *  itself drop out here too: the paste box already refuses them, and a
 *  hand-typed Accept-Encoding would otherwise switch off transparent decode
 *  and record a compressed body as mojibake. */
export function headerMap(headers: Header[]): Record<string, string> {
  const byName = new Map<string, Header>();
  for (const h of headers) {
    const name = h.name.trim();
    if (name === "" || DERIVED_HEADERS.has(name.toLowerCase())) continue;
    byName.set(name.toLowerCase(), { name, value: h.value });
  }
  return Object.fromEntries([...byName.values()].map((h) => [h.name, h.value]));
}

/** The engine's defaults for the fields it stores as zeros:
 *  `HTTPProbeConfig.EffectiveTimeoutSec` (15, floor 1) and the body cap
 *  `RunHTTPProbes` applies (`MaxBodyBytes <= 0` -> 4096). */
export const ENGINE_PROBE_DEFAULTS = { timeoutSec: 15, maxBodyBytes: 4096 } as const;

/**
 * orDefault applies the engine's default to a stored number, and says whether
 * it did.
 *
 * `config.HTTPProbeConfig` has no `omitempty` on any field, so a schedule read
 * back from `/api/engine` carries explicit zeros for everything the reader
 * left alone — and a zero is not a value the engine will use. Printing it
 * would claim "0s per request" and a "0 bytes" body cap (i.e. nothing kept)
 * for a probe that really runs at 15s and keeps 4096 bytes.
 */
export function orDefault(
  stored: number | undefined,
  fallback: number,
): { value: number; defaulted: boolean } {
  return stored === undefined || stored < 1
    ? { value: fallback, defaulted: true }
    : { value: stored, defaulted: false };
}

const encoder = new TextEncoder();

/** UTF-8 byte length. The engine caps and truncates response bodies by
 *  *bytes*, so counting JS code units would report a body of multi-byte text
 *  as smaller than the cap that cut it. */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** What "reachable and correct" means for one probe, as the reader writes it. */
export interface Expectations {
  /** Accepted response statuses; empty accepts any response at all. */
  statuses: number[];
  /** Response header name -> pattern the value must match. */
  headers: Header[];
  /** Patterns the response body must each match. */
  body: string[];
}

export const EMPTY_EXPECT: Expectations = { statuses: [], headers: [], body: [] };

/** One assertion's verdict, for the results table. */
export interface Verdict {
  /** what was asserted, in reader-facing words */
  label: string;
  pass: boolean;
  /** the value actually seen (or the error that stopped the probe) */
  detail: string;
}

export interface ProbeResponse {
  /** 0 when the request never produced a response */
  status: number;
  headers: Record<string, string>;
  body: string;
  error?: string | undefined;
  /** the engine cut the body at its cap, so a pattern that is absent from
   *  what arrived may have been in the part that was dropped */
  truncated?: boolean | undefined;
  /** the leg a failure broke on, and its classified reason slug — the
   *  engine's own attribution (`core.HTTPProbe.Phase`/`Reason`), absent on
   *  older engines */
  phase?: string | undefined;
  reason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Failure labels: the engine classifies, the browser words it
// ---------------------------------------------------------------------------

/** Reader-facing words for each failure phase the engine reports
 *  (`core.HTTPProbe.Phase`). */
export const PHASE_LABELS: Record<string, string> = {
  request: "the request itself",
  dns: "DNS lookup",
  connect: "TCP connect",
  proxy: "proxy handshake",
  tls: "TLS handshake",
  headers: "response headers",
  body: "response body",
};

/** Reader-facing words for each reason slug the engine classifies
 *  (`core.HTTPProbe.Reason`). "unknown" is deliberately absent: it carries no
 *  information, so the phase speaks instead. */
export const REASON_LABELS: Record<string, string> = {
  dns_timeout: "DNS timed out",
  dns_nxdomain: "no such host",
  dns_failure: "DNS failed",
  connect_refused: "connection refused",
  connect_timeout: "connect timed out",
  connect_unreachable: "network unreachable",
  route_invalid: "route does not exist",
  route_unavailable: "no usable outbound",
  proxy_auth: "proxy auth failed",
  proxy_rejected: "proxy rejected the request",
  proxy_timeout: "proxy handshake timed out",
  tunnel_unavailable: "no live tunnel",
  tls_handshake: "TLS handshake failed",
  tls_cert: "bad TLS certificate",
  tls_timeout: "TLS timed out",
  header_timeout: "no response headers in time",
  body_timeout: "body read timed out",
  timeout: "timed out",
  reset_eof: "connection reset or closed",
  decode_error: "response decode failed",
  canceled: "canceled",
  round_budget: "round ended before it ran",
  bad_request: "request could not be built",
};

/**
 * failureLabel words a classified failure compactly, for a verdict pill: the
 * reason's phrase when the slug is known, a slug from a newer engine
 * humanized, else the phase, else the old bare "request failed". The raw
 * error string stays in the verdict's detail — the label says *what kind* of
 * failure, the error keeps the full diagnostic.
 */
export function failureLabel(phase?: string, reason?: string): string {
  if (reason !== undefined && reason !== "" && reason !== "unknown") {
    return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
  }
  if (phase !== undefined && phase !== "") {
    return `${PHASE_LABELS[phase] ?? phase} failed`;
  }
  return "request failed";
}

/**
 * phaseLeg translates a failure phase into the leg of the route it broke on —
 * the attribution the whole classification exists for. "dns" and "connect"
 * are the dial toward the first hop: the proxy server on a proxy route, the
 * target itself on a direct one. "tls", "headers" and "body" are beyond the
 * proxy, on its way to the target. Undefined for an empty or unknown phase.
 */
export function phaseLeg(
  phase: string | undefined,
  route: string | undefined,
): string | undefined {
  if (phase === undefined || phase === "") return undefined;
  const direct = route === undefined || route === "" || route === "direct";
  switch (phase) {
    case "request":
      return "before dialing";
    case "dns":
    case "connect":
      return direct ? "local → target" : "local → proxy";
    case "proxy":
      return "at the proxy";
    case "tls":
    case "headers":
    case "body":
      return direct ? "local → target" : "proxy → target";
    default:
      return undefined;
  }
}

/**
 * checkExpectations evaluates one response against the expectations.
 *
 * A transport error fails everything at once: there is no status, no header
 * and no body to assert against, and saying "0 of 3 assertions passed"
 * hides the actual reason. Bad regexes are reported as failures naming the
 * pattern rather than thrown — a typo in an assertion must not break the run.
 */
export function checkExpectations(
  expect: Expectations,
  res: ProbeResponse,
): Verdict[] {
  if (res.error !== undefined && res.error !== "") {
    return [
      {
        label: failureLabel(res.phase, res.reason),
        pass: false,
        detail: res.error,
      },
    ];
  }

  const out: Verdict[] = [];

  if (expect.statuses.length > 0) {
    const pass = expect.statuses.includes(res.status);
    // The verdict renders as a nowrap pill per result row, and a fully
    // expanded range is 400 codes: label the assertion in the range notation
    // the field accepts, falling back to a count past what a pill can hold.
    const written = formatStatuses(expect.statuses);
    out.push({
      label: `status ${written.length <= 32 ? written : `${expect.statuses.length} statuses`}`,
      pass,
      detail: String(res.status),
    });
  }

  for (const h of expect.headers) {
    if (h.name.trim() === "") continue;
    const actual = headerValue(res.headers, h.name);
    const re = compile(h.value);
    if (re instanceof Error) {
      out.push({ label: `header ${h.name}`, pass: false, detail: `bad regex: ${re.message}` });
      continue;
    }
    out.push({
      label: `header ${h.name}`,
      pass: actual !== undefined && re.test(actual),
      detail: actual ?? "(absent)",
    });
  }

  for (const pattern of expect.body) {
    if (pattern.trim() === "") continue;
    const re = compile(pattern);
    if (re instanceof Error) {
      out.push({ label: "body", pass: false, detail: `bad regex: ${re.message}` });
      continue;
    }
    const pass = re.test(res.body);
    out.push({
      label: "body",
      pass,
      detail: pass
        ? `matched ${pattern}`
        : // A cut body is the one failure whose cause is not the pattern: the
          // match may be sitting in the bytes the cap dropped.
          `no match for ${pattern}${
            res.truncated === true ? " — body truncated, so it may be past the cap" : ""
          }`,
    });
  }

  return out;
}

/** Response header lookup, case-insensitively. */
export function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const want = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/**
 * compile builds a matcher from a reader's pattern. A pattern with no regex
 * metacharacters matches as a plain substring — `"google"` should find
 * `google` in a body without the reader having to think about anchoring —
 * while anything that looks like a regex is treated as one.
 */
export function compile(pattern: string): RegExp | Error {
  const p = pattern.trim();
  if (p === "") return new Error("empty pattern");
  // A leading and trailing slash is an explicit "this is a regex" signal — but
  // only when the inside looks like one (metacharacters) or flags follow it.
  // `/api/v1/users` and `/dashboard/` are patterns containing slashes, not
  // delimited regexes: splitting those at the last slash would invent source
  // and flags the reader never wrote.
  const delim = /^\/(.*)\/([gimsuy]*)$/s.exec(p);
  const looksLikeRe =
    delim !== null &&
    (delim[2] !== "" || /[\\^$.*+?()[\]{}|]/.test(delim[1]!));
  const bare = looksLikeRe ? delim : null;
  const source = bare !== null ? bare[1]! : p;
  const flags = bare !== null && bare[2] !== "" ? bare[2]! : "i";
  try {
    const re = new RegExp(source, flags);
    if (bare !== null || /[\\^$.*+?()[\]{}|]/.test(source)) return re;
    // Plain word: substring semantics, still case-insensitive.
    return new RegExp(escapeRe(source), flags);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Status list from free text: "200", "200,301", "200-299". A range expands in
 *  full over the status space — a half-expanded range would assert something
 *  narrower than what the reader typed — and, like a lone number, codes outside
 *  100-599 are not statuses and drop out. */
export function parseStatuses(text: string): number[] {
  // A range typed with breathing room around the dash — "200 - 299", or an en
  // dash pasted out of prose — is still one token. Normalise the dash and pull
  // the spaces in before splitting, or the split cuts the range into two lone
  // codes and silently asserts only its endpoints.
  const joined = text
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*-\s*/g, "-");
  const out: number[] = [];
  for (const part of joined.split(/[,\s]+/)) {
    if (part === "") continue;
    const range = /^(\d{3})-(\d{3})$/.exec(part);
    if (range !== null) {
      const lo = Math.max(Number(range[1]), 100);
      const hi = Math.min(Number(range[2]), 599);
      for (let s = lo; s <= hi; s++) out.push(s);
      continue;
    }
    const n = Number(part);
    if (Number.isInteger(n) && n >= 100 && n <= 599) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Inverse of parseStatuses: consecutive codes collapse back into the range
 *  notation the field accepts, so re-saving a spec never spells a range out. */
export function formatStatuses(statuses: number[]): string {
  const runs: Array<[number, number]> = [];
  for (const s of [...new Set(statuses)].sort((a, b) => a - b)) {
    const run = runs[runs.length - 1];
    if (run !== undefined && s === run[1] + 1) run[1] = s;
    else runs.push([s, s]);
  }
  return runs
    .map(([lo, hi]) => (hi > lo + 1 ? `${lo}-${hi}` : `${lo}${hi === lo + 1 ? `, ${hi}` : ""}`))
    .join(", ");
}

/** The assertion fields as the form holds them (statuses still free text). */
export interface ExpectationFields {
  statuses: string;
  headers: Header[];
  body: string[];
}

/**
 * buildExpectations reads the assertion form. Rows that are not finished — a
 * header with no name, or one with no pattern — are dropped rather than kept
 * as failures: an empty pattern would compile to an error and report "bad
 * regex" for what is really an empty row. "Must be present, any value" is
 * `.*`.
 */
export function buildExpectations(f: ExpectationFields): Expectations {
  return {
    statuses: parseStatuses(f.statuses),
    headers: f.headers.filter((h) => h.name.trim() !== "" && h.value.trim() !== ""),
    body: cleanList(f.body),
  };
}

/** True when the reader asserted anything at all; false means "any response
 *  is a pass", which the results table says out loud instead of implying. */
export function hasExpectations(e: Expectations): boolean {
  return e.statuses.length > 0 || e.headers.length > 0 || e.body.length > 0;
}

/** Adapts a recorded probe to what the assertion evaluator takes: the engine's
 *  empty error string means "no error", and an omitted header map (Go's
 *  `omitempty`) means no headers were recorded. The failure classification
 *  rides along — `omitempty` on the engine side, so an older engine's rows
 *  arrive without it and the verdict falls back to the bare error. */
export function probeResponse(p: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  truncated?: boolean;
  phase?: string;
  reason?: string;
}): ProbeResponse {
  const error = p.error ?? "";
  return {
    status: p.status ?? 0,
    headers: p.headers ?? {},
    body: p.body ?? "",
    error: error === "" ? undefined : error,
    truncated: p.truncated === true ? true : undefined,
    phase: p.phase,
    reason: p.reason,
  };
}
