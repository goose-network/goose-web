// src/pages/probeSpec.test.ts — the pasted-request parser and the assertion
// evaluator: the two pieces of probe logic that must be right before any
// request leaves the browser.

import { describe, expect, it } from "vitest";
import {
  buildExpectations,
  buildProbeSpec,
  byteLength,
  carriesBody,
  checkExpectations,
  compile,
  EMPTY_EXPECT,
  ENGINE_PROBE_DEFAULTS,
  hasExpectations,
  headerMap,
  headerValue,
  orDefault,
  parseRawRequest,
  parseStatuses,
  probeResponse,
  PROBE_TARGET_PRESETS,
  type ProbeSpecFields,
} from "./probeSpec";

/** Unwrap a parse result, failing the test with the parser's own message. */
function parsed(raw: string) {
  const r = parseRawRequest(raw);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.request;
}

describe("parseRawRequest", () => {
  it("splits method, target, headers and body", () => {
    const req = parsed(
      [
        "POST /api/login HTTP/1.1",
        "Host: example.com",
        "Content-Type: application/json",
        "User-Agent: curl/8.0",
        "",
        '{"user":"alice"}',
      ].join("\n"),
    );
    expect(req.method).toBe("POST");
    expect(req.target).toBe("https://example.com/api/login");
    expect(req.headers).toEqual([
      { name: "Content-Type", value: "application/json" },
      { name: "User-Agent", value: "curl/8.0" },
    ]);
    expect(req.body).toBe('{"user":"alice"}');
  });

  it("accepts CRLF line endings and a trailing body newline", () => {
    const req = parsed(
      "GET /ip HTTP/1.1\r\nHost: ifconfig.me\r\n\r\nline1\r\nline2\r\n",
    );
    expect(req.target).toBe("https://ifconfig.me/ip");
    expect(req.body).toBe("line1\nline2\n");
  });

  it("keeps an absolute-form target as written", () => {
    const req = parsed("GET http://127.0.0.1:18080/example.com/ HTTP/1.1\n\n");
    expect(req.target).toBe("http://127.0.0.1:18080/example.com/");
    expect(req.notes).toEqual([]);
  });

  it("splits header values on the first colon only", () => {
    const req = parsed(
      ["GET / HTTP/1.1", "Host: x.example", "Authorization: Bearer a:b:c", ""].join("\n"),
    );
    expect(headerValue(Object.fromEntries(req.headers.map((h) => [h.name, h.value])), "authorization")).toBe(
      "Bearer a:b:c",
    );
  });

  it("drops the headers the engine derives itself", () => {
    const req = parsed(
      [
        "POST /x HTTP/1.1",
        "Host: example.com",
        "Content-Length: 11",
        "Connection: keep-alive",
        "Accept: */*",
        "",
        "hello world",
      ].join("\n"),
    );
    expect(req.headers).toEqual([{ name: "Accept", value: "*/*" }]);
    expect(req.notes.join(" ")).toMatch(/Dropped 3 headers/);
  });

  it("skips leading blank lines and comments", () => {
    const req = parsed("\n# copied from devtools\n\nGET /ip HTTP/1.1\nHost: a.example\n");
    expect(req.method).toBe("GET");
    expect(req.target).toBe("https://a.example/ip");
  });

  it("notes a missing authority instead of guessing a target", () => {
    const req = parsed("GET /ip HTTP/1.1\nAccept: */*\n");
    expect(req.target).toBe("");
    expect(req.notes.join(" ")).toMatch(/No absolute URL and no Host header/);
  });

  it("uses http:// for a port-80 host", () => {
    expect(parsed("GET /ip HTTP/1.1\nHost: a.example:80\n").target).toBe(
      "http://a.example:80/ip",
    );
  });

  it("uses http:// for an explicit port that is not 443, and says it guessed", () => {
    // A pasted request from a dev server or a proxy's own admin port is plain
    // HTTP far more often than it is TLS on an unusual port.
    const req = parsed("POST /api/login HTTP/1.1\nHost: 127.0.0.1:18099\n");
    expect(req.target).toBe("http://127.0.0.1:18099/api/login");
    expect(req.notes.join(" ")).toMatch(/Guessed the scheme/);
  });

  it("keeps https for a bare host and for :443", () => {
    expect(parsed("GET /ip HTTP/1.1\nHost: ifconfig.me\n").target).toBe(
      "https://ifconfig.me/ip",
    );
    expect(parsed("GET /ip HTTP/1.1\nHost: a.example:443\n").target).toBe(
      "https://a.example:443/ip",
    );
  });

  it("lets X-Forwarded-Proto outrank the port", () => {
    expect(
      parsed("GET / HTTP/1.1\nHost: a.example:8443\nX-Forwarded-Proto: http\n").target,
    ).toBe("http://a.example:8443/");
  });

  it("does not read a port out of a bare IPv6 host", () => {
    expect(parsed("GET /ip HTTP/1.1\nHost: [::1]\n").target).toBe("https://[::1]/ip");
    expect(parsed("GET /ip HTTP/1.1\nHost: [::1]:8080\n").target).toBe(
      "http://[::1]:8080/ip",
    );
  });

  it("rejects a first line that is not a request line", () => {
    const r = parseRawRequest("curl https://example.com/ip");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a request line/);
  });

  it("accepts a request line whose version was trimmed", () => {
    const req = parsed("GET https://example.com/ip");
    expect(req.method).toBe("GET");
    expect(req.target).toBe("https://example.com/ip");
  });

  it("rejects empty input", () => {
    const r = parseRawRequest("   \n\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Nothing to parse/);
  });

  it("normalizes the method case and flags a body on GET", () => {
    const req = parsed("get /ip HTTP/1.1\nHost: a.example\n\nignored");
    expect(req.method).toBe("GET");
    expect(req.notes.join(" ")).toMatch(/GET requests do not send a body/);
  });

  it("treats a body with no separating blank line as the body", () => {
    const req = parsed("POST /x HTTP/1.1\nHost: a.example\nContent-Type: text/plain\nraw=1");
    expect(req.headers).toEqual([{ name: "Content-Type", value: "text/plain" }]);
    expect(req.body).toBe("raw=1");
  });

  it("unfolds an obsolete continuation line", () => {
    const req = parsed("GET / HTTP/1.1\nHost: a.example\nX-Long: a\n   b\n");
    expect(req.headers).toContainEqual({ name: "X-Long", value: "a b" });
  });
});

