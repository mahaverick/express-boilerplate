/**
 * @file Literal constants with no environment variable behind them. Values
 * that come from the environment are read through `getEnv()`, never mirrored here.
 */

/**
 * How long `gracefulShutdown` waits for open HTTP connections to finish before force-closing them.
 */
export const SERVER_DRAIN_TIMEOUT_MS = 5000
