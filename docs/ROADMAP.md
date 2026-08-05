# Roadmap

> What is planned, what is deliberately not, and why. Each entry says what it
> unlocks and what has to be true before it starts.
>
> This is not a backlog. Known defects live in [KNOWN_ISSUES](KNOWN_ISSUES.md);
> lessons from past bugs live in [DESIGN_LESSONS](DESIGN_LESSONS.md).
>
> Last reviewed: 2026-08-05.

---

## Peer sync

Today `hayven sync <peer_url>` is a manual, one-shot, outbound exchange. It
works for the demo case: one person, on a trusted network, remembering to run
it. Everything past that is unbuilt, and the gaps compound.

**Current state, precisely.** Stage 1 shipped, so a daemon now records who it
exchanged with and `hayven crdt peers` answers "who am I synced with?" — but
those identities are self-asserted and unverified. `config.sync_peers` is
declared and validated and read by nothing. Nothing runs on a schedule. And the
daemon has no authentication at all — it refuses to bind a non-loopback address
for exactly that reason, and its own error text says to put it behind something
that authenticates.

### Stage 1 — peer identity *(shipped)*

Reuse the existing `writer_id` as peer identity, advertise it in the Merkle
handshake, record peers in a durable registry populated from BOTH directions,
and expose `hayven crdt peers`.

Small, and useful on its own: it answers a question nothing can answer today.
It also locks in no decision about topology or auth, which is why it can be
built before either is settled. Every later capability — authorisation, audit,
scheduled sync, offboarding — bottoms out in "which peer is this?", and that is
currently unanswerable.

Spec: [RFC-001](RFC-001-peer-sync-and-retention.md) §4. Shipped with a 64-peer
registry cap; see that RFC's implementation-deviations note.

**What it did NOT buy: trust.** Identity is self-asserted. Any caller that can
reach the sync routes can claim any `writer_id`, including one already in the
registry. What protects a daemon today is the loopback bind and the two-step
remote opt-in, which are perimeter controls that disappear the moment sync
crosses a real network. [RFC-002](RFC-002-peer-pairing.md) proposes the smallest
fix (a shared secret established once per peer pair) and is awaiting a decision.

### Stage 1b — peer pairing *(proposed, awaiting decision)*

The floor under sync: pairing makes the Stage 1 registry mean something without
committing to a topology or an enterprise auth mechanism. Deliberately sits
below Stages 2 and 3 rather than replacing either, and should land before
Stage 4, because unattended recurring sync with self-asserted identity is worse
than the manual one-shot we have now.

Spec: [RFC-002](RFC-002-peer-pairing.md). **Entry condition:** David answers the
four open questions in §6, starting with whether it is worth building before a
design partner exists.

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

Stage 1b is not a substitute for this and must not be sold as one. When a
partner names their mechanism it replaces pairing's proof step, while the
identity, the registry and the pairing UX survive.

### Stage 4 — scheduled sync

Gives `config.sync_peers` its meaning: the peers this daemon initiates sync
with. Cheap once Stages 1 and 3 exist; incoherent before them, and it should
not ship before Stage 1b either: nobody is watching an unattended sync when it
goes wrong.

---

## Engineering debt (committed, sequenced)

### Deduplicate the hand-synced rule copies *(shipped)*

Three rules lived in more than one place and were kept aligned by hand: the
edge-resolution index rules, the context-pack assembly closure, and the "is this
a test file" predicate. The last turned out to have FOUR definitions, one of
them carrying a comment that falsely claimed to mirror another.

Each is now single-sourced. The test-file predicate generates both a TypeScript
predicate and a SQL fragment from one glob list, so the two mechanisms cannot
drift again; the affected-tests selector stays deliberately separate because it
answers a different, user-configurable question, and now says so.

### Decompose `ingest.ts` and `context_pack.ts` along their comment seams *(shipped)*

Carved into seven modules, with the path-containment security gate isolated as
`db/pack_containment.ts`. Both originals became re-export barrels, so no
consumer needed an edit, and a pre-existing import cycle between
`context_pack.ts` and `imported_symbol.ts` fell out as a two-line fix.

`drainIntoIndex` (~660 lines) and the pack builders (~730) were moved intact.
Splitting either requires deciding where shared assembly logic belongs, which is
a design change; that is the next candidate here, not a leftover from this one.

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
