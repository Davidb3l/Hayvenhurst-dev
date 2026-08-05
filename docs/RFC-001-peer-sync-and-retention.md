# RFC-001: Peer sync, and why retention pruning is not worth building

> Status: **Recommendation — do not build CRDT pruning.** Written 2026-08-02.
>
> Revises [KNOWN_ISSUES](KNOWN_ISSUES.md) #3. Proposes a much smaller change
> that is independently useful.

---

## 1. Start with the measurement

`KNOWN_ISSUES` #3 says the CRDT log grows forever and describes a peer
acknowledgement protocol as the fix. The first draft of this RFC designed that
protocol in full: peer identity, a durable registry, a negotiated retention
horizon, staged rollout.

Then someone asked why we were risking user data at all, and the obvious
question got asked for the first time: **how fast does it actually grow?**

Measured on a real install with five registered projects, two months of daily
use:

| | |
|---|---|
| Largest CRDT directory | **12 KB** |
| Total across every log, all projects | **2,098 bytes** |
| Oldest segment | 2026-05-31 |
| Projected growth | **~12 KB/year** |
| Time to reach the 512 MiB warning threshold | **~42,600 years** |

A user generating a hundred times more CRDT traffic still needs roughly four
centuries to trip the warning that already exists.

**The growth is unbounded in the formal sense and irrelevant in every practical
one.** No pruning protocol should be built for it.

---

## 2. What that changes

The proposed design carried a permanent-data-loss risk. Operations are the
durable record of graph history; a peer that prunes a day nobody else kept has
destroyed it irrecoverably. Accepting that risk requires a proportionate
benefit, and there is none at 12 KB/year.

Worth being explicit about the reasoning error, because it is the same one this
codebase has been fixing all week: `KNOWN_ISSUES` #3 stated a problem and
sketched a solution, and the solution was designed without re-testing the
premise. A written-down design reads as an established requirement. It is not
one.

**Recommendation: close #3 as "will not fix", with the measurement recorded so
the next person does not redesign this from the same stale premise.**

---

## 3. If growth ever does become real

Should a workload appear that generates orders of magnitude more operations,
these are the options in ascending order of risk. Deletion is last, not first.

1. **Fix the loading strategy, not the data.** `hydrate()` reads every segment
   at daemon start. That is a memory concern, and it is separable from disk:
   lazy-load per type, or stream rather than reading whole files. `GsetState`
   already keys ops in a `Map` and applies idempotently, so the in-memory shape
   is closer to a materialised set than to a raw append log. **No data is
   destroyed and no peer coordination is needed.** This is where to start.
2. **Compress cold segments in place.** Segments are newline-delimited records
   and compress well. A gzipped segment is still present, still readable, still
   Merkle-comparable after decompression. Bounded disk, zero data loss, no
   protocol change.
3. **Snapshot plus tail.** Materialise state to a checkpoint and retain the
   operations behind it. More involved, still non-destructive.
4. **Actual deletion with peer acknowledgement.** Only if 1 through 3 are
   exhausted, and only with the safety properties the first draft of this RFC
   laid out: off by default, journalled before deleting, empty-peer-registry
   means prune nothing.

The point of this ordering: three non-destructive options exist and none of
them were considered before a destructive protocol was designed.

---

## 4. What IS worth building: peer identity

One genuinely useful thing surfaced while investigating, and it stands on its
own with no relationship to pruning.

**`config.sync_peers` is dead configuration.** It is declared in
`config/defaults.ts` and validated in `config/load.ts`, and **read by nothing**.
It does not influence any behaviour. Verified by grep across `daemon/src`.

**A daemon cannot answer "who am I synced with?"** `hayven sync <peer_url>` is
one-shot and outbound-only. The responding daemon never learns who called;
there is no record that a sync ever happened. For a tool whose pitch includes
multi-machine collaboration, that is a real gap — not because pruning needs it,
but because a user cannot see the state of their own fleet.

### Proposal

**Reuse `writer_id`, do not mint a second identity.** Every daemon already has
a stable one in its global config and the CRDT depends on it for attribution.
Two notions of "who am I" is the duplicate-decision-function shape that caused
several bugs in this codebase already.

Additive handshake field on `GET /api/sync/merkle` (existing fields unchanged,
so an older peer simply omits it):

```jsonc
{
  "lww": "<root>", "gset": "<root>", "orset": "<root>",
  "peer": { "writer_id": "bc5bca09…", "protocol": 3 }
}
```

A durable registry at `<project>/.hayven/peers/known.json` — a directory that
already exists — populated from **both** directions: outbound when
`hayven sync` reaches a peer, inbound when `/push` or `/batch` is served. Keyed
by `writer_id`, not URL, so a peer that changes host stays the same peer.

Then `config.sync_peers` acquires an honest meaning: the peers this daemon will
*initiate* sync with, for a future scheduled sync. And `hayven crdt peers`
answers a question nothing can answer today.

> **Concurrency note.** `known.json` is a read-modify-write on a file two
> processes can touch. The project registry had exactly this bug and silently
> lost 8-10 of 24 concurrent registrations. Reuse the advisory-lock helper in
> `daemon/registry.ts` rather than writing a second one.

### Implementation deviations

The shipped implementation (`daemon/src/crdt/peers.ts` and its call sites)
deliberately departs from the sketch above in four places. Recorded here so
nobody "fixes" the code back toward this section's stale details.

1. **Per-peer files, not `known.json`.** The registry is a directory,
   `<project>/.hayven/peers/known/<writer_id>.json`, one file per peer, not the
   single keyed object proposed above. The concurrency note recommended reusing
   the advisory lock in `daemon/registry.ts`, but that lock is module-private
   and its lease bookkeeping is bound to the one hard-coded registry path, so
   it cannot guard a second file without being copied. Copying it would create
   the second lock implementation the note warns against. Per-peer files remove
   the read-modify-write instead of locking it: writes about different peers
   touch disjoint paths and structurally cannot lose each other.
2. **`SYNC_PROTOCOL_VERSION = 1`, not `protocol: 3`.** The `3` in the JSON
   sketch above is illustrative. No version counter existed before this work,
   so the real one starts at 1; inventing a history would make the first
   genuine bump ambiguous. A peer that sends no handshake is recorded as
   protocol *unknown*, never as any assumed number.
3. **`writer_id` is per-project, not global.** The proposal says "global
   config"; the actual identity lives in each project's
   `<project>/.hayven/config.json` (see `crdt/hlc.ts:loadOrCreateWriterId`).
   One machine serving several projects therefore presents one identity per
   project, and the registry is correspondingly per-project.
4. **The registry is capped at 64 peers (`MAX_KNOWN_PEERS`).** Sync is
   unauthenticated and identity is self-asserted, so without a bound a caller
   looping over random ids mints unbounded files and buries the real fleet in
   noise. At the cap, a new id is refused with a one-time warning and no file
   is created; already-known peers always update, so a full registry never
   stops the real fleet from refreshing `last_synced`.

### Scope

Small. One additive response field, one small registry directory, two call
sites that record a peer, one read-only CLI command. No deletion, no protocol
negotiation, no data at risk.

---

## 5. Open question

The 12 KB/year figure comes from one install. If a genuinely heavy multi-agent
workload produces a different number by orders of magnitude, section 3 becomes
live and section 1's conclusion should be re-tested — with a measurement, not
an assumption.

---

*Written against `main` at v0.0.7. Supersedes the inline design note in
`daemon/src/crdt/retention.ts`, which proposed the acknowledgement protocol and
should now point here instead.*
