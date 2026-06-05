/**
 * Locate the `hayven-native` companion binary.
 *
 * Search order (first hit wins):
 *   1. `$HAYVEN_NATIVE_BIN` env var.
 *   2. Sibling of `process.argv[1]` (same directory as the `hayven` CLI binary).
 *   3. `<repo>/native/target/release/hayven-native`
 *   4. `<repo>/native/target/debug/hayven-native`
 *   5. `hayven-native` on `$PATH`.
 *
 * Throws {@link NativeBinaryNotFound} with a clear message if none found.
 */
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const PLATFORM_EXT = process.platform === "win32" ? ".exe" : "";
const BINARY_NAME = `hayven-native${PLATFORM_EXT}`;

export class NativeBinaryNotFound extends Error {
  override readonly name = "NativeBinaryNotFound";
  constructor(public readonly searched: string[]) {
    super(
      `Could not find \`${BINARY_NAME}\`. ` +
        `Hayvenhurst requires the Rust companion binary to function. ` +
        `Searched:\n  - ${searched.join("\n  - ")}\n\n` +
        `Build it with:  cd native && cargo build --release\n` +
        `Or set $HAYVEN_NATIVE_BIN to the absolute path of the binary.`,
    );
  }
}

export interface LocateOptions {
  /** Project root, used to compute repo-relative candidates. */
  repoRoot?: string;
  /** Override of `process.argv[1]`, for testing. */
  argv1?: string;
  /** Override of `process.env.PATH`, for testing. */
  pathEnv?: string;
  /** Override of `process.env.HAYVEN_NATIVE_BIN`, for testing. */
  envOverride?: string;
}

function isExecutableFile(path: string): boolean {
  try {
    const s = statSync(path);
    if (!s.isFile()) return false;
    // We can't easily check the +x bit cross-platform; trust existence.
    return true;
  } catch {
    return false;
  }
}

/** Locate `hayven-native`. Returns the resolved absolute path. */
export function locateNativeBinary(opts: LocateOptions = {}): string {
  const candidates: string[] = [];
  const env = opts.envOverride ?? process.env["HAYVEN_NATIVE_BIN"];
  if (env && env.length > 0) candidates.push(resolve(env));

  const argv1 = opts.argv1 ?? process.argv[1];
  if (argv1) {
    candidates.push(join(dirname(resolve(argv1)), BINARY_NAME));
  }

  if (opts.repoRoot) {
    candidates.push(join(opts.repoRoot, "native", "target", "release", BINARY_NAME));
    candidates.push(join(opts.repoRoot, "native", "target", "debug", BINARY_NAME));
  }

  // PATH lookup.
  const pathEnv = opts.pathEnv ?? process.env["PATH"] ?? "";
  const pathDirs = pathEnv.split(delimiter).filter((p) => p.length > 0);
  for (const dir of pathDirs) {
    candidates.push(join(dir, BINARY_NAME));
  }

  for (const c of candidates) {
    if (existsSync(c) && isExecutableFile(c)) return c;
  }
  throw new NativeBinaryNotFound(candidates);
}

/** Like {@link locateNativeBinary} but returns `null` instead of throwing. */
export function tryLocateNativeBinary(opts: LocateOptions = {}): string | null {
  try {
    return locateNativeBinary(opts);
  } catch {
    return null;
  }
}
