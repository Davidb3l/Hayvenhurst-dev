# `@hayvenhurst/daemon`

The Bun daemon (`hayvend`) and `hayven` CLI that powers Hayvenhurst.

See the top-level [README](../README.md) for project goals and install instructions.

## Layout

- `src/cli.ts` — entrypoint for the `hayven` command.
- `src/cli/*.ts` — one file per CLI subcommand.
- `src/daemon/` — Elysia HTTP control plane and lifecycle management.
- `src/db/` — `bun:sqlite` schema, migrations, queries, and FTS5 helpers.
- `src/graph/` — markdown node reader/writer and entity ID derivation.
- `src/native/` — supervises the `hayven-native` Rust child process and parses its NDJSON stream.
- `src/config/` — config file loading and validation.
- `src/util/` — logging and path helpers.
- `tests/` — `bun test` unit tests.

## Running locally

```bash
# from the repo root
bun install
bun daemon/src/cli.ts init
bun daemon/src/cli.ts daemon start
bun daemon/src/cli.ts query "loginHandler"
```
