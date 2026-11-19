// src/components/KvEditor.test.ts — when the editor may offer to insert its
// example. Inserting overwrites whatever is in the field, so the offer has to
// be withheld the moment the reader has typed anything.

import { describe, expect, it } from "vitest";
import { exampleInsertable, type JsonExample } from "./KvEditor";

const http: JsonExample = {
  note: "An upstream HTTP(S) proxy.",
  config: { address: "proxy.example.com:8080" },
};

const direct: JsonExample = {
  note: "No config required.",
  config: {},
};

describe("exampleInsertable", () => {
  it("offers an insert while the editor is empty", () => {
    expect(exampleInsertable(http, "")).toBe(true);
  });

  it("withholds it once anything is typed — an insert would overwrite", () => {
    expect(exampleInsertable(http, '{"address": "mine:1080"}')).toBe(false);
    expect(exampleInsertable(http, "{")).toBe(false);
    expect(exampleInsertable(http, "// half a thought")).toBe(false);
  });

  it("treats whitespace as empty: an empty editor renders as nothing", () => {
    expect(exampleInsertable(http, "   ")).toBe(true);
    expect(exampleInsertable(http, "\n\t ")).toBe(true);
  });

  it("never offers one for an empty-config example", () => {
    // "This protocol needs no config" is worth showing as the note, but
    // inserting {} over nothing tells the reader nothing.
    expect(exampleInsertable(direct, "")).toBe(false);
  });

  it("is false with no example at all", () => {
    expect(exampleInsertable(undefined, "")).toBe(false);
  });
});
