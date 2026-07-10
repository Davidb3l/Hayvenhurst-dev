# Hayvenhurst v0.0.6

## The daemon now outlives the session that started it

Until now `hayven daemon start` ran in the foreground: close the terminal (or
end the agent session) that launched it and the daemon died with it — and every
other repo's tools failed with "could not reach daemon" until someone restarted
it by hand.

**v0.0.6 makes the daemon a proper background service.**

- **`hayven daemon start` detaches by default.** It spawns the daemon as its
  own detached process, waits for the health check, prints the pid and the
  projects it serves, and returns. Exiting your shell or session no longer
  kills it. Use `--foreground` for the old behavior (CI, supervisors).
- **Starting in a second repo joins the running daemon** instead of failing
  with "address already in use" — the repo is registered live and served
  immediately.
- **SIGHUP is handled gracefully** (clean shutdown + pidfile removal), and
  stale pidfiles are cleaned automatically on start.
- **The Claude Code plugin auto-revives the daemon**: a session-start hook
  starts it (detached) in any Hayvenhurst repo where it isn't running.

## Safe sharing: every write is project-addressed

One daemon serving many repos (v0.0.5) needed one more guarantee: a command run
in repo B must never write into repo A's data.

- Mutating CLI commands (`claim`, `release`, `node body`, `sync`, `summarize`)
  now address their own project explicitly; the daemon refuses writes naming a
  project it doesn't serve instead of falling back to the primary.
- **`hayven sync` identifies the peer project before exchanging anything.**
  Syncing against a peer daemon that serves several projects requires
  `--peer-project <alias>` (single-project peers are picked automatically), so
  two different repos can never cross-contaminate each other's history.
- The live-sync WebSocket pins each connection to its selected project, and
  cleanly disconnects peers of a project that is removed from the daemon.

## Releases are now actually signed

A packaging bug meant earlier releases published no signature assets despite
the Sigstore signing step running. Fixed: from v0.0.6 every tarball ships with
its `.sigstore.json` bundle alongside the `.sha256` checksum.

## Upgrade

```sh
/plugin update hayvenhurst        # Claude Code plugin (0.0.6)
/hayvenhurst:install-binary       # fetches this release's binary
hayven daemon stop && hayven daemon start   # restart into the detached daemon
```

Single-repo setups need nothing else; existing indexes are untouched.
