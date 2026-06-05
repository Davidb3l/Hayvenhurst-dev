# Contributing to Hayvenhurst

Thank you for considering a contribution. Hayvenhurst is a small project with a single maintainer in v1; that means PRs get reviewed personally and merged when they are right.

## Code of conduct

This project adopts the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Report violations to `dev@hayvenhurst.dev`.

## Developer Certificate of Origin (DCO)

Every commit must be signed off:

```sh
git commit -s -m "your message"
```

The sign-off line (`Signed-off-by: Your Name <you@example.com>`) certifies that you wrote the change or otherwise have the right to submit it under the project's MIT license. See [developercertificate.org](https://developercertificate.org) for the full text. We do not require a CLA in v1.

## Development environment

Hayvenhurst is a monorepo with two language stacks:

- **`daemon/`** — Bun + TypeScript. Run `bun install` from the repo root.
- **`native/`** — Rust. Install [rustup](https://rustup.rs/), then `cargo build` from `native/`.
- **`viewer/`** — Astro. Run `bun install` from `viewer/`.

Typical dev loop:

```sh
# Terminal 1 — build native crate in watch mode
cd native && cargo watch -x build

# Terminal 2 — run the daemon
cd daemon && bun run dev
```

## Tests

- Daemon: `bun test` from `daemon/`.
- Native: `cargo test` from `native/`.
- CI runs both on every push.

## Pull request process

1. Open an issue first if your change is non-trivial — saves you wasted work if the direction is wrong.
2. Branch from `main`. Keep branches focused; one logical change per PR.
3. Add tests for behavior changes.
4. Run the linter and type checker (`bun run check` in `daemon/`, `cargo clippy` in `native/`).
5. Sign off every commit (`git commit -s`).
6. Open the PR with the template. The PR title becomes the commit message after squash merge.

The maintainer aims to respond within a few days. If the PR is not the right fit, you will hear why and what would change that.

## Reporting bugs

Use the appropriate issue template. The `native-binary` and `performance` templates exist because those classes of bug need different reproduction steps than a typical bug.

## Security issues

Do not open a public issue. Email `dev@hayvenhurst.dev`. See [SECURITY.md](SECURITY.md).
