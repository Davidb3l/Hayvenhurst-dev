# Known issues

> Everything here is a decision, not an oversight. Each entry says what is
> wrong, what it costs you, why it is not fixed yet, and what fixing it would
> take. If you hit one of these, you are not the first and it is not a surprise.
>
> Last reviewed: 2026-08-02.

These came out of a five-round audit that began with a daemon indexing a user's
entire home directory for six hours (98% CPU, 195 GB read, a 593 MB index, a
576 MB log) without ever erroring. That bug and roughly fifty of its relatives
are fixed. These are the ones that are not.

---

## 1. Two files can collide onto one graph id

**What.** `scopeForFile` elides a leading `src/` segment, so `a/src/b.ts` and
`a/b.ts` derive the same module id `a/b`. Ids are the primary key of the `nodes`
table, so one file silently overwrites the other.

**Cost.** In a repo containing both spellings, one file's symbols are missing
from the graph. Queries answer confidently and incompletely.

**Why not fixed.** No per-path function can distinguish them; the information is
genuinely lost by the elision. A real fix is an id-scheme migration — stop
eliding and fold `src` into a reserved marker segment — which changes *every*
stored id and therefore requires a coordinated rewrite of the `nodes`, `edges`
and `call_sites` primary keys, every `.hayven/nodes/**.md` path, and the
`fleet_memory.node_id` and `claims` anchors, gated on a schema version bump with
a forced full reindex.

**Mitigation shipped.** Ingest now detects a cross-file collision, warns naming
both files, and records `last_ingest_id_collisions`. It is loud instead of
silent. Detection is per-run, so an incremental ingest will not see a collision
against a file it did not re-parse.

---

## 2. Ingest holds the whole graph in memory

**What.** `runIngest` accumulates all nodes and raw edges for the entire repo
before resolving edges, because edge resolution builds several cross-repo
indexes and the markdown writer and orphan sweep both need the full set. Heap
scales linearly with repo size.

**Cost.** A very large repo can exhaust memory during a full ingest.

**Why not fixed.** Streaming means spilling both collections to SQLite and
rewriting the resolver to query it — a rewrite of the ingest core with real
false-edge risk. It needs its own change with its own review, not a slot in a
multi-lane pass.

**Mitigation shipped.** Hard caps on files (200k), nodes (2M) and edges (5M),
each overridable by environment variable. Exceeding one aborts loudly, names the
cap and its override, and leaves the index marked unusable rather than
half-written and claiming health.

---

## 3. The CRDT log grows forever (measured: not worth fixing)

**What.** The operation log and G-Set are append-only by design. Nothing prunes
them. Every daemon start reads every segment.

**Cost.** Measured, rather than assumed, on a real install with five projects
and two months of daily use: the largest CRDT directory is **12 KB**, the total
across every log is **2,098 bytes**, and projected growth is **~12 KB/year**.
Reaching the 512 MiB warning threshold takes roughly **42,600 years**. A user
generating a hundred times more traffic needs about four centuries.

**Status: will not fix.** An earlier draft of this entry described a peer
acknowledgement protocol as the remedy, and a design for it was written before
anyone measured the growth. That design carried permanent-data-loss risk —
operations are the durable record of graph history, and a peer that prunes a day
nobody else kept has destroyed it. There is no benefit at 12 KB/year to justify
that risk.

If a workload ever appears that changes the number by orders of magnitude, three
non-destructive options come first and none of them require peer coordination:
fix the startup loading strategy (a memory concern, separable from disk),
compress cold segments in place, or snapshot-plus-tail. Deletion is the last
resort, not the first design. See
[RFC-001](RFC-001-peer-sync-and-retention.md).

**Mitigation shipped.** Retention limits are measured and warned at the append
path (not only at daemon start, where the log is smallest), and
`hayven crdt retention` reports size, segment counts, violations and limits.

---

## 4. The packer can read a gitignored source file

**What.** The context packer refuses anything the indexer would not admit —
hidden paths, always-pruned directories, non-source extensions — plus a
credential denylist. It does not evaluate `.gitignore`.

**Cost.** A gitignored file that is non-hidden, outside every pruned directory,
and carries a source extension (a generated `src/gen/keys.ts`) can be named
explicitly and read into a context pack.