describe("carriesBody", () => {
  it("is false for the methods that never send one", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(carriesBody(m)).toBe(false);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(carriesBody(m)).toBe(true);
  });
});

describe("parseStatuses", () => {
  it("reads a list, a range and junk", () => {
    expect(parseStatuses("200, 301")).toEqual([200, 301]);
    expect(parseStatuses("200-203")).toEqual([200, 201, 202, 203]);
    expect(parseStatuses("200 200 abc 99 600")).toEqual([200]);
    expect(parseStatuses("")).toEqual([]);
  });
});

describe("compile", () => {
  /** compile, unwrapped — these patterns are meant to be valid. */
  const re = (pattern: string): RegExp => {
    const r = compile(pattern);
    if (r instanceof Error) throw new Error(`pattern ${pattern}: ${r.message}`);
    return r;
  };

  it("matches a plain word as a case-insensitive substring", () => {
    expect(re("google").test("Visit GOOGLE.com today")).toBe(true);
    expect(re("google").test("bing")).toBe(false);
  });

  it("honors regex metacharacters and /re/ form", () => {
    expect(re("^20\\d$").test("200")).toBe(true);
    expect(re("/^abc/").test("abcdef")).toBe(true);
    expect(re("/^abc/i").test("ABCDEF")).toBe(true);
  });

  it("returns the error instead of throwing on a bad pattern", () => {
    expect(compile("([unclosed")).toBeInstanceOf(Error);
  });
});

