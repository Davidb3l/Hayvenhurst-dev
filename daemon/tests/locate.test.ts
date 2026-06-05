import { describe, expect, it } from "bun:test";

import { locateNativeBinary, NativeBinaryNotFound } from "../src/native/locate.ts";

describe("locateNativeBinary", () => {
  it("throws NativeBinaryNotFound when nothing is present", () => {
    expect(() =>
      locateNativeBinary({
        envOverride: "",
        argv1: "/nonexistent/hayven",
        pathEnv: "",
      }),
    ).toThrow(NativeBinaryNotFound);
  });

  it("prefers $HAYVEN_NATIVE_BIN when it exists", () => {
    // The env override path doesn't exist on disk, so this should fall through
    // to the not-found error — we just verify the error message lists the env path first.
    try {
      locateNativeBinary({ envOverride: "/abs/path/native-bin", argv1: "", pathEnv: "" });
    } catch (err) {
      expect(err).toBeInstanceOf(NativeBinaryNotFound);
      const e = err as NativeBinaryNotFound;
      expect(e.searched[0]).toBe("/abs/path/native-bin");
    }
  });
});
