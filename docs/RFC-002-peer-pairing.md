# RFC-002: Peer pairing, the floor under peer sync

> Status: **Proposal, not implemented. Awaiting approval.** Written 2026-08-04.
>
> Builds on [RFC-001](RFC-001-peer-sync-and-retention.md) §4, which shipped peer
> identity. Sits BELOW the [ROADMAP](ROADMAP.md) peer-sync Stage 2 topology
> decision and Stage 3 enterprise authentication, and blocks neither.

---

## 1. What identity actually bought, and what it did not

RFC-001 §4 shipped: a daemon now advertises its `writer_id` in the Merkle
handshake, records peers it exchanges with under
`<project>/.hayven/peers/known/<writer_id>.json`, and answers "who am I synced
with?" through `hayven crdt peers`.

That is a real capability and it was worth building. It is also, precisely, a
**log**. Nothing verifies the identity in it.

`recordPeer` accepts any syntactically valid 32-hex string a caller presents.
There is no secret, no challenge, no signature. Concretely, today:

- Any caller that can reach the sync routes can claim **any** `writer_id`,
  including one already in the registry, and move that peer's `last_synced`.
- Any caller can enroll ids that correspond to no daemon anywhere. The
  `MAX_KNOWN_PEERS = 64` cap added during implementation bounds the damage to a
  full registry rather than an unbounded one; it does not make the contents
  true.
- `/api/sync/push` accepts operations without establishing who sent them.

The registry's own CLI output says the list grants nothing, which is honest. The
gap is that a fleet view nobody can trust is worth noticeably less than one
anybody can.

**What holds this together today is the network boundary, not the protocol.**
The daemon binds loopback, refuses a non-loopback bind without an explicit
two-step opt-in, and (since the Host-header gate) rejects browser-driven
cross-origin reads. Every one of those is a perimeter control. The moment sync
crosses a real network between two machines, the perimeter is gone and there is
nothing underneath it.

---

## 2. What this proposes

**A shared secret, established once per peer pair, presented on every subsequent
sync.**

Pairing is an explicit, human-approved act on both machines, in the spirit of
Bluetooth pairing or `tailscale up`: the user is present, the two daemons
exchange a token, and from then on each can prove it is the peer the other
already agreed to talk to.

```jsonc
// <project>/.hayven/peers/known/<writer_id>.json is the EXISTING record,
// with one added field. Absent field = an unpaired peer, exactly as today.
{
  "writer_id": "bc5bca09…",
  "first_seen": "2026-08-04T…",
  "last_synced": "2026-08-04T…",
  "last_url": "http://…",
  "protocol": 1,
  "paired_secret": "<32 bytes, base64>"   // NEW, never logged, never printed
}
```

Every sync request then carries a proof derived from that secret rather than the
bare `writer_id`. A peer that presents no proof is still served exactly as today
(see §3), so nothing that works now stops working.

### Why a shared secret and not certificates

Certificates need an issuer, a trust root, a revocation story, and a rotation
story. Every one of those is a decision this project cannot make yet, because
Stage 2 (mesh or hub) is undecided and Stage 3 is deliberately gated on a real
design partner's stated requirement. A pairwise secret needs none of them: two
machines, one token, symmetric, revocable by deleting one file.

It is also the smallest change that makes the registry mean something. That is
the whole ambition here. This is not enterprise authentication and must not be
sold as it.

---

## 3. Compatibility, which is the hard part

The protocol must not fracture a fleet mid-upgrade. Three rules:

1. **Unpaired peers keep working, unchanged.** A record with no
   `paired_secret` behaves exactly as it does today: identity is self-asserted,
   the sync is served, the peer is logged. `SYNC_PROTOCOL_VERSION` bumps to 2
   and a version-1 peer is a normal, supported participant.
2. **Once a pair is paired, proof becomes mandatory FOR THAT PAIR.** An
   unauthenticated request claiming a `writer_id` we hold a secret for is
   refused, because that is exactly the impersonation the pairing exists to
   stop. This is the only place the change can break an existing flow, and it
   breaks it only after a human deliberately paired those two machines.
3. **Pairing is never automatic.** No trust-on-first-use. A first contact
   enrolls an unpaired peer, as today; upgrading to paired is a command the user
   runs on both ends.

Sketch of the surface, not a specification:

```
hayven crdt pair <peer_url>     # initiates; prints a short code
hayven crdt pair --accept <code> # confirms on the other machine
hayven crdt peers                # gains a paired/unpaired column
hayven crdt unpair <writer_id>   # deletes the secret, drops to unpaired
```

---

## 4. How this composes with the roadmap

**It does not preempt Stage 2 (mesh or hub).** A pairwise secret is
topology-neutral. In a mesh, peers pair with each other. In a hub, every peer
pairs with the hub and the hub's registry becomes the audit surface an
enterprise asks for. Neither is foreclosed, and neither is assumed.

**It does not preempt Stage 3 (enterprise authentication).** Stage 3 stays
gated on a design partner stating a real requirement, exactly as the roadmap
says, because guessing between mTLS, OIDC, SAML, and "it runs in our VPC" costs
a rewrite of whatever is guessed. Pairing is the floor, not the building: when a
partner names their requirement, their mechanism replaces the proof step while
the registry, the identity, and the pairing UX stay.

**It makes Stage 4 (scheduled sync) safe to want.** Unattended, recurring,
unauthenticated sync is a materially worse idea than the manual one-shot we have
now, because nobody is watching when it goes wrong. Scheduled sync should not
ship before this does.

---

## 5. Scope, honestly stated

Larger than RFC-001 §4 and smaller than an auth system. One new field on an
existing record, one new CLI verb with a confirmation step, a proof on the
existing sync requests, a protocol version bump with a compatibility branch, and
the secret-handling discipline that comes with holding a secret at all (not
logged, not printed, not synced, correct file permissions, and a deliberate
answer for what `hayven doctor` may say about it).

The risk that deserves naming: **this is the project's first secret.** Every
prior local-first design decision was safe partly because there was nothing to
leak. That changes here, and the review bar for the implementation should be set
accordingly.

---

## 6. Open questions for David

1. **Is this worth doing before a design partner exists?** The honest case
   against: nobody is running cross-machine sync today, so this hardens a path
   with no current users, and Stage 3 may replace the mechanism anyway. The case
   for: the registry currently overstates what it knows, and scheduled sync
   should not ship without it.
2. **Pairing UX.** Short numeric code shown on both machines (simple, phone-like,
   requires the user at both ends at once) or a copy-pasted token (easier when
   the second machine is a remote server, more prone to landing in shell
   history)?
3. **Scope of a secret.** Per project pair, matching today's per-project
   `writer_id`, or per machine pair across all projects? Per project is
   consistent and more isolating; per machine is fewer pairing steps for someone
   syncing five repos between the same two laptops.
4. **Does a paired peer get more than authenticity?** Pairing could stay purely
   "prove who you are", or it could gate write access so unpaired peers become
   read-only. The second is a real security improvement and a real behavior
   change for anyone relying on today's open `/push`.

---

*Written against `main` at v0.0.7, after the peer identity work in RFC-001 §4
shipped. Implementation waits on approval of this document.*
