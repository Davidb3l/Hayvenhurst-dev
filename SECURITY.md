# Security Policy

Hayvenhurst orchestrates AI agents that read and modify code, sync data between peers, and call out to LLM providers. Security is treated as a v1 requirement, not a v2 polish.

## Supported versions

During the pre-1.0 era, only the latest `0.x` release receives security fixes. After v1.0, the most recent stable major version is supported.

## Reporting a vulnerability

Email **`dev@hayvenhurst.dev`** with details. For sensitive reports, encrypt your message with the project PGP key (block below).

We commit to:

- Acknowledging your report within **48 hours**.
- A coordinated disclosure window of **90 days** from acknowledgment.
- Crediting reporters in the release notes (unless you prefer to remain anonymous).

There is no bug bounty in v1. We may add one if commercial scale ever justifies it.

## PGP key

Use this key to encrypt sensitive vulnerability reports to `dev@hayvenhurst.dev`. Verify the fingerprint out-of-band (e.g., against the copy in the repository at this commit) before trusting the key.

- **User ID:** `David B (Hayvenhurst project signing key) <dev@hayvenhurst.dev>`
- **Algorithm:** RSA 4096-bit
- **Fingerprint:** `08A5 F340 749A 15D5 F0B9  6F28 1A77 FC68 5EBE CDBB`
- **Created:** 2026-05-16
- **Expires:** 2028-05-15

### Verify

```sh
# Pull the key block from this file (or the GitHub repo) and import it:
gpg --import <(curl -fsSL https://raw.githubusercontent.com/Davidb3l/Hayvenhurst/main/SECURITY.md \
  | sed -n '/BEGIN PGP PUBLIC KEY BLOCK/,/END PGP PUBLIC KEY BLOCK/p')

# Confirm the fingerprint matches the one above:
gpg --fingerprint dev@hayvenhurst.dev
```

### Public key block

```
-----BEGIN PGP PUBLIC KEY BLOCK-----

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
Tys=
=DT0X
-----END PGP PUBLIC KEY BLOCK-----
```

## Threat model

The full threat model lives in section 14.6 of the PRD. Summary of what Hayvenhurst is designed to mitigate:

- **Malicious agent claims** — guarded by the three-layer conflict defense (semantic claims, pre-merge verify, adversarial preview).
- **Prompt injection via codebase content** — daemon treats LLM-generated summaries as data, not commands.
- **Sync data tampering** — operations are content-addressed (Blake3); peers are authenticated via public-key challenge.
- **Native binary tampering** — release tarballs are signed via Sigstore; daemon refuses unsigned binaries in default config.
- **Skill injection** — Hayvenhurst ships a single first-party Skill. No third-party marketplace in v1.

Out of scope:

- Compromised LLM providers (you must trust your model provider).
- Malicious local code in your own project directory (same risk as any editor).
- Nation-state adversaries.

## Crash reporting

Crashes are written locally to `.hayven/crashes/<id>.json`. **Nothing is sent automatically.** Running `hayven report-crash <id>` opens a pre-filled GitHub issue in your browser so you can review what's shared before submitting.
