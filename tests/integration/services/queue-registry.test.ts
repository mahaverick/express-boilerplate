/**
 * @file `getAllQueues()` is every queue queue.service.ts creates: its names
 * equal the names in every `new Queue('…'` of the module's source, so a
 * queue added without joining the registry (and so never paused by
 * maintenance mode) fails here.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { closeQueue, getAllQueues } from '@/services/queue.service'

const byText = (a: string, b: string): number => a.localeCompare(b)

afterAll(async () => {
  await closeQueue()
})

describe('queue registry', () => {
  it('holds every queue queue.service.ts creates', () => {
    const source = readFileSync(path.resolve('src/services/queue.service.ts'), 'utf8')
    const created = Array.from(
      source.matchAll(/new Queue\(\s*'([^']+)'/g),
      (match) => match[1] ?? ''
    )
    const registered = getAllQueues().map((queue) => queue.name)

    expect(created.length).toBeGreaterThan(0)
    expect(registered.toSorted(byText)).toEqual(created.toSorted(byText))
  })
})
