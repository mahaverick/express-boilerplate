/**
 * @file The session clients tests issue refresh tokens for. A browser
 * sign-in is the default in every test that does not test the client.
 */
import type { SessionClient } from '@/services/session.service'

/**
 * A browser, which names no device.
 */
export const WEB_CLIENT: SessionClient = { kind: 'web', deviceName: null }