**Why not fixed.** Correct gitignore semantics means negations, `**`,
directory-only rules, nested ignore files, `.git/info/exclude` and
`core.excludesFile`. Hand-rolling that is how subtle bugs get written.

**Proposed fix.** Expose the Rust side's existing `ignore` crate as a batch
query over the current IPC (`{"op":"check_ignored","root":…,"paths":[…]}`),
built from the same walker configuration as discovery so the two cannot drift.
Batch rather than per-path, because the packer's synchronous stdio server cannot
afford a subprocess round-trip per read.

---

## 5. Static viewer assets are containment-checked lexically

**What.** `resolveStatic` in the viewer route uses a lexical `relative()` check
with no realpath resolution, so a symlink planted inside the built viewer
directory would be served.

**Cost.** Low. It requires write access to the build output, at which point an
attacker has better options.

**Why not fixed.** It is the third copy of a containment check that was hardened
twice elsewhere this round; the right fix is to route it through the same shared
helper rather than patch a third implementation, which is a small refactor that
did not fit this pass. Recorded so it is not rediscovered as a novel finding.

---

## 6. Trace ingestion cannot address a project

**What.** Mutating daemon endpoints now require an explicit project selector.
`POST /api/traces/observations` is exempted, because the Go, Python and Rust
trace collectors know only a base URL and their payload carries no repository
root.

**Cost.** On a daemon serving several projects, trace observations land in the
primary project rather than the one that produced them.

**Why not fixed.** It needs a selector added to the collector wire format, which
is a cross-repository change across three SDKs.

---

## 7. `$HOME` unset or empty degrades several guards

**What.** Under launchd, systemd, some CI runners and slim containers, `$HOME`
is empty or unset. Path redaction in error bodies unions `$HOME`, `os.homedir()`
and `$HAYVEN_HOME` so it still functions, and the session-start hook resolves
home once and skips its home check rather than crashing.

**Cost.** In an environment where none of the three resolves, redaction cannot
identify home and absolute paths may appear in error responses.

**Why not fixed.** There is no fourth source of truth to consult. Recorded as a
known limit rather than pretended away.

---

## 8. One log-rotation fix rests on `rename(2)`, not on a test

**What.** Cross-process log rotation uses an `O_EXCL` lock; the stale-lock steal
uses `rename` rather than unlink-then-create, so two processes cannot both
believe they won.

**Cost.** None known.

**Why it is listed.** It could not be killed by mutation — eight concurrent
processes passed five out of five runs against the deliberately-broken version,
because the two implementations differ only in a two-syscall race. It is correct
by argument from the atomicity of `rename(2)`, not by evidence. That distinction
is worth knowing if it ever misbehaves.

---

## 9. The test suite's sandbox is belt-and-braces, not proven

**What.** `bun test` forces a throwaway `$HAYVEN_HOME` for the whole test
process via a preload, because per-file sandboxing let work that outlived its
test write to the real registry after `afterEach` had restored the real home.

**Cost.** None to users.

**Why it is listed.** The underlying race is intermittent: it corrupted the
registry on one full-suite run and did not reproduce on the next, so the preload
cannot be shown load-bearing by reverting it. It is retained because it makes
the failure impossible rather than unlikely, but that is a design argument, not
a green-to-red demonstration.

---

## 10. Affected-tests does not follow `export *` re-export hops

**What.** The affected-tests selector walks the import graph to find tests
reachable from a change. A re-export chain that passes through `export * from`
is not followed: the wildcard carries no symbol names, so the walk cannot tell
which downstream importers actually consume the changed symbol and stops rather
than guess.

**Cost.** A test importing a changed symbol only through an `export *` barrel
is not selected — the gate can pass while a genuinely affected test never ran.
Monorepos with barrel-file conventions are the exposed population. The
full-suite CI run still catches the regression; only the selective gate
under-selects.

**Why not fixed.** Following the hop soundly means resolving the wildcard to a
concrete symbol set per re-exporting module and intersecting with the change.
That is real resolver work, not a walk tweak, and over-selecting (treating
`export *` as "everything downstream is affected") would erode the selector's
value on exactly the repos that use barrels most. Fix belongs with the next
resolver-quality investment; until then the limitation is documented here and
in the `--gate` help text's spirit: the gate narrows, CI proves.
