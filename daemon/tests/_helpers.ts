// Tiny helpers for daemon tests. Anything that constructs a `CrdtState` or
// `ServerDependencies` should go through here so the per-test boilerplate
// stays one line.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CrdtState } from "../src/crdt/state.ts";

/** Throwaway CRDT state rooted in a fresh tmp directory. Caller owns the dir. */
export function makeTestCrdtState(): CrdtState {
  const dir = mkdtempSync(join(tmpdir(), "hayven-crdt-test-"));
  return new CrdtState({
    crdtRoot: join(dir, "crdt"),
    configFile: join(dir, "config.json"),
    skipHydrate: true,
  });
}
