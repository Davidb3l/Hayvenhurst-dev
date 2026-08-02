# Design lessons

> Patterns distilled from real bugs found in this codebase. Each lesson
> includes a concrete example from this repo — these are not slogans, they
> are sharpened by having shipped the wrong thing and been caught.
>
> Treat this as a checklist when designing or reviewing distributed-systems
> code. Add to it when a future review surfaces a new class of mistake.
>
> **A note on how well that has worked.** Lessons 16-21 came from one audit,
> and two of them are recurrences of lessons already in this file. Lesson 15
> (an upward marker walk must stop at a boundary) was written after `$HOME`
> was mistaken for a project root; it happened again through a symlinked-home
> spelling the original fix never compared. Lesson 1 (a test that cannot fail
> is not a test) was already here, and that same audit found **eleven** new
> tests that passed with their own fix deleted, written by several different
> authors who had this document available.
>
> Prose does not enforce anything. Where a lesson can be turned into a
> mechanism, turn it into one: mutation-test every regression test by
> reverting the fix and confirming it goes red, and prefer one shared function
> over two implementations plus a comment promising they match. Read this file
> for the classes of mistake; do not rely on having read it.

---

## 1. A test that cannot fail is not a test

A test claiming to guard a property must be *structurally capable* of failing
for that property. If the test's setup makes the property mechanically
guaranteed, it's documentation pretending to be evidence.

**Example.** Week 5 shipped `crdt_convergence.test.ts` claiming to "pass
convergence proofs on simulated partitions." Its gossip delivered every op to
every replica exactly once. For commutative CRDTs that *cannot* fail —
regardless of shuffle order, every replica ends with the same op-set. So the
test couldn't have caught the writer-id collision (it would have made
`mergeLww` diverge), the HLC saturation wedge, or any non-idempotent apply
bug. Six independent fast-check seeds passed and meant nothing.

**Check before shipping a property test.** Mentally insert each known
failure mode into the system under test. Does the test *currently configured*
notice? If not, fix the test, not the system.

The fixed version uses lossy + duplicated + reordered partition delivery,
then a heal phase — now an apply that wasn't idempotent, or a merge that
wasn't commutative on a true tie, *would* diverge replicas. Plus a forced-tie
LWW case that fails on the pre-`contentHash`-tiebreak code.

---

## 2. Every length or count from untrusted bytes must be `checked_*`

Code that decodes inputs from over the network (or any boundary you don't
control) must treat every integer it reads as adversarial. In Rust release
builds, `usize` arithmetic *wraps on overflow* — no panic — and the wrapped
value then propagates into a slice index or a `Vec::with_capacity` and
panics there, far from the bug. Across a C ABI that panic is undefined
behavior.

**Example.** `native/src/serialize/wire.rs::decode_op` for an OR-Remove read
`tag_count = read_varint(...) as usize` then `total = tag_count * TAG_BYTES`
unchecked. A crafted `tag_count = u64::MAX` wrapped `total` to a small value;
`cur.take(total)` then panicked with a slice-out-of-range. Reachable over
`/api/sync/push` from any peer.

**Rules:**
- Every multiply on an untrusted value uses `checked_mul`, returns a wire
  error on `None`.
- Every `pos + n` cursor advance uses `checked_add` — wrapping `usize`
  arithmetic slips past a bounds check before the slice index would catch it.
- Every length-prefixed read validates `length <= remaining` before
  allocating or indexing.
- The FFI boundary wraps the body in `catch_unwind` — defense-in-depth so a
  decoder panic returns an error code instead of unwinding across C ABI (UB).

This is not paranoia: the wire-decoder review found exactly one of these
unchecked multiplies and it was remotely triggerable.

---

## 3. Sync convergence is byte-identity OR set-identity. Pick one and respect it everywhere.

For a content-addressed Merkle tree to identify divergent peers, the leaf
hash must be a function the peers actually agree on.

