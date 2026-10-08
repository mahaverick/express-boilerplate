/**
 * @file Which lines of an error's stack are V8 frames. A stack starts with
 * the error's message, and a message line can start with an indented `at `
 * too; such a line is message text, never a frame. Where a frame line is
 * scrubbed on its own (an error event, Slack) it would lose the key in
 * front of it, and where only frames are kept and the message is dropped
 * (a redacted query or mail error in a log) it would survive whole.
 */

/**
 * The start of a V8 frame line: indentation, then `at ` and a character.
 */
const FRAME_START_PATTERN = /^[ \t]+at \S/

/**
 * The end of a V8 frame line: a `file:line:column` position, bare or closing
 * a `(…)` after the function name, or a `(native)`, `(<anonymous>)` or
 * `(index N)` location (`at async Promise.all (index 0)`). A trailing `\r`
 * of a CRLF stack is allowed.
 */
const FRAME_END_PATTERN = /(?::\d+:\d+\)?|\((?:native|<anonymous>|index \d+)\))\r?$/

/**
 * Whether a stack line has the shape V8 gives a frame:
 * `    at fn (/app/x.ts:1:2)`, `    at /app/x.ts:1:2`, `    at async fn (…)`,
 * `    at new Foo (…)`, `    at Array.map (<anonymous>)`. A line such as
 * `    at zqleak7731` or `  at least one retry` is not one.
 * @param line - One line of a stack.
 * @returns True for a frame line.
 */
export function isStackFrameLine(line: string): boolean {
  return FRAME_START_PATTERN.test(line) && FRAME_END_PATTERN.test(line)
}

/**
 * The index of the stack line the message ends on, when the message starts
 * on the first line; -1 otherwise.
 * @param lines - The stack, split on `\n`.
 * @param message - The error's message, when known.
 * @returns The line index, or -1.
 */
function lastMessageLineOf(lines: string[], message: string | undefined): number {
  if (message === undefined || message === '') return -1
  const stack = lines.join('\n')
  const messageAt = stack.indexOf(message)
  if (messageAt === -1 || messageAt > (lines[0]?.length ?? 0)) return -1
  return stack.slice(0, messageAt + message.length).split('\n').length - 1
}

/**
 * The indexes of a stack's frame lines. When the message is found starting
 * on the stack's first line, as V8 writes it (`Error: <message>`), every
 * line it spans is message text, so a frame-shaped line inside the message
 * is never taken for a frame; otherwise every line is tested on its own.
 * @param lines - The stack, split on `\n`.
 * @param message - The error's message, when known.
 * @returns The indexes, in order.
 */
export function frameLineIndexesOf(lines: string[], message: string | undefined): number[] {
  const lastMessageLine = lastMessageLineOf(lines, message)
  const indexes: number[] = []
  for (const [index, line] of lines.entries()) {
    if (index > lastMessageLine && isStackFrameLine(line)) indexes.push(index)
  }
  return indexes
}

/**
 * A stack's frame lines (`frameLineIndexesOf`), in order, without the
 * message lines it starts with.
 * @param stack - The stack.
 * @param message - The error's message, when known.
 * @returns The frame lines, possibly none.
 */
export function stackFrameLinesOf(stack: string, message: string | undefined): string[] {
  const lines = stack.split('\n')
  return frameLineIndexesOf(lines, message).map((index) => lines[index] ?? '')
}
