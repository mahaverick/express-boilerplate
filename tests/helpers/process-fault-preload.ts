/**
 * @file Preloaded with `--import` into a child running `src/index.ts`
 * (tests/integration/process-fault.test.ts): once boot has installed its
 * `uncaughtException` listener, throw an uncaught error whose message
 * carries the process's `Error.stackTraceLimit`, so the test can read the
 * limit boot set from the event the child reports.
 */
const poll = setInterval(() => {
  if (process.listenerCount('uncaughtException') === 0) return
  clearInterval(poll)
  // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties -- V8's stack depth, the value under test
  throw new Error(`child process fault, stack limit ${String(Error.stackTraceLimit)}`)
}, 20)
