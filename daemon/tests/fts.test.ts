import { describe, expect, it } from "bun:test";

import { escapeFtsQuery } from "../src/db/fts.ts";

describe("escapeFtsQuery", () => {
  it("quotes each term and joins with spaces (implicit AND)", () => {
    expect(escapeFtsQuery("login handler")).toBe('"login" "handler"');
  });

  it("strips FTS5-significant punctuation", () => {
    expect(escapeFtsQuery('"foo" NEAR (bar)')).toBe('"foo" "NEAR" "bar"');
  });

  it("returns empty string for whitespace-only input", () => {
    expect(escapeFtsQuery("   ")).toBe("");
  });

  it("keeps unicode identifiers", () => {
    expect(escapeFtsQuery("café_handler")).toBe('"café_handler"');
  });
});
