/**
 * THE single answer to "is this index usable?", plus the single parser for the
 * `ingest_in_progress` marker it depends on.
 *
 * WHY THIS FILE EXISTS. The question was being answered in THREE places that
 * disagreed with each other:
 *
 *   1. `Db.checkIndexIntegrity` (queries.ts) — the reader-facing health check.
 *   2. `hasSeedableContent` (branch_index.ts) — an admitted MIRROR ("Mirrors
 *      `Db.checkIndexIntegrity`") that read the marker row directly.
 *   3. `hasIngestMarker` (migrations.ts) — the reindex precondition.
 *
 * They agreed on the happy path and diverged on every degenerate one. The marker
 * value `"0"`, `""` and any non-numeric garbage read as ABSENT in (1), PRESENT in
 * (2), and (for `"0"`/garbage) PRESENT in (3). An index with an empty graph and
 * no watermark read `ok:true` in (1) but "not seedable" in (2). Three code paths
 * deciding the same question differently is the root shape of several of this
 * round's bugs — the empty-graph disagreement is precisely what let an earlier
 * bug land as `ok:true`. So the DECISION now lives here exactly once and the
 * three call sites are thin adapters over it.
 *
 * Deliberately low-level: it takes a raw `bun:sqlite` `Database` and imports
 * nothing from `queries.ts`/`migrations.ts`. `queries.ts` imports `migrations.ts`
 * at module load, so anything both of them can share must sit BELOW both or the
 * import graph cycles.
 */
import type { Database } from "bun:sqlite";

/**
 * `stats` key holding the in-flight ingest declarations.
 *
 * An ingest CLEARS the graph and then repopulates it over minutes, spanning a
 * subprocess — that pair cannot be one SQLite transaction. So we do the
 * equivalent: mark the index unusable BEFORE the destructive step and unmark it
 * only inside the transaction that records success. A reader that finds this
 * marker knows the index is half-written, not fresh.
 */
export const INGEST_IN_PROGRESS_KEY = "ingest_in_progress";

/** One in-flight ingest: an opaque owner token plus when it started (epoch ms). */
export interface InFlightIngest {
  t: string;
  at: number;
}

/**
 * Token for a marker written by an OLDER build as a bare epoch-ms scalar.
 * `beginIngest` adopts it (re-keys it to its own token) rather than leaving it
 * unclearable.
 */
export const LEGACY_TOKEN = "legacy";

/**
 * Token for a marker row that EXISTS but that this build cannot parse into
 * tokens — `"0"`, a negative/NaN scalar, `{"t":…}`, `[{}]`, arbitrary garbage.
 *
 * WHY IT COUNTS AS IN-PROGRESS (the direction the three implementations
 * disagreed on): the row is only ever written by an ingest declaring itself in
 * flight, and it is DELETED — not blanked — when the last ingest retracts. So a
 * present-but-unintelligible value means something wrote a declaration we don't
 * understand, over an index that may be mid-rebuild. Reading that as "no ingest
 * in flight" is fail-OPEN: it disarms the interrupted-ingest detector on exactly
 * the index most likely to be half-written. We fail CLOSED instead, and — like
 * the legacy scalar — `beginIngest`/`endIngest` adopt and clear it.
 *
 * Fail-closed must never mean UNRECOVERABLE. Three escapes exist, and between
 * them every marker is clearable by some normal operation:
 *   - adoptable sentinels (this one, and {@link LEGACY_TOKEN}) are re-keyed to
 *     the next ingest's own token, which that ingest then retracts;
 *   - a real token whose owning process is provably gone is reaped by
 *     `clearGraph` (see {@link isDeadOwnerToken}) — the one moment it is safe,
 *     because the graph that ingest half-wrote is being wiped anyway;
 *   - a real token whose process is ALIVE is left alone, which is the point.
 *
 * `at` is 0 for these (the start time is unknowable); {@link describeIntegrity}
 * says so in words rather than printing a 1970 timestamp.
 */
export const MALFORMED_TOKEN = "malformed";

/** Tokens this build synthesizes for markers it did not write. A new
 *  `beginIngest` ADOPTS these (replaces them with its own token) so they are
 *  always clearable. */
export function isAdoptableToken(token: string): boolean {
  return token === LEGACY_TOKEN || token === MALFORMED_TOKEN;
}

/** The pid a token was minted by (`<pid>:<time36>:<rand>`), or `null` when the
 *  token does not carry one (a foreign or hand-written value). */
