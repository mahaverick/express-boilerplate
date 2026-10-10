/**
 * @file The scrubber gate's option parser refuses what it cannot read, so a
 * typo never runs the gate on a default or on zero cases and exits 0.
 */
import { describe, expect, it } from 'vitest'
import { parseOptions } from '../../helpers/scrub-gate-options'

describe('scrub gate options', () => {
  it('reads the defaults with no arguments', () => {
    expect(parseOptions([])).toEqual({
      mode: 'corpus',
      seed: 20_261_010,
      count: 1_000_000,
      seconds: 0,
      baseline: '713112c',
      candidateSha: undefined,
      samples: 20,
      replay: undefined,
    })
  })

  it('reads every option it is given', () => {
    expect(
      parseOptions([
        'hunt',
        '--seed',
        '7',
        '--count',
        '100000000',
        '--seconds',
        '300',
        '--baseline',
        'abc1234',
        '--candidate-sha',
        'def5678',
        '--samples',
        '0',
      ])
    ).toEqual({
      mode: 'hunt',
      seed: 7,
      count: 100_000_000,
      seconds: 300,
      baseline: 'abc1234',
      candidateSha: 'def5678',
      samples: 0,
      replay: undefined,
    })
    expect(parseOptions(['replay', '--replay', 'hunt:7:11']).replay).toBe('hunt:7:11')
  })

  it.each(['1,000', '0', '-5', '1e5', '1.5', 'NaN', 'Infinity', ''])(
    'refuses --count %j',
    (count) => {
      expect(() => parseOptions(['corpus', '--count', count])).toThrow(/--count/)
    }
  )

  it.each([
    ['--seed', '0'],
    ['--seed', 'x'],
    ['--seconds', '0'],
    ['--seconds', '-1'],
    ['--samples', '-1'],
  ])('refuses %s %j', (flag, value) => {
    expect(() => parseOptions(['hunt', flag, value])).toThrow(flag)
  })

  it('refuses a flag with no value', () => {
    expect(() => parseOptions(['corpus', '--baseline'])).toThrow('--baseline needs a value')
    expect(() => parseOptions(['corpus', '--baseline', '--count', '5'])).toThrow(
      '--baseline needs a value'
    )
  })

  it('refuses an unknown mode, an unknown or repeated flag', () => {
    expect(() => parseOptions(['corpsu'])).toThrow('unknown mode')
    expect(() => parseOptions(['--count', '5'])).toThrow('unknown mode')
    expect(() => parseOptions(['corpus', '--cout', '5'])).toThrow('unknown option')
    expect(() => parseOptions(['corpus', '--count', '5', '--count', '6'])).toThrow('more than once')
  })

  it('refuses replay without a well-formed --replay, and --replay in another mode', () => {
    expect(() => parseOptions(['replay'])).toThrow('--replay')
    expect(() => parseOptions(['replay', '--replay', 'corpus:7'])).toThrow('--replay')
    expect(() => parseOptions(['corpus', '--replay', 'corpus:7:11'])).toThrow('--replay')
  })
})
