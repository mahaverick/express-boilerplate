# TypeScript 7 toolchain spike — Task 0

Date: 2026-09-14
Plan: `docs/superpowers/plans/2026-09-14-backend-foundation.md`, Task 0 (gate)
Probe: `/tmp/ts7-spike` (self-contained, deleted after this spike, never committed)
Full command transcript: `.superpowers/sdd/2026-09-14-backend-foundation/task-0-report.md`

## Verdict: NO-GO

Pin `typescript: ~6.0.3` in every later task instead of the `7.0.2` in Global
Constraints. There is exactly **one** hard blocker, and it sits entirely
outside TypeScript itself.

### The blocker — `typescript-eslint@8.70.0`'s peer range excludes TS 7.x entirely

```
$ npm view typescript-eslint@8.70.0 peerDependencies
{
  eslint: '^8.57.0 || ^9.0.0 || ^10.0.0',
  typescript: '>=4.8.4 <6.1.0'
}
```

Confirmed independently inside the probe via `pnpm peers check` (unmet peer
`typescript`, wanted `>=4.8.4 <6.1.0`, installed `7.0.2`). Also checked the
`latest` (`8.70.0`, same package) and `canary` dist-tags
(`8.70.1-alpha.0`, npm's bleeding edge as of 2026-09-14) — identical range on
both. No released or pre-release build of typescript-eslint currently
supports TS 7. Since `pnpm lint` depends on typescript-eslint's TS-aware
rules, this alone is sufficient for NO-GO regardless of anything else.

### Not a blocker, but a required tsconfig migration

The Task 0 Step 2 tsconfig, used byte-identical, fails to compile under TS
7.0.2:

```
tsconfig.json(13,5): error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
  Use '"paths": {"*": ["./*"]}' instead.
tsconfig.json(14,24): error TS5090: Non-relative paths are not allowed. Did you forget a leading './'?
```

This looks like a second blocker and was initially written up as one, but
it isn't: the compiler names the exact fix in its own error text. I verified
it end to end — with `baseUrl` removed and `paths` changed to
`{ "@/*": ["./src/*"] }` (the only two-line change TS7 asks for), on
`typescript@7.0.2`:

- `tsc --noEmit` → 0
- `tsc` (emit) → 0
- `tsc-alias --resolve-full-paths` → 0, and it correctly rewrote the emitted
  `import { greet } from '@/a.js'` to `import { greet } from './a.js'` —
  this directly answers Task 0's own "the one to watch is tsc-alias, which
  ... depends on the emit shape": **it does not choke on TS7's emit shape.**
- `node dist/index.js` → 0, printed `hi x`

So under TS 7.0.2, with that config migration, the full
`tsc → tsc-alias → node` pipeline genuinely works. **If typescript-eslint
ever ships a peer range that includes `^7.0.0`, TypeScript 7 itself is not
the obstacle** — applying this two-line tsconfig change is the only other
step needed before re-running this spike to confirm GO.

## Commands run against the byte-identical Task 0 Step 2 tsconfig (typescript@7.0.2)

| Command                          | Exit                  | Notes                                                         |
| -------------------------------- | --------------------- | ------------------------------------------------------------- |
| `tsc --noEmit`                   | 1                     | `TS5102` (baseUrl removed) + `TS5090` (non-relative paths)    |
| `tsc` (emit)                     | 1                     | same errors, no `dist/` produced                              |
| `tsc-alias --resolve-full-paths` | 0                     | vacuous — no `dist/` existed, nothing to alias                |
| `node dist/index.js`             | 1                     | `MODULE_NOT_FOUND`, `dist/` never created                     |
| `npx tsx src/index.ts`           | 0, printed `hi x`     | bypasses `tsc` entirely (esbuild), doesn't test the blocker   |
| `npx eslint --version`           | 0, printed `v10.10.0` | version-agnostic, doesn't exercise typescript-eslint's parser |

Full verbatim output for every command, plus the migrated-tsconfig
confirmation run, is in
`.superpowers/sdd/2026-09-14-backend-foundation/task-0-report.md`.

## Sanity check: does the recommended `~6.0.3` pin work end to end?

Yes, confirmed in the same probe, with adjustments worth carrying into
Task 1 rather than rediscovering there:

1. The unmodified Step 2 tsconfig also errors under `6.0.3` by default —
   `TS5101: Option 'baseUrl' is deprecated and will stop functioning in
TypeScript 7.0` — because 6.0 already treats this deprecation as an
   error, not a warning. Needs `"ignoreDeprecations": "6.0"` to compile as
   specified. (Migrating to the `./src/*` form instead, as above, also
   avoids this and is the better long-term choice since it's what TS7 will
   require anyway.)
2. `src/index.ts` importing `'@/a'` with no extension fails resolution
   (`TS2307`) under `moduleResolution: NodeNext` + `"type": "module"` in
   `package.json` — Node ESM resolution doesn't do extension-less lookups.
   Reproduces identically on 6.0.3 and 7.0.2; it's a gap in the probe's own
   source, not a TS-version difference. **Every internal import in the real
   boilerplate needs an explicit `.js` extension** (`'@/a.js'`) — standard
   NodeNext/ESM convention, worth stating up front in Task 1 so it isn't
   rediscovered as a mystery `TS2307`.
3. `@types/node` needs to be an explicit devDependency, and on this pnpm
   virtual-store layout also needed `"types": ["node"]` set explicitly in
   tsconfig — automatic `@types/*` inclusion did not pick it up implicitly
   for `console`/Node globals in this probe. One-probe observation, not
   hardened further — worth a heads-up for Task 1, not a hard rule.

With those in place: `tsc --noEmit` → 0, `tsc` (emit) → 0, `tsc-alias` → 0
(correct rewrite), `node dist/index.js` → 0, printed `hi x`.
`typescript-eslint@8.70.0`'s peer range (`>=4.8.4 <6.1.0`) accepts `6.0.3`
cleanly, resolving the peer-dependency failure too.

## Recommended `MIGRATIONS.md` row (for whichever task writes that file)

> **TypeScript 6→7 — not yet adopted.** Global Constraints call for
> `typescript: 7.0.2`, but Task 0's spike (2026-09-14,
> `docs/superpowers/notes/2026-09-14-typescript-7-spike.md`) found one hard
> blocker: `typescript-eslint@8.70.0`'s peer range is
> `typescript: '>=4.8.4 <6.1.0'`, excluding all of 7.x (confirmed on `latest`
> and the `canary` prerelease `8.70.1-alpha.0` too). TypeScript 7.0.2 itself
> is not the problem — its removal of `baseUrl` (`TS5102`) and requirement
> that `paths` values be relative (`TS5090`) is a two-line tsconfig fix
> (`paths: { "@/*": ["./src/*"] }`, no `baseUrl`), verified working end to
> end including `tsc-alias` against TS7's emit shape. Pinned to
> `typescript: ~6.0.3` instead (with `"ignoreDeprecations": "6.0"` in
> tsconfig, or migrate to the `./src/*` paths form directly). **Unblocks
> when:** typescript-eslint ships a release whose peer range includes
> `^7.0.0` — at that point apply the two-line tsconfig migration above and
> re-run this spike to confirm GO; no other changes are expected to be
> needed.

## Scope note

This spike used the commands specified in Task 0's brief, plus two small,
clearly-separated follow-up checks: (1) whether the recommended `~6.0.3` pin
actually works end to end, and (2) whether the `baseUrl`/`paths` tsconfig
error is a real second blocker or just a migration — both run because the
brief's own Step 3 note flags `tsc-alias` against the emit shape as "the one
to watch," and leaving that untested would have been an incomplete answer to
the gate. Full verbatim transcript:
`.superpowers/sdd/2026-09-14-backend-foundation/task-0-report.md`. The probe
at `/tmp/ts7-spike` was deleted after this spike and nothing from it is
committed.
