#!/usr/bin/env sh
# The pre-push gate: mirrors CI's `lint` and `test` jobs, minus the audits.
# Stops at the first failing step. The service check runs first, so a stopped
# Docker stack fails in about 2 s, before any lint.
set -eu

step() {
  printf '\n▸ %s\n' "$1"
}

step 'Test services'
node scripts/check-test-services.mjs

step 'Lint'
pnpm lint

step 'Docs lint'
pnpm lint:docs

step 'Unused code (knip)'
pnpm knip

step 'Domain terms'
sh scripts/check-domain-terms.sh

step 'Tests with coverage gate'
pnpm test:coverage

step 'Build'
pnpm build

step '.env.example is current'
pnpm env:example
git diff --exit-code .env.example
