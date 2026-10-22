import { describe, expect, it } from 'vite-plus/test'
import { notificationListSchema } from '@/validators/notification.validators'

/**
 * The notification list query: the shared params with a read-state filter and one sort.
 */
describe('notificationListSchema', () => {
  it('reads unread=true as true and unread=false as false', () => {
    expect(notificationListSchema.parse({ unread: 'true' }).filters.unread).toBe(true)
    expect(notificationListSchema.parse({ unread: 'false' }).filters.unread).toBe(false)
  })

  it('leaves unread out when none is sent', () => {
    expect(notificationListSchema.parse({}).filters.unread).toBeUndefined()
  })

  it('refuses an unread value that is not true or false', () => {
    expect(notificationListSchema.safeParse({ unread: 'maybe' }).success).toBe(false)
  })

  it('sorts newest first by default, and refuses any other sort', () => {
    expect(notificationListSchema.parse({}).params.sort).toBe('-created')
    expect(notificationListSchema.safeParse({ sort: 'created' }).success).toBe(false)
  })

  it('caps the page size at 100', () => {
    expect(notificationListSchema.parse({ limit: '100' }).params.limit).toBe(100)
    expect(notificationListSchema.safeParse({ limit: '101' }).success).toBe(false)
  })
})
