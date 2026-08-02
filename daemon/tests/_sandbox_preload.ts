/**
 * Global test sandbox. Loaded via `preload` in `daemon/bunfig.toml`, so it runs
 * ONCE per test process before any test file is imported.
 *
 * WHY THIS EXISTS
 *
 * Hayvenhurst keeps global state in `~/.hayven` — the project registry, the
 * writer id, the logs. Several test files legitimately drive code that writes
 * there, and the convention was that each such file sandboxes itself by setting
 * `$HAYVEN_HOME` in `beforeEach` and restoring it in `afterEach`.
 *
 * That convention failed, repeatedly and expensively:
 *
 *   - One suite wrote 123 dead `/tmp` roots into the developer's REAL registry
 *     over many runs. The daemon then tried to load every one of them at every
 *     startup.
 *   - A later run added 30 more (`optout-2` … `optout-14`, `small-2` …), and the
 *     numeric suffixes are the tell: `deriveAlias` only appends them when the
 *     SAME registry already holds that alias, so those writes landed after
 *     `afterEach` had already restored the real `$HAYVEN_HOME` — async work
 *     outliving the test that started it.
 *   - Two `hayven daemon` processes were left running against real state.
 *
 * Per-file discipline cannot fix this. A test cannot know when a detached
 * daemon, a queued ingest, or a floating promise it kicked off will get around
 * to writing, and `afterEach` restoring the real home hands that late write the
 * real registry. The failure is silent: the tests pass.
 *
 * So the sandbox is now a PROPERTY OF THE TEST PROCESS, not of each file. A
 * process-wide `$HAYVEN_HOME` set before any test code runs and never restored
 * means a late write has nowhere to land except the sandbox. Files that manage
 * their own `$HAYVEN_HOME` still work — they just nest inside this one, and
 * whatever they restore on the way out is this sandbox, not the real thing.
 *
 * See DESIGN_LESSONS: where a rule can be turned into a mechanism, turn it into
 * one. This is that.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Honour an explicitly-provided sandbox (CI may want a known location); only
// invent one when nothing has been set.
const provided = process.env["HAYVEN_HOME"];
const sandbox =
  provided && provided.length > 0
    ? resolve(provided)
    : mkdtempSync(join(tmpdir(), "hayven-test-sandbox-"));

process.env["HAYVEN_HOME"] = sandbox;

// Fail LOUDLY rather than quietly writing to real state. If the sandbox ever
// resolves to the developer's actual home, every guarantee above is void, and a
// silent pass is exactly how the earlier corruption went unnoticed for weeks.
if (resolve(sandbox) === resolve(homedir())) {
  throw new Error(
    `test sandbox refuses to run: $HAYVEN_HOME resolves to the real home (${sandbox}). ` +
      "Tests write to ~/.hayven and would corrupt the developer's project registry.",
  );
}

// Best-effort cleanup. Deliberately NOT `process.on("exit")` only — a `kill -9`
// or a wedged child skips it, and a leftover temp dir is harmless while a
// half-cleaned one is confusing.
if (!provided) {
  process.on("exit", () => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* a leaked temp dir is not worth failing a test run over */
    }
  });
}