function tokenPid(token: string): number | null {
  const head = token.split(":")[0] ?? "";
  if (!/^\d+$/.test(head)) return null;
  const pid = Number(head);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * True only when we can PROVE the process that minted `token` is gone.
 *
 * `process.kill(pid, 0)` sends no signal; it just probes. `ESRCH` means no such
 * process — the only answer we act on. `EPERM` means the process exists but is
 * not ours, i.e. ALIVE. Anything unexpected (including a token with no pid) is
 * treated as alive, because the whole point of this marker is to fail closed.
 *
 * WHY THIS EXISTS: `endIngest` retracts only the CALLING handle's token, and
 * `beginIngest` preserves other processes' tokens so a concurrent ingest cannot
 * be silently un-flagged. Correct — but it meant a token left behind by a
 * process that was SIGKILLed belonged to nobody and could be retracted by
 * nothing. No number of successful rebuilds cleared it, `reindex` preserves the
 * key on purpose, and the only recovery was deleting `index.sqlite`.
 *
 * NOTE ON PID REUSE: a recycled pid reads as ALIVE, so the marker survives —
 * the conservative direction (the index stays flagged, exactly as today).
 */
export function isDeadOwnerToken(token: string): boolean {
  const pid = tokenPid(token);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return false; // signalled successfully → alive
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Parse the raw `stats.ingest_in_progress` VALUE into in-flight entries.
 *
 * `null`/absent, `""` and `"[]"` are the three encodings of "no ingest is in
 * flight" (the writer deletes the row, but an older build or a hand-edit can
 * leave the emptier forms). Everything else that does not parse into at least
 * one well-formed entry is {@link MALFORMED_TOKEN} — present, not absent.
 */
export function parseInFlight(raw: string | null | undefined): InFlightIngest[] {
  if (raw === undefined || raw === null) return [];
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const entries = parsed.filter(
        (e): e is InFlightIngest =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { t?: unknown }).t === "string" &&
          typeof (e as { at?: unknown }).at === "number" &&
          Number.isFinite((e as { at: number }).at),
      );
      // A non-empty array whose every element is junk is NOT "no ingest": the
      // row exists, so treat it as an unparseable declaration.
      if (entries.length > 0) return entries;
      return [{ t: MALFORMED_TOKEN, at: 0 }];
    }
  } catch {
    /* fall through to the legacy scalar form */
  }
  // LEGACY: an older build wrote a bare epoch-ms scalar.
  const n = Number(trimmed);
  if (Number.isFinite(n) && n > 0) return [{ t: LEGACY_TOKEN, at: n }];
  return [{ t: MALFORMED_TOKEN, at: 0 }];
}

/** Read + parse the in-flight entries from `stats`. Returns `[]` when the row
 *  (or the whole table) cannot be read — the caller's integrity check reports
 *  `unreadable` from the failed `stats` read itself. */
export function readInFlight(handle: Database): InFlightIngest[] {
  const raw = handle
    .query<{ value: string }, [string]>("SELECT value FROM stats WHERE key = ?")
    .get(INGEST_IN_PROGRESS_KEY)?.value;
  return parseInFlight(raw);
}

/** Epoch ms the EARLIEST still-unfinished ingest started, or `null` when none
 *  is in flight. `0` means "in flight, start time unknown" (a malformed
 *  marker) — check against `null`, never against falsiness. */
export function inProgressSince(entries: InFlightIngest[]): number | null {
  if (entries.length === 0) return null;
  return entries.reduce((min, e) => (e.at < min ? e.at : min), entries[0]!.at);
}

/** Why an index failed {@link readIndexIntegrity}. */
export type IndexIntegrityReason =
  /** Nothing wrong — the index is structurally usable. */
  | "ok"
  /** An ingest marked the index in-progress and never cleared the marker. */
  | "ingest-interrupted"
  /** The graph is EMPTY but a previous ingest recorded a non-zero node count. */
  | "empty-but-claims-content"
  /** The `stats` table is unreadable (pre-migration / corrupt handle). */
  | "unreadable";

export interface IndexIntegrity {
  /** True iff the index is structurally usable for reads. */
  ok: boolean;
  reason: IndexIntegrityReason;
  /** One human-readable sentence naming the failure, or "" when ok. */
  detail: string;
  /** Live `COUNT(*) FROM nodes`, or -1 when it could not be read. */
  nodes: number;
  /** `last_ingest_nodes` as recorded by the last SUCCESSFUL ingest, or -1. */
  claimedNodes: number;
  /** Epoch ms an unfinished ingest started, `0` when a marker is set but its
   *  start time is unknowable, or `null` when none is marked. */
  inProgressSince: number | null;
}

/** Human sentence for an interrupted ingest. Split out because a malformed
 *  marker has NO start time and printing `new Date(0)` would claim 1970. */
function describeInterrupted(since: number): string {
  if (since <= 0) {
    return (
      "an ingest left an in-progress marker this build cannot parse — the " +
      "graph may be half-written"
    );
  }
  return (
    `an ingest started at ${new Date(since).toISOString()} and ` +
    "never finished — the graph is half-written"
  );
}

