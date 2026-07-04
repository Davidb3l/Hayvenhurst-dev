/**
 * `reportIdentity` — uniform daemon-identity-result handling shared by every
 * mutating CLI command. Hard mismatch → error + abort; soft warning → note +
 * proceed (the warning must NOT be silently dropped); clean ok → proceed silent.
 */
import { describe, expect, it } from "bun:test";
import { reportIdentity } from "../src/cli/_shared.ts";

describe("reportIdentity", () => {
  it("aborts (false) and prints the error on a hard mismatch", () => {
    const out: string[] = [];
    const proceed = reportIdentity({ ok: false, message: "different project" }, (s) => out.push(s));
    expect(proceed).toBe(false);
    expect(out.join("")).toContain("error: different project");
  });

  it("proceeds (true) but SURFACES the warning on a soft warning", () => {
    const out: string[] = [];
    const proceed = reportIdentity({ ok: true, warning: "old daemon, identity unverified" }, (s) => out.push(s));
    expect(proceed).toBe(true);
    expect(out.join("")).toContain("note: old daemon, identity unverified");
  });

  it("proceeds silently on a clean ok", () => {
    const out: string[] = [];
    const proceed = reportIdentity({ ok: true }, (s) => out.push(s));
    expect(proceed).toBe(true);
    expect(out.join("")).toBe("");
  });
});
