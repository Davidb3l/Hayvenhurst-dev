# Roadmap

> What is planned, what is deliberately not, and why. Each entry says what it
> unlocks and what has to be true before it starts.
>
> This is not a backlog. Known defects live in [KNOWN_ISSUES](KNOWN_ISSUES.md);
> lessons from past bugs live in [DESIGN_LESSONS](DESIGN_LESSONS.md).
>
> Last reviewed: 2026-08-04.

---

## Peer sync

Today `hayven sync <peer_url>` is a manual, one-shot, outbound exchange. It
works for the demo case: one person, on a trusted network, remembering to run
it. Everything past that is unbuilt, and the gaps compound.

**Current state, precisely.** The responding daemon never learns who called, so
it cannot answer "who am I synced with?". `config.sync_peers` is declared and
validated and read by nothing. Nothing runs on a schedule. And the daemon has
no authentication at all — it refuses to bind a non-loopback address for
exactly that reason, and its own error text says to put it behind something
that authenticates.

### Stage 1 — peer identity *(in progress)*

Reuse the existing `writer_id` as peer identity, advertise it in the Merkle
handshake, record peers in a durable registry populated from BOTH directions,
and expose `hayven crdt peers`.

Small, and useful on its own: it answers a question nothing can answer today.
It also locks in no decision about topology or auth, which is why it can be
built before either is settled. Every later capability — authorisation, audit,
scheduled sync, offboarding — bottoms out in "which peer is this?", and that is
currently unanswerable.

Spec: [RFC-001](RFC-001-peer-sync-and-retention.md) §4.

### Stage 2 — topology decision *(a conversation, not a build)*

**Mesh or hub?** The CRDT design has already answered *mesh* — peer to peer,
eventual consistency, no server. That is a good fit for developer laptops. It
was also inherited rather than chosen.

Enterprise usually wants a **hub**: one authoritative endpoint for audit,
backup, retention policy, access control and offboarding. "Which machines has
our code graph been on?" is not a question a mesh can answer, and a security
review will ask it. CRDTs work fine in a hub topology — the hub is simply a peer
everyone syncs with — but the choice drives the auth model, the deployment
story and the pricing.

Decide this before writing auth code, not after.

### Stage 3 — authentication *(gated on a design partner)*

Deliberately unspecified. Enterprise auth requirements diverge violently: mTLS,
OIDC, SAML, API keys, an internal SSO provider, or "it runs in our VPC and talks
to nothing." Guessing costs a rewrite of the layer guessed at.

**Entry condition:** one real prospect who will state their actual requirement.
Not a survey of what enterprises typically want.

### Stage 4 — scheduled sync

Gives `config.sync_peers` its meaning: the peers this daemon initiates sync
with. Cheap once Stages 1 and 3 exist; incoherent before them.

---

## Engineering debt (committed, sequenced)

### Deduplicate the hand-synced rule copies

Three rules exist in more than one place and are kept aligned by hand: the
edge-resolution index rules (`EdgeResolver` and the incremental re-resolution
pass), the context-pack assembly closure (duplicated ~140 lines across the
two pack builders), and the "is this a test file" predicate (two disagreeing
definitions between the packer and FTS scoring). Every past quiet bug in this
codebase came from two correct pieces of code disagreeing about a rule; these
are the three standing opportunities for the next one.

**What it unlocks:** a rule change lands in one place with one test.
**Entry condition:** none — this can start any time and should precede new
feature work in the affected files.

### Decompose `ingest.ts` and `context_pack.ts` along their comment seams

Both files are past the point where narrative comments substitute for module
boundaries (1,600 and 1,800 lines). The section headers already name the
seams; the work is carving, not designing, with the full suite green after
each carve.

**What it unlocks:** cheaper review, and smaller blast radius per change.
**Entry condition:** the deduplication above lands first, so the carve moves
one copy of each rule, not two.

### Decompose the native parser (`extract.rs`)

The largest file in the repo (3,500 lines) and also the most stable. Splitting
it carries the worst risk-to-reward of the three, so it waits.

**Entry condition:** the next change to the parser that is more than additive —
do the split as the first commit of that work, not as a standalone refactor.

---

## Not planned

### CRDT retention pruning — will not build

Measured rather than assumed: the operation log grows about **12 KB/year** on a
real five-project install. Reaching the existing 512 MiB warning threshold takes
roughly 42,600 years.

A design for peer-negotiated pruning was written before anyone measured, and it
carried permanent-data-loss risk. There is no benefit at this growth rate to
justify it. If a workload ever changes the number by orders of magnitude, three
non-destructive options come first: fix the startup loading strategy, compress
cold segments in place, or snapshot-plus-tail. Deletion is a last resort.

Full reasoning: [RFC-001](RFC-001-peer-sync-and-retention.md) §1-3.

---

*Add an entry when work is committed to, or deliberately declined. An entry that
does not say what has to be true before it starts is a wish, not a plan.*
