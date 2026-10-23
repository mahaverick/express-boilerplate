# CI performance

Timing record for the Vite+ migration and the test-speed work. The first table is CI, then local, then method and findings.

## Summary

CI wall-clock fell from a 305.5 s median to 154.5 s, a 49% cut. Sharding the tests into four parallel jobs did it. PR 1 (Vite+ lint and format) did not move wall-clock, because `lint` ran beside `test` and `test` set the time.

## CI

Wall-clock is `run_started_at` to `updated_at` of one workflow run.

| Metric           | Before (20 runs on main) | After PR 1 (10 attempts) | After PR 2 (10 attempts) |
| :--------------- | -----------------------: | -----------------------: | -----------------------: |
| Median wall time |                  305.5 s |                    310 s |                  154.5 s |
| p90              |                    329 s |                    323 s |                    162 s |
| Range            |                229-334 s |                231-338 s |                147-163 s |

Per job, median (min-max):

| Job                              |            Before |        After PR 1 |               After PR 2 |
| :------------------------------- | ----------------: | ----------------: | -----------------------: |
| `lint`                           | 108-168 s (range) |    54.5 s (42-61) |           51.5 s (41-61) |
| `test` (single job)              |               n/a | 305.5 s (226-333) |                      n/a |
| `test-shard (n)`, slowest of 4   |               n/a |               n/a |          118 s (105-125) |
| `test-shard (n)`, all 40 jobs    |               n/a |               n/a |           108 s (93-125) |
| `test` (merge and coverage gate) |               n/a |               n/a |           32.5 s (27-36) |
| `docker`                         |      not recorded |    47.5 s (41-67) | 31 s (23-38), warm cache |

The critical path is now the slowest shard plus the merge job: 118 s + 32.5 s, about 151 s, plus queue time.

The `docker` figure is warm. The first run on a head writes the layer cache and takes longer (78 s for the build step, against 14 s warm). The `docker` job is off the critical path, so this does not move wall-clock.

## Local

Apple silicon laptop, 10 cores. `hyperfine --warmup 1 --runs 3`, mean ± σ. PR 2 changes CI only, so the per-step figures are the ones from PR 1.

| Step                                   |           Before |                                After PR 1 |
| :------------------------------------- | ---------------: | ----------------------------------------: |
| Lint, format (ESLint typed + Prettier) |           73.1 s | 9.1 s (`vp check` 2.30 s + ESLint 6.84 s) |
| Typecheck                              |  8.32 s ± 0.03 s |                           8.14 s ± 0.04 s |
| Unit tests                             | 16.45 s ± 0.32 s |                          14.43 s ± 0.12 s |
| Build                                  |  4.43 s ± 0.01 s |                           4.24 s ± 0.01 s |
| Pre-commit hook, one staged file       |     not measured |                           4.97 s ± 0.25 s |
| Pre-push, no integration (old hook)    | 93.90 s ± 5.34 s |                                       n/a |
| `pnpm gate`, with integration          |              n/a |              103.8 s (load 10.3 at start) |

On PR 2's head, one `pnpm gate` run took 136 s (exit 0, 608 s user CPU). The load average was 2.4 at the start and 10.4 at the end. The earlier 103.8 s run started at a higher load but ran faster, so the laptop's other work swings this figure by 30% or more. Read the gate as 100-140 s. The gate runs the suite in one process; sharding applies to CI only.

## Method

- **CI before:** median and p90 of the last 20 successful `pull_request` runs of `ci.yml` on main (f0d804af, v8.0.1), 2026-10-21.
- **CI after PR 1:** run 39845569908, attempt 1 plus 10 reruns, 10 successes.
- **CI after PR 2:** run 39860848023 on head `cede1686`. Attempt 1 wrote the Docker cache and attempt 2 reran `docker` alone. Attempts 3-12 are 10 full sequential reruns (`gh run rerun`, then `gh run watch --exit-status`), and all 10 passed. Stats cover those 10. p90 is the nearest-rank value (the 9th of 10). The commit that adds this file changes no workflow, so timings carry over.
- **Local:** `hyperfine --warmup 1 --runs 3` and `time pnpm gate`, with the user's compose stack up (Postgres 5433, Redis 6380).
- **Load:** the laptop carries load from other apps (2-4 idle, 10+ under test). Treat local figures as indicative.

## Findings

- **Four shards, four workers each.** At three shards and 3 runs each, 8 workers per shard gave a slowest shard of 130-148 s and 4 workers gave 129-140 s. Four shards at four workers gave 115-118 s. Each shard adds about 45 s of setup (checkout, install, migrations), so a fifth shard gains little.
- **Coverage is enforced on the merge.** Each shard writes a blob and applies no threshold. The `test` job merges the blobs and applies the 80% thresholds from `vite.config.ts` to the whole suite. Two proofs show both gates work: with the threshold temporarily at 99% lines the merged run failed ([run 39859048128](https://github.com/mahaverick/express-boilerplate/actions/runs/39859048128): lines 98.29%), and a deliberately failing shard failed `test` ([run 39859534908](https://github.com/mahaverick/express-boilerplate/actions/runs/39859534908)).
- **Test isolation stays on.** In the spike, `--no-isolate` broke 46 unit tests (module-level `vi.mock` state) and saved nothing (41 s against 43 s). CI time is set by the integration suite under coverage, so sharding is the lever.
- **Docker layer cache.** The cache cut the build step from 78 s (cold) to 14 s (warm).

## Try next

- Balance the shards by timing: the slowest shard (125 s) is about 30 s over the fastest (93 s).
- Cache the per-shard setup (install, migrations); it is about 45 s of each shard's 108 s.
- Run `docker` after `lint` only on branches that change the image inputs.
