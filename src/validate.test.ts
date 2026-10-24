// src/validate.test.ts — field validators catch bad input before it reaches
// the engine, so the boundary cases here are the ones the forms rely on.

import { describe, expect, it } from "vitest";
import { collect, hostPort, httpUrl, required } from "./validate";

const MSG = "bad";

describe("required", () => {
  it("rejects undefined and whitespace", () => {
    expect(required(undefined, MSG)).toBe(MSG);
    expect(required("   ", MSG)).toBe(MSG);
  });

  it("accepts any non-blank value", () => {
    expect(required("x", MSG)).toBeNull();
  });
});

describe("hostPort", () => {
  it("accepts host:port and [v6]:port", () => {
    expect(hostPort("127.0.0.1:9090", MSG)).toBeNull();
    expect(hostPort("localhost:80", MSG)).toBeNull();
    expect(hostPort("[::1]:9090", MSG)).toBeNull();
  });

  it("rejects missing or out-of-range ports", () => {
    expect(hostPort("not-a-host", MSG)).toBe(MSG);
    expect(hostPort("host:", MSG)).toBe(MSG);
    expect(hostPort("host:0", MSG)).toBe(MSG);
    expect(hostPort("host:65536", MSG)).toBe(MSG);
    expect(hostPort("host:port", MSG)).toBe(MSG);
    expect(hostPort("", MSG)).toBe(MSG);
  });
});

describe("httpUrl", () => {
  it("accepts absolute http(s) URLs only", () => {
    expect(httpUrl("http://127.0.0.1:8080/list.txt", MSG)).toBeNull();
    expect(httpUrl("https://example.com/", MSG)).toBeNull();
    expect(httpUrl("ftp://example.com/", MSG)).toBe(MSG);
    expect(httpUrl("example.com/list.txt", MSG)).toBe(MSG);
    expect(httpUrl("", MSG)).toBe(MSG);
  });
});

describe("collect", () => {
  it("drops nulls and keeps messages", () => {
    expect(collect({ a: null, b: MSG })).toEqual({ b: MSG });
    expect(collect({ a: null })).toEqual({});
  });
});