describe("checkExpectations", () => {
  const res = {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
    body: '{"ip":"203.0.113.7"}',
  };

  it("passes with no expectations configured", () => {
    expect(checkExpectations(EMPTY_EXPECT, res)).toEqual([]);
  });

  it("checks status, header and body together", () => {
    const v = checkExpectations(
      {
        statuses: [200, 204],
        headers: [{ name: "content-type", value: "json" }],
        body: ["203\\.0\\.113\\.\\d+"],
      },
      res,
    );
    expect(v.map((x) => x.pass)).toEqual([true, true, true]);
    expect(v[0]!.detail).toBe("200");
  });

  it("reports which status was seen when it does not match", () => {
    const v = checkExpectations({ ...EMPTY_EXPECT, statuses: [404] }, res);
    expect(v).toEqual([{ label: "status 404", pass: false, detail: "200" }]);
  });

  it("flags an absent header rather than matching the empty string", () => {
    const v = checkExpectations(
      { ...EMPTY_EXPECT, headers: [{ name: "X-Missing", value: ".*" }] },
      res,
    );
    expect(v[0]!.pass).toBe(false);
    expect(v[0]!.detail).toBe("(absent)");
  });

  it("fails everything at once on a transport error, naming the error", () => {
    const v = checkExpectations({ ...EMPTY_EXPECT, statuses: [200] }, {
      status: 0,
      headers: {},
      body: "",
      error: "dial tcp: i/o timeout",
    });
    expect(v).toEqual([{ label: "request", pass: false, detail: "dial tcp: i/o timeout" }]);
  });

  it("reports a bad assertion regex as a failure, not an exception", () => {
    const v = checkExpectations(
      { ...EMPTY_EXPECT, body: ["([unclosed"] },
      res,
    );
    expect(v[0]!.pass).toBe(false);
    expect(v[0]!.detail).toMatch(/bad regex/);
  });

  it("skips blank assertion rows", () => {
    const v = checkExpectations(
      { statuses: [], headers: [{ name: "", value: "x" }], body: ["  "] },
      res,
    );
    expect(v).toEqual([]);
  });

  it("blames a cut body, not the pattern, when the body was truncated", () => {
    // The cap dropped the bytes the pattern would have matched, so "no match"
    // alone sends the reader off to debug a pattern that was fine.
    const v = checkExpectations({ ...EMPTY_EXPECT, body: ["marker"] }, {
      status: 200,
      headers: {},
      body: '{"a":1}',
      truncated: true,
    });
    expect(v[0]!.pass).toBe(false);
    expect(v[0]!.detail).toMatch(/no match for marker — body truncated/);
  });

  it("says nothing about truncation when the body arrived whole", () => {
    const v = checkExpectations(
      { ...EMPTY_EXPECT, body: ["marker"] },
      probeResponse({ status: 200, body: '{"a":1}' }),
    );
    expect(v[0]!.detail).toBe("no match for marker");
  });
});

describe("headerValue", () => {
  it("is case-insensitive and reports absence as undefined", () => {
    expect(headerValue({ "Content-Type": "text/plain" }, "content-TYPE")).toBe("text/plain");
    expect(headerValue({}, "x")).toBeUndefined();
  });
});

describe("buildProbeSpec", () => {
  const empty: ProbeSpecFields = {
    targets: [],
    method: "GET",
    headers: [],
    body: "",
    routes: [],
    timeoutSec: 0,
    maxBodyBytes: 0,
  };

  it("leaves untouched fields out, so the engine's defaults apply", () => {
    // A cleared timeout must not travel as 0, and an empty route list means
    // "every outbound" — sending [] would say the same thing less clearly.
    expect(buildProbeSpec({ ...empty, targets: ["https://a/ip"] })).toEqual({
      targets: ["https://a/ip"],
      method: "GET",
    });
  });

  it("cleans targets and carries the rest", () => {
    expect(
      buildProbeSpec({
        ...empty,
        targets: [" https://a/ip ", "https://a/ip", "", "https://b/ip"],
        method: "post",
        headers: [{ name: "X-Token", value: "t" }],
        body: '{"a":1}',
        routes: ["pool:relays", "direct"],
        timeoutSec: 12,
        maxBodyBytes: 4096,
      }),
    ).toEqual({
      targets: ["https://a/ip", "https://b/ip"],
      method: "POST",
      headers: { "X-Token": "t" },
      body: '{"a":1}',
      routes: ["pool:relays", "direct"],
      timeout_seconds: 12,
      max_body_bytes: 4096,
    });
  });

  it("drops a body the method cannot carry", () => {
    const spec = buildProbeSpec({ ...empty, targets: ["https://a"], method: "GET", body: "x" });
    expect(spec.body).toBeUndefined();
    expect(buildProbeSpec({ ...empty, targets: ["https://a"], method: "PUT", body: "x" }).body).toBe(
      "x",
    );
  });
});

