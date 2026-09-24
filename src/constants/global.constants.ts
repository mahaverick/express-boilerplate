// src/constants/global.constants.ts
//
// Deliberately not a mirror of getEnv() — that would create two sources of
// truth for the same values. This file holds literal constants that have no
// environment-variable equivalent: values a controller reaches for by name
// instead of retyping a magic number.

/**
 * Time budget graceful shutdown gives in-flight work before the process is force-exited.
 *
 * Under Kubernetes' default 30s `terminationGracePeriodSeconds`, so the
 * orchestrator's SIGKILL is never what ends the process. Worker close waits
 * for in-flight jobs.
 */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 25_000

/**
 * How long `gracefulShutdown` waits for open HTTP connections to finish before force-closing them.
 */
export const SERVER_DRAIN_TIMEOUT_MS = 5000
