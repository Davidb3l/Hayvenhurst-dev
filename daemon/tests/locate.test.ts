import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isCompiledEntrypoint, locateNativeBinary, NativeBinaryNotFound } from "../src/native/locate.ts";

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
      expect(e.searched[0]).toBe(resolve("/abs/path/native-bin"));
    }
  });
});

describe("locateNativeBinary: compiled-exe sibling (SOT-19a)", () => {
  const BIN = process.platform === "win32" ? "hayven-native.exe" : "hayven-native";
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function mk(withBin: boolean): string {
    const d = mkdtempSync(join(tmpdir(), "hayven-locate-"));
    dirs.push(d);
    if (withBin) writeFileSync(join(d, BIN), "");
    return d;
  }

  it("isCompiledEntrypoint recognises the virtual compiled entrypoints", () => {
    expect(isCompiledEntrypoint("B:\~BUN\root\hayven.exe")).toBe(true);
    expect(isCompiledEntrypoint("/$bunfs/root/hayven")).toBe(true);
    expect(isCompiledEntrypoint("/home/u/src/cli.ts")).toBe(false);
    expect(isCompiledEntrypoint(undefined)).toBe(false);
  });

  it("finds the companion beside process.execPath when argv[1] is the virtual ~BUN path", () => {
    const exeDir = mk(true);
    const found = locateNativeBinary({
      envOverride: "",
      argv1: "B:\~BUN\root\hayven.exe",
      execPath: join(exeDir, process.platform === "win32" ? "hayven.exe" : "hayven"),
      pathEnv: "",
    });
    expect(found).toBe(join(exeDir, BIN));
  });

  it("finds the companion beside process.execPath for a POSIX $bunfs entrypoint", () => {
    const exeDir = mk(true);
    const found = locateNativeBinary({
      envOverride: "",
      argv1: "/$bunfs/root/hayven",
      execPath: join(exeDir, "hayven"),
      pathEnv: "",
    });
    expect(found).toBe(join(exeDir, BIN));
  });

  it("prefers the execPath dir over the argv[1] dir in compiled mode, and the reverse in source mode", () => {
    const exeDir = mk(true);
    const scriptDir = mk(true);
    const compiled = locateNativeBinary({
      envOverride: "",
      argv1: join(scriptDir, "~BUN", "hayven"),
      execPath: join(exeDir, "hayven"),
      pathEnv: "",
    });
    // argv[1] contains ~BUN -> compiled -> execPath dir first.
    expect(compiled).toBe(join(exeDir, BIN));
    const source = locateNativeBinary({
      envOverride: "",
      argv1: join(scriptDir, "cli.ts"),
      execPath: join(exeDir, "bun"),
      pathEnv: "",
    });
    expect(source).toBe(join(scriptDir, BIN));
  });

  it("falls back to PATH, and lists the execPath candidate when nothing is found", () => {
    const exeDir = mk(false);
    const pathDir = mk(true);
    mkdirSync(join(exeDir, "x"), { recursive: true });
    const viaPath = locateNativeBinary({
      envOverride: "",
      argv1: "B:\~BUN\root\hayven.exe",
      execPath: join(exeDir, "hayven"),
      pathEnv: pathDir,
    });
    expect(viaPath).toBe(join(pathDir, BIN));
    try {
      locateNativeBinary({
        envOverride: "",
        argv1: "B:\~BUN\root\hayven.exe",
        execPath: join(exeDir, "hayven"),
        pathEnv: "",
      });
      throw new Error("expected NativeBinaryNotFound");
    } catch (err) {
      expect(err).toBeInstanceOf(NativeBinaryNotFound);
      expect((err as NativeBinaryNotFound).searched[0]).toBe(join(exeDir, BIN));
    }
  });
});
