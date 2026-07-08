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
[ -d .hayven ] || exit 0

# Find the hayven binary: PATH first, then the plugin's persistent install dir.
HAYVEN_BIN=""
if command -v hayven >/dev/null 2>&1; then
  HAYVEN_BIN="$(command -v hayven)"
elif [ -x "${CLAUDE_PLUGIN_DATA:-$HOME/.local}/bin/hayven" ]; then
  HAYVEN_BIN="${CLAUDE_PLUGIN_DATA:-$HOME/.local}/bin/hayven"
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
LOG_DIR="$HOME/.hayven/logs"
mkdir -p "$LOG_DIR"
( nohup "$HAYVEN_BIN" daemon start >>"$LOG_DIR/autostart.log" 2>&1 & )
log "hayven: daemon was not running, started it (port $PORT, log: $LOG_DIR/autostart.log)"