- **Byte-identity leaf** (`blake3(file_bytes)`): both peers must produce
  byte-identical files for the same op-set. With append-only logs, that
  requires canonical sort + dedup before write — which forfeits the
  append-only property.
- **Set-identity leaf** (`blake3(sorted_op_keys)`): the leaf depends only on
  *which* ops the segment contains, not their byte order. Append-only logs
  work. Cost: decoding the segment to extract keys (cacheable).

**Example.** Week 6 shipped byte-identity leaves over an append-only log.
Two peers appending the same ops in different orders had different file
bytes → different leaves → roots never matched → sync looped forever pulling
"divergent" segments that already had the same op-set. Cross-day sync
*never converged*. The test that should have caught it (see lesson 1)
couldn't.

**And:** whichever you pick, the **identifier the leaf is keyed by must be
a property of the op, not of the local clock.** Files keyed by `now()` put
the same op in different-named files on different peers — no leaf could
ever match. Bucket by `hlc.wall_ms` (an op-intrinsic property) instead.

---

## 4. The "DR is just rsync" line is a lie if your data carries node identity

A naive backup story ("copy the data directory to seed a new replica")
silently breaks any CRDT that uses per-replica identifiers in its merge
function — both replicas now mint operations under the same identity.

**Example.** `.hayven/config.json::writer_id` is part of the §11.3 total-order
key. The original §14.1 spec said "just rsync the directory" without
carve-outs. Copying `.hayven/` into a new install gives two replicas the
same writer ID; they can mint identical `[hlc, writer]` keys for different
content, and the §11.3 total order — which §12 depends on — silently
breaks. Permanent divergence, no warning.

**Rules:**
- Separate **data** from **identity** in the on-disk layout. Document
  exactly what is data (rsync this) and what is identity (regenerate this).
- When in doubt, keep identity local: the new daemon mints its own writer
  ID on first start; only the op-log and the markdown source-of-truth
  travel.