describe("headerMap", () => {
  it("drops nameless rows and collapses a name that differs only by case", () => {
    // The engine sets these on an http.Header, where "Accept" and "accept" are
    // one header: sending both would leave the winner to Go's map order.
    expect(
      headerMap([
        { name: "", value: "x" },
        { name: "Accept", value: "text/plain" },
        { name: "accept", value: "*/*" },
        { name: "X-Token", value: "t" },
      ]),
    ).toEqual({ accept: "*/*", "X-Token": "t" });
  });
});

describe("buildExpectations", () => {
  it("parses statuses and drops unfinished assertion rows", () => {
    const e = buildExpectations({
      statuses: "200, 204",
      headers: [
        { name: "", value: "x" },
        { name: "X-Cache", value: "" },
        { name: "content-type", value: "json" },
      ],
      body: ["ip", " ", "ip"],
    });
    expect(e.statuses).toEqual([200, 204]);
    expect(e.headers).toEqual([{ name: "content-type", value: "json" }]);
    expect(e.body).toEqual(["ip"]);
    expect(hasExpectations(e)).toBe(true);
  });

  it("reports an unasserted run as having no expectations", () => {
    expect(hasExpectations(buildExpectations({ statuses: "", headers: [], body: [] }))).toBe(false);
    expect(hasExpectations(EMPTY_EXPECT)).toBe(false);
  });
});

describe("probeResponse", () => {
  it("turns the engine's empty values into an assertable response", () => {
    expect(probeResponse({ status: 200, body: "ok", error: "" })).toEqual({
      status: 200,
      headers: {},
      body: "ok",
      error: undefined,
    });
    expect(probeResponse({}).status).toBe(0);
    expect(probeResponse({ error: "dial refused" }).error).toBe("dial refused");
  });

  it("feeds checkExpectations straight from a wire record", () => {
    const v = checkExpectations(
      { ...EMPTY_EXPECT, statuses: [204] },
      probeResponse({ status: 204, headers: { "Content-Length": "0" } }),
    );
    expect(v.map((x) => x.pass)).toEqual([true]);
  });

  it("carries the truncation flag through, and only when it is true", () => {
    expect(probeResponse({ status: 200, body: "x", truncated: true }).truncated).toBe(true);
    expect(probeResponse({ status: 200, body: "x", truncated: false }).truncated).toBeUndefined();
    expect(probeResponse({ status: 200, body: "x" }).truncated).toBeUndefined();
  });
});

describe("orDefault", () => {
  it("reads a stored zero as the engine's default, and says it did", () => {
    // config.HTTPProbeConfig stores every field, so a schedule saved with the
    // timeout untouched comes back as 0 — a value the engine never applies.
    expect(orDefault(0, ENGINE_PROBE_DEFAULTS.timeoutSec)).toEqual({
      value: 15,
      defaulted: true,
    });
    expect(orDefault(undefined, ENGINE_PROBE_DEFAULTS.maxBodyBytes)).toEqual({
      value: 4096,
      defaulted: true,
    });
  });

  it("keeps a value the reader actually set", () => {
    expect(orDefault(7, ENGINE_PROBE_DEFAULTS.timeoutSec)).toEqual({
      value: 7,
      defaulted: false,
    });
  });
});

describe("byteLength", () => {
  it("counts UTF-8 bytes, not JS code units", () => {
    expect(byteLength("abc")).toBe(3);
    // The engine caps bodies by bytes, so counting code units would report a
    // multi-byte body as smaller than the cap that cut it.
    expect(byteLength("héllo→")).toBe(9);
    expect(byteLength("")).toBe(0);
  });
});

describe("PROBE_TARGET_PRESETS", () => {
  it("offers absolute URLs with an assertable status and a reason", () => {
    for (const p of PROBE_TARGET_PRESETS) {
      expect(p.url).toMatch(/^https?:\/\//);
      expect(parseStatuses(p.expect), `${p.url} expect`).not.toEqual([]);
      expect(p.note).not.toBe("");
    }
  });
});
