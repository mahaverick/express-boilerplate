/**
 * @file Test cleanup for the flag keys this worker's Redis prefix holds.
 */
import { getRedis, redisKey } from '@/services/redis.service'

/**
 * Delete the stored flag snapshot, every flags counter and every exposure
 * dedupe key (`flags:exp:*`) under this worker's key prefix.
 * @returns Resolves once deleted.
 */
export async function clearFlagKeys(): Promise<void> {
  const redis = await getRedis()
  const keys: string[] = []
  const batches = redis.scanIterator({ MATCH: redisKey('flags', '*') })
  for await (const batch of batches) {
    keys.push(...batch)
  }
  if (keys.length > 0) await redis.del(keys)
}
