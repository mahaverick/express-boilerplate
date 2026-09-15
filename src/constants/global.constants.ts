// src/constants/global.constants.ts
//
// Deliberately not a mirror of getEnv() — that would create two sources of
// truth for the same values. This file holds literal constants that have no
// environment-variable equivalent: values a controller reaches for by name
// instead of retyping a magic number.

/**
 * Time budget graceful shutdown gives in-flight work to finish before the
 * process is force-killed.
 *
 * Kubernetes' own default `terminationGracePeriodSeconds` is 30s, so 10s
 * backstop leaves comfortable margin for the orchestrator's own SIGKILL to
 * never be the thing that ends the process.
 */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000