- Add a safety net in the CRDT (e.g., LWW's `contentHash` tiebreak) so an
  accidental collision degrades to deterministic-but-arbitrary instead of
  silent divergence. **The safety net is not a license to copy the ID.**

---

## 5. Inconsistent error handling across "similar" paths is invisible until production

When you have N implementations of "the same protocol" (e.g., subprocess for
parse / serialize / watch), inconsistency between them silently degrades
to whichever one happens to be invoked.

**Example.** Three subprocess paths shared a `version` handshake spec
(§16.4). The watch path *aborted on skew*. The parse path *swallowed the
skew error inside the generic NDJSON catch* and ingested anyway. The
serialize path *never read stderr at all*. The spec was honored once out
of three.

**Rules:**
- Extract the shared step into a single helper used by every implementation
  (the post-fix `parseAndGate` is one such — though one helper per path is
  still three sites of vigilance; a Lint or codified test would be better).
- Write a property test parameterized over every implementation: "for every
  path, a skewed `version` aborts the run."
- When inventing a new IPC channel, list the existing ones and ask: does
  the same invariant apply here? If yes, copy the helper.

---

## 6. The OS event source has a saturation signal — check the right branch

Cross-platform file watchers (here: the `notify` crate over FSEvents /
inotify / RDCW) coalesce events when the OS queue saturates. The signal
they emit is library-specific and can sit on a branch you don't expect.

**Example.** `notify` 8.x delivers inotify `Q_OVERFLOW` and FSEvents
`MUST_SCAN_SUBDIRS` as `Ok(Event{kind: EventKind::Other, flag:
Flag::Rescan})` — i.e., a normal event on the success branch, not an error
on the error branch. Our `is_overflow_err` only checked the error branch.
A 50K-file `git checkout` saturated the queue, the watcher silently
dropped the rescan signal, and `§16.5`'s "overflow → full re-scan" safety
property never fired.

**Rules:**
- Read the upstream library's *current* source for the saturation path
  before shipping the detection. Don't trust documentation; read the code.
- The detection logic deserves its own unit test that constructs the
  exact event shape the OS produces (not just the error branch).
- Coalesce signals before emitting them — emitting one record per raw
  signal makes any rate field meaningless (was: `dropped` always 1).

---

## 7. Concurrency primitives don't compose; serialize once at the boundary

A guard like "only one ingest can run at a time" must serialize every
producer that writes to the protected resource, not just the one you
remember about.

**Example.** Week 6 had an `inFlight` guard on `ingest.start()` that threw
"already running." But the watcher's `onBatch` called `drainIngest`
*directly*, bypassing the guard. And `onOverflow` called `ingest.start` —
which would throw if an `onBatch` was running, and silently swallowed the
error. Two SQLite writers on the same tables, intermittently.

**Rules:**
- Centralize the serialization primitive (here: `runIngestExclusive`).
- Route *every* producer through it. If a caller bypasses it, the
  serialization didn't exist.
- A guard that *throws on contention* is brittle — the caller has to know
  to retry. A queue (`prior.then(next)`) is usually what you wanted.

---

## 8. "Reconcile" beats "append" when the source is mutable

Any incremental write path that's "additive" against a mutable source
(file deletion, entity removal, field rename) leaves stale state forever.

**Example.** The watcher's `onBatch` re-parsed changed files and *upserted*.
For a deleted file, `candidates_from_explicit_files` silently dropped it
(can't `metadata`) and the index kept the dead nodes. For a *modified* file
that lost an entity, the old entity row stayed because nothing told the
index it was gone.

**Rules:**
- Classify events by kind. A delete is not a modify.
- For any "additive" pipeline, ask: "what if the source removed something?"
  If the answer is "stale state lingers," reconcile (purge-then-rewrite)
  instead of append (upsert).

---

## 9. Bandwidth claims that don't count what crosses the network are marketing, not measurement

If the protected number is "bytes on the wire," every byte that goes on the
wire must be in the count. Body-only ledgers undersell real cost by 2–3×.

**Example.** `sync_bandwidth.test.ts` counted request + response bodies and
called the headline "5.8 KB total wire transfer." A real HTTP daily sync
adds ~700 B of headers per round-trip × ~16 round-trips = real ~13–16 KB
(still under the <30 KB PRD bound, so the *contract* held — but the
headline was off by 2–3×). This is the kind of error that compounds when
"we measured it" becomes received wisdom.

**Rules:**
- Either model real traffic (headers, framing, base64 inflation) or rename
  the number ("payload bytes," "wire-format bytes") so the gap is visible.
- An assertion that passes against an unrealistically low number is worse
  than a missing assertion — it makes future contributors believe a
  margin they don't have.

---

## 10. Lock the contracts before you write the code

Multi-component systems (here: a Bun daemon + Rust native + TS supervisor
+ HTTP peer protocol) cannot be developed in parallel against a moving
target. Write the spec, lock it, then implement.

**Example.** Both Week 5 and Week 6 followed a "lock contracts in
ARCHITECTURE.md before any code" pattern. Each open question (Q1 HLC
tie-break, Q2 SQL→CRDT migration, Q3 G-Set partition, Q5 version
handshake) was decided *before* implementation, with a one-line entry that
points at the locked section. That made it possible to dispatch parallel
agents (Week 6 traces + claims) and recover from agent crashes (Week 6
watcher) without losing coherence.

**Rules:**
- For any cross-boundary change: write the spec edit first, commit it,
  *then* implement. A spec that lags the code is a spec that's wrong.
- Tag locked sections in the spec so a future contributor knows the bar
  for changing them (CHANGELOG row + version bump).
- Document the *reasoning* for each lock, not just the decision — the
  next contributor needs to know what alternatives were considered and
  why they lost.

---

## 11. A harness whose ground truth uses the system's own signal measures nothing

The §16(4) conflict-rate harness had to answer "did the defense catch a
*real* conflict?" The trap: if "is this pair a conflict?" is defined by
*adjacency* — the same signal Layer C uses to decide — the harness passes
by construction, learning nothing (lesson 1, new mechanism). The fix:
ground truth is defined by **edit interaction over the dependency graph**
(A changes a callee's contract that B depends on), *independent* of the
claim-adjacency the defense reads. Only then can the harness catch the
defense missing something.

**Rule:** a test's notion of "correct" must come from a *different* source
than the code-under-test's notion of "correct." Share the oracle and you've
measured agreement-with-self, not correctness.

---

## 12. A safety guard is not a fix — don't close the blocker because the guard exists

BL-14: the LLM oracle needed a tokenizer the model pull couldn't fetch. One
pass added `isModelPresent` requiring a `tokenizer.json` sidecar — a correct
*guard* that kept the oracle OFF so it wouldn't crash. A later session saw
tokenizer code land and declared BL-14 "solved." But the guard is the
*opposite* of a resolution: it exists precisely *because* the blocker is
unresolved. The real fix (build the tokenizer from GGUF metadata) made the
feature *work*; the guard only made it *safe*.

**Rule:** before marking a blocker resolved, confirm the feature actually
*works*, not just that it no longer crashes. "Doesn't fail" and "does the
thing" are different claims — and a guard around a missing piece reads like
a fix in a diff.

---

## 13. Measure a process's own cost, not its share of the machine

§16(9) wanted watcher idle CPU <0.1%. `top`'s `%CPU` is share-of-machine —
it swings with whatever else runs, so under concurrent agent load it's
noise. The robust number is the process's **own cumulative CPU-time** over a
wall-clock window (`ps -o time`): 0.010 CPU-s over 123 s = 0.0081% of one
core, *independent of contention*. That let us publish a real figure without
a guaranteed-idle machine.

**Rule:** for "how much does X cost," measure X's consumed resource directly
(cumulative CPU-time, RSS), not its instantaneous share of a shared box.
Share-of-machine metrics only mean something on an isolated machine — which
you rarely have.

---

## 14. An in-band sentinel must be impossible to confuse with real data

Edge resolution used the literal string `"ambiguous"` to mark an
unresolvable target. The guard `typeof qn === "string"` accepted it, so
edges to ambiguous names resolved to a **phantom entity id `"ambiguous"`**
instead of `?:<name>` — and it hit the common case (sibling files,
same-named functions). Fixed with `"\0ambiguous"`: a value no real entity id
can take.

**Rule:** a sentinel sharing a type/namespace with real values is a latent
bug. Use a value the domain cannot produce (a NUL-prefixed string, a
distinct enum variant, `Option`/`null`) — never an in-band magic string a
type check waves through.

---

## 15. An upward search for a project marker must stop at a boundary

`detectRepoRoot` walked up for a `.hayven` marker — and found the *global*
`~/.hayven` config dir, so every uninitialized project under `$HOME`
resolved its root to home. `hayven init` then refused ("already exists at
~/.hayven"), and `models pull` would have downloaded GBs into the wrong
place. One dir name meant both "global config" and "project root."

**Rule:** an upward marker walk needs an explicit boundary (stop at `$HOME`,
at a `.git`, at the filesystem root) and must not treat a *global* location
as a *project* one. When two roles share a name, disambiguate by position —
don't hope they never collide.

---

## 16. A guard at the record does not stop the work

`$HOME` got registered as a project and its whole tree was indexed for six
hours. The first fix guarded the *registry* — the one place a root becomes
persistent — reasoning that a root which cannot be stored cannot be served.
It could not survive a restart, and it also did not stop anything: `ingest`,
`reindex`, `view`, `mcp` and `proxy` all resolve a root and walk it without
consulting the registry. The CPU and the 195 GB never touched the guarded
code.

**Rule:** guard the operation that spends the resource, not the bookkeeping
that remembers it. When you add a check, name the exact line that does the
expensive or destructive thing and confirm your check is upstream of *that*.
If several entry points reach it, they all need the guard, or the guard
belongs where they converge.

---

## 17. One spelling per boundary, or the comparison is decorative

Four separate bugs in one audit, all the same: `homedir()` returns the passwd
string with symlinks intact, `process.cwd()` and `realpathSync` return
physical paths. Every `===` between them silently compares unequal on any
host where `$HOME` has a symlinked component — `/home/x` → `/mnt/…`, autofs,
NFS, a relocated macOS home. The `$HOME` guard passed its tests and let the
original bug straight through on exactly those machines. A registry that
stored one spelling and deduped on another opened the same repo twice: two
`Db` handles and two watchers on one WAL.

**Rule:** decide a canonical form at each boundary, convert on the way in,
and compare only canonical to canonical. A path that has been through
`realpath` and one that has not are different types wearing the same
`string`. Test with a symlinked fixture — a test on a non-symlinked tmpdir
cannot see this class at all.

---

## 18. A breaker must measure the quantity that actually hurt you

The runaway was 11,600 ingest cycles in six hours with **10** failures — a
0.09% failure rate, never five in a row. The circuit breaker built in
response tripped on five *consecutive failures*. It would have watched its
own incident happen and never fired. The damage was successful work at an
absurd rate; nothing anywhere bounded rate.

**Rule:** write down the quantity that was actually pathological before
choosing what to threshold. "It kept failing" and "it kept succeeding far too
often" need different instruments, and the second is the one nobody
instruments. A bound on concurrency is not a bound on frequency: serializing
an unbounded loop just makes it tidy.

---

## 19. Two code paths answering the same question will diverge

Found five times in one audit. The full walk honoured `.gitignore` and the
vendor/fixture prunes; the watcher's incremental path applied neither, so the
same repo had two different graphs depending on which path ran last.
`checkIndexIntegrity` and `hasSeedableContent` disagreed on five of eight
index states. Two file-count ceilings used incompatible units (401 vs 1 on
one tree). Two containment helpers, one hardened and one lexical, so a
symlink refused by the packer was blessed by the proxy and read into a
prompt.

**Rule:** when two places decide the same thing, that is one function with
two callers, not two implementations to keep in sync. A comment saying
"mirrors X" is an admission that it will drift — and it always drifts in the
direction where one side is a security check.

---

## 20. A fix that destroys evidence is worse than the bug

Log deduplication was added to stop a runaway loop filling the disk. Its
dedup key included the whole fields object — and every line the loop emits
carries a counter or a timestamp (`{dropped, sinceMs}`, `{changed, deleted}`),
so suppression matched nothing and 10,000 of 10,000 lines were written.
Rotation then capped the disk, which converted an unbounded-disk bug into an
evidence-destruction bug: the loop's own churn rotated its diagnostic history
away within minutes. The next person debugging it would find a bounded log
containing only the last few seconds of a six-hour fault.

**Rule:** when bounding a diagnostic surface, ask what a responder needs to
still be there afterwards. Dedup on the stable part of a message, never on
the varying part. Bounding output is not the same as preserving signal, and
the loudest possible failure is the one that leaves nothing behind.

---

## 21. Parallel fixes collide where neither author is looking

Six agents fixed six disjoint file sets in one pass. One added an
`ingest_in_progress` marker to the `stats` table so a half-written index
could not claim to be fresh. Another, fixing an unrelated bug in a different
file, made `reindex` drop the `stats` table. Both fixes are correct alone;
together they reopened the exact bug the first existed to close, and both
lanes' tests passed.

**Rule:** file-disjoint is not change-disjoint. After any parallel pass,
review the *seams* specifically: enumerate every caller of a changed
function, every reader of a changed table, every consumer of a changed
return type. Budget a review pass whose only job is integration, and give it
the list of what each lane touched — nobody inside a lane can see this.

---

*Add a lesson when a future review surfaces a class of mistake worth
flagging. Each lesson should be concrete (cite the bug), prescriptive (a
rule), and small (under 200 words).*