/**
 * THE decision. Structural usability of an index, for READERS.
 *
 * Two independent failure modes, both of which previously read as "fresh":
 *   1. `empty-but-claims-content` — the graph holds ZERO nodes while
 *      `last_ingest_nodes` (recorded by the last SUCCESSFUL ingest) says it held
 *      some. Nothing anywhere compared those two numbers, which is how a wiped
 *      index kept certifying itself. Unambiguous corruption; does NOT depend on
 *      the in-progress marker having survived.
 *   2. `ingest-interrupted` — the {@link INGEST_IN_PROGRESS_KEY} marker is still
 *      set, so an ingest cleared and/or partially rewrote the graph and never
 *      finished. Node rows flush in 1000-row batches BEFORE the native exit-code
 *      gate, while ALL edges, call sites and stats are written AFTER it, so a
 *      SIGTERM mid-run yields a structurally wrong graph (nodes with zero edges)
 *      that still looks populated.
 *
 * NEVER throws: a `stats`/`nodes` read failure (pre-migration handle, corrupt
 * file, a foreign SQLite file) yields `unreadable` so callers degrade instead of
 * crashing on what is a best-effort health check.
 */
export function readIndexIntegrity(handle: Database): IndexIntegrity {
  let nodes = -1;
  let claimedNodes = -1;
  let since: number | null = null;
  try {
    nodes = handle.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM nodes").get()?.c ?? -1;
    const claimedRaw =
      handle
        .query<{ value: string }, [string]>("SELECT value FROM stats WHERE key = ?")
        .get("last_ingest_nodes")?.value ?? null;
    if (claimedRaw !== null) {
      const n = Number(claimedRaw);
      if (Number.isFinite(n) && n >= 0) claimedNodes = n;
    }
    since = inProgressSince(readInFlight(handle));
  } catch {
    return {
      ok: false,
      reason: "unreadable",
      detail: "the index's `stats`/`nodes` tables could not be read",
      nodes,
      claimedNodes,
      inProgressSince: since,
    };
  }

  if (nodes === 0 && claimedNodes > 0) {
    return {
      ok: false,
      reason: "empty-but-claims-content",
      detail:
        "the graph holds 0 nodes but the last successful ingest recorded " +
        `${claimedNodes} — the index was wiped by an interrupted rebuild`,
      nodes,
      claimedNodes,
      inProgressSince: since,
    };
  }
  if (since !== null) {
    return {
      ok: false,
      reason: "ingest-interrupted",
      detail: describeInterrupted(since),
      nodes,
      claimedNodes,
      inProgressSince: since,
    };
  }
  return { ok: true, reason: "ok", detail: "", nodes, claimedNodes, inProgressSince: since };
}

/**
 * May this index be COPIED as the seed for a brand-new branch index?
 *
 * A pure derivation of {@link readIndexIntegrity} — the same one decision, with
 * the two extra rules seeding (and only seeding) needs:
 *
 *   - an EMPTY graph → NO, even when integrity says `ok`. A structurally fine
 *     index with zero nodes is a perfectly healthy thing to READ and a useless
 *     thing to COPY: seeding from it propagates emptiness AND the seed's
 *     `last_ingest_git_head`, which makes `cli/ingest.ts` treat the new branch as
 *     eligible for the INCREMENTAL path — so the branch re-parses only the git
 *     diff and stays permanently partial while certifying itself fresh.
 *   - `unreadable` → YES. This predicate exists to stop ONE thing: a real hayven
 *     index that an interrupted ingest EMPTIED being copied into a new branch.
 *     "Cannot tell" (not a SQLite file, no `nodes`/`stats` table, a pre-schema or
 *     foreign index) must preserve the previous seed-it-anyway behaviour, which
 *     the legacy `.hayven/index.sqlite` fallback relies on. A wrong YES costs
 *     what today already costs (a useless seed, then a normal ingest); a wrong NO
 *     costs one full re-parse. Neither loses data.
 *
 * ORDER MATTERS. The empty check runs FIRST, because `unreadable` covers two
 * different situations: `nodes` itself was unreadable (`nodes === -1`, a genuine
 * "cannot tell") and `nodes` read fine as 0 but the `stats` read then failed
 * (e.g. an interrupted first `migrate()`). Testing `unreadable` first would seed
 * from the second case, which is a KNOWN-empty index — the exact thing this
 * predicate exists to refuse.
 */
export function isSeedableIndex(integrity: IndexIntegrity): boolean {
  if (integrity.nodes === 0) return false; // positively read as empty
  if (integrity.reason === "unreadable") return true; // -1 → genuinely cannot tell
  return integrity.ok;
}
