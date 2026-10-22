#!/usr/bin/env sh
# Runs the full lint and test gate, then pushes without the pre-push hook.
# A long pre-push hook can outlast the SSH connection and drop the push, and
# git push then reports a misleading exit code, so the gate runs before git
# push opens the connection. Arguments go to git push.
set -eu

if ! sh scripts/pre-push-gate.sh; then
  echo 'Gate failed: fix the errors above, then run pnpm push again.' >&2
  exit 1
fi

exec git push --no-verify "$@"
