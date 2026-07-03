# Hayvenhurst v0.0.5

## Multiple repos from one daemon

Until now a Hayvenhurst daemon served exactly one repository — the directory it
was started in. Install it in two repos and they collided on the same port; you
could only see whichever one the daemon happened to start on.

**v0.0.5 makes one daemon serve any number of repos**, switchable on the fly.

- **`hayven init` registers each project** automatically. Manage the set with
  `hayven daemon register <path>`, `hayven daemon projects`, and
  `hayven daemon unregister <alias|path>`.
- **One daemon serves them all.** Start it once; it opens every registered
  project's index. The graph **viewer gains a project switcher** in the nav,
  and every API endpoint accepts `?project=<alias>` to select a repo
  (defaulting to the primary — the one you started the daemon in).
- **Single-repo setups are unchanged.** The switcher stays hidden, the default
  behavior is identical, and nothing new is required.

### Try it

```sh
hayven daemon register /path/to/repo-a
hayven daemon register /path/to/repo-b
cd /path/to/repo-a && hayven daemon start   # serves BOTH; viewer at :7777
```

Open `http://localhost:7777` and use the project dropdown to switch. Or hit the
API directly:

```sh
curl localhost:7777/api/health                    # lists every project + the primary
curl 'localhost:7777/api/stats?project=repo-b'    # answer for a specific repo
```

## Upgrading

Pre-release (`0.x`) — build from source (Bun 1.3+ and a Rust toolchain), or
reinstall via the Claude Code plugin's binary installer. No migration needed;
existing per-project indexes are picked up as-is.

Full changelog: [`CHANGELOG.md`](../CHANGELOG.md).
