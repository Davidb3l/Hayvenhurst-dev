#!/bin/sh
# ensure-daemon.sh — SessionStart helper: if this repo is a Hayvenhurst project
# (has .hayven/) and no daemon answers on the configured port, start one
# detached so it outlives this session.
#
# WHY: the daemon used to be started by hand from inside an agent session,
# which made it a child of that session — clearing/exiting the session killed
# it, and every other repo's tools then failed with "could not reach daemon"
# until someone restarted it. This hook closes that gap at session start.
#
# The `( nohup … & )` double-detach works with BOTH daemon generations: an
# older `hayven daemon start` that runs in the foreground gets orphaned to
# init and keeps running; a newer one that self-detaches simply exits after
# spawning the real daemon. Never blocks the session: everything is
# best-effort and silent unless action is needed.

set -eu

log() { printf '%s\n' "$*" >&2; }

# Only act inside Hayvenhurst projects.
#
# `$HOME/.hayven` is the GLOBAL config dir (registry, writer id, logs), not a
# project marker — so a bare `[ -d .hayven ]` says "yes, a project" whenever a
# session happens to start in the home dir. That started a daemon with cwd=$HOME,
# which registered the user's ENTIRE home tree as one project and indexed it.
# Home is never a project: bail before the marker check.
#
# Guard the compare on HOME being set AND non-empty first. Under `set -u` an
# unset HOME aborts the script at expansion time (before any `2>/dev/null` can
# suppress it), and — worse — `cd ""` SUCCEEDS and stays put, so an empty HOME
# would make `$(cd "$HOME" && pwd -P)` return the CURRENT dir and the equality
# hold everywhere, silently disabling this hook in every project. Empty/unset
# HOME shows up under launchd/systemd, some CI runners, and slim containers;
# there we cannot identify home, so just skip the home check and carry on.
#
# Resolve it ONCE here. Every later `$HOME` use has the same `set -u` hazard,
# and an empty HOME would otherwise send the log dir to `/.hayven/logs` (which
# fails read-only on macOS).
HOME_DIR="${HOME:-}"
if [ -n "$HOME_DIR" ] && [ -d "$HOME_DIR" ]; then
  [ "$(pwd -P)" != "$(cd "$HOME_DIR" && pwd -P)" ] || exit 0
fi
[ -d .hayven ] || exit 0

# Find the hayven binary: PATH first, then the plugin's persistent install dir.
HAYVEN_BIN=""
if command -v hayven >/dev/null 2>&1; then
  HAYVEN_BIN="$(command -v hayven)"
elif [ -x "${CLAUDE_PLUGIN_DATA:-$HOME_DIR/.local}/bin/hayven" ]; then
  HAYVEN_BIN="${CLAUDE_PLUGIN_DATA:-$HOME_DIR/.local}/bin/hayven"
else
  # install-hayven.sh --check (the other SessionStart hook) already tells the
  # user how to install; nothing useful to add here.
  exit 0
fi

# Daemon port: every project defaults to 7777; honor a config override when
# one is present (cheap grep — .hayven/config.json is small and flat).
PORT="$(grep -Eo '"daemon_port"[[:space:]]*:[[:space:]]*[0-9]+' .hayven/config.json 2>/dev/null | grep -Eo '[0-9]+$' || true)"
PORT="${PORT:-7777}"

# Already up? Done. (curl ships on macOS and ~every Linux; without it, skip
# the probe and let the daemon's own already-running handling sort it out.)
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    exit 0
  fi
fi

# Start detached: orphaned via subshell + nohup so it survives this session's
# process group. Output goes to the user-global log the daemon also uses.
# (Backgrounding always "succeeds"; a failed start surfaces in autostart.log
# and the next session's health probe retries.)
# With no usable HOME, fall back to a temp dir rather than `/.hayven/logs`,
# which `mkdir -p` cannot create on a read-only root.
if [ -n "$HOME_DIR" ]; then
  LOG_DIR="$HOME_DIR/.hayven/logs"
else
  LOG_DIR="${TMPDIR:-/tmp}/hayven-logs"
fi
mkdir -p "$LOG_DIR"
( nohup "$HAYVEN_BIN" daemon start >>"$LOG_DIR/autostart.log" 2>&1 & )
log "hayven: daemon was not running, started it (port $PORT, log: $LOG_DIR/autostart.log)"
