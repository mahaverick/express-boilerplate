/**
 * @file Which stack lines count as V8 frames: every line of a real stack
 * does, and a message line that merely starts with an indented `at ` does
 * not, nor does a frame-shaped line inside the message.
 */
import { describe, expect, it } from 'vitest'
import { frameLineIndexesOf, isStackFrameLine } from '@/errors/stack-frames'

/**
 * Throw from inside `Promise.all`, so the stack has `async` and
 * `(index N)` frames, and return the stack.
 * @returns The caught error's stack.
 */
async function asyncStack(): Promise<string> {
  try {
    await Promise.all([
      Promise.resolve(),
      (async (): Promise<void> => {
        await Promise.resolve()
        throw new Error('inner')
      })(),
    ])
  } catch (error) {
    return (error as Error).stack ?? ''
  }
  return ''
}

describe('isStackFrameLine', () => {
  it.each([
    '    at handle (/app/src/services/auth.service.ts:10:5)',
    '    at /app/src/index.ts:3:1',
    '    at async Promise.all (index 0)',
    '    at async handle (/app/src/x.ts:1:2)',
    '    at new Worker (/app/node_modules/bullmq/dist/worker.js:88:12)',
    '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
    '    at Array.map (<anonymous>)',
    '    at Object.<anonymous> (file:///app/src/x.mjs:4:9)',
    '    at eval (eval at <anonymous> (/app/x.js:1:1), <anonymous>:1:1)',
    '    at f (native)',
    '    at handle (/app/src/x.ts:10:5)\r',
  ])('accepts %j', (line) => {
    expect(isStackFrameLine(line)).toBe(true)
  })

  it.each([
    '    at zqleak7731',
    '  at least one retry',
    '    at Bearer zqleak7731',
    'at handle (/app/src/x.ts:10:5)',
    'Error: boom',
    '',
  ])('rejects %j', (line) => {
    expect(isStackFrameLine(line)).toBe(false)
  })

  it('accepts every frame line of a real stack, async frames included', async () => {
    const stack = await asyncStack()
    const [head, ...frames] = stack.split('\n')
    expect(head).toBe('Error: inner')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.filter((line) => !isStackFrameLine(line))).toEqual([])
  })
})

describe('frameLineIndexesOf', () => {
  it('skips a frame-shaped line inside the message', () => {
    const message = 'token rejected:\n    at zqleak7731 (/app/x.ts:1:1)'
    const lines = `Error: ${message}\n    at handle (/app/src/x.ts:10:5)`.split('\n')
    expect(frameLineIndexesOf(lines, message)).toEqual([2])
  })

  it('takes every frame line when the stack does not start with the message', () => {
    const lines = ['Error: other', '    at handle (/app/src/x.ts:10:5)']
    expect(frameLineIndexesOf(lines, 'not in the stack')).toEqual([1])
  })

  it('takes every frame line when there is no message', () => {
    const lines = ['Error', '    at handle (/app/src/x.ts:10:5)', '    at zqleak7731']
    expect(frameLineIndexesOf(lines, undefined)).toEqual([1])
  })
})
