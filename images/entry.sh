#!/bin/sh
# The entrypoint of every runner image: `squad-entry <cli> <args...>`.
#
# The account lock lives here, inside the container, and not in the host process that starts it.
# That host process can die while the container keeps running, and a host lock would then free
# while the account is still in use. Under `docker run --init`, the lock (fd 9) frees only when the
# CLI exits.

if [ "${SQUAD_LOCK:-}" = "1" ]; then
  # A missing lock is a broken plan, not a busy account, so it must not exit 75.
  if [ ! -r /squad/lock ]; then
    echo "squad-entry: SQUAD_LOCK=1 but /squad/lock is not mounted" >&2
    exit 70
  fi
  exec 9</squad/lock
  # flock exits 75 on a busy lock. Any other failure keeps its own code.
  flock -n -E 75 9
  rc=$?
  [ "$rc" -eq 0 ] || exit "$rc"
fi

if [ -n "${SQUAD_TOKEN_FILE:-}" ]; then
  # A token given with `docker run -e` shows in `docker inspect`. A read-only file does not.
  CLAUDE_CODE_OAUTH_TOKEN=$(cat "$SQUAD_TOKEN_FILE") || exit 70
  export CLAUDE_CODE_OAUTH_TOKEN
  unset SQUAD_TOKEN_FILE
fi

# exec keeps fd 9 open, so the lock lives as long as the CLI.
exec "$@"
