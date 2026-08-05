# Roadmap

> What is planned, what is deliberately not, and why. Each entry says what it
> unlocks and what has to be true before it starts.
>
> This is not a backlog. Known defects live in [KNOWN_ISSUES](KNOWN_ISSUES.md);
> lessons from past bugs live in [DESIGN_LESSONS](DESIGN_LESSONS.md).
>
> Last reviewed: 2026-08-02.

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
