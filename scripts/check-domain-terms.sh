#!/usr/bin/env sh
# Fails on any term from .github/domain-terms.txt (one extended regex per
# line) in any tracked file except that one. Scanning `git ls-files` covers
# every committed file, whatever its extension, and never walks node_modules,
# dist or coverage.
#
# A term that also reads as ordinary English needs an anchor: a compound
# suffix (`term[-_]`) or a word boundary (`\bterm\b`). Before adding one,
# write an ordinary sentence using the bare word and confirm the gate does not
# trip on it.
set -eu

terms=.github/domain-terms.txt
# A blank line in the terms file is an empty pattern, which matches
# every line of every file — the gate would "fail" on the whole tree
# and read as a catastrophic leak. Refuse to run instead.
if [ ! -s "$terms" ] || grep -qE '^[[:space:]]*$' "$terms"; then
  echo "::error::$terms is missing, empty, or contains a blank line"
  exit 1
fi
# `|| true` sits INSIDE the substitution so a no-match (grep exit 1)
# and a partial match across xargs batches (xargs exit 123) both
# still yield the hits grep printed. Testing the captured text, not
# the pipeline's exit code, is what stops this gate silently
# inverting into a pass once the repo outgrows a single xargs batch.
# -H forces the filename prefix even when a batch holds one file.
hits=$(git ls-files -z | grep -zv '^\.github/domain-terms\.txt$' \
         | xargs -0 grep -nHiEf "$terms" || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo "::error::Domain reference found — scrub before merging."
  exit 1
fi
