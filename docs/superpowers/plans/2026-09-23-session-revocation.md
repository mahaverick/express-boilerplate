# Session Revocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make logging out kill outstanding access tokens immediately, instead of leaving them valid for up to `ACCESS_TOKEN_TTL` (15 minutes), and close an open SSE stream when its session ends.

**Architecture:** The access token gains `sid` (session) and `jti` (token id). A Redis denylist keyed by session, TTL'd to the access-token lifetime, is written from `revokeAllForSession` — the single choke point that logout, password change and refresh-token reuse detection all already pass through. **Two** consumers read it: `requireAuth` for ordinary requests and the SSE heartbeat for already-open streams.

**Tech Stack:** Express 5, `jsonwebtoken` (HS256), node-redis via `src/services/redis.service.ts`, Drizzle, Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-sse-auth-and-multi-frontend-design.md` §3

## Global Constraints

- **`revokeAllForSession` is the only write point.** Do not sprinkle denylist writes at call sites; logout, password change and reuse detection already funnel through it, and adding them elsewhere guarantees one gets missed.
- **Two read points, not one.** `requireAuth` runs once per request and therefore once per stream, at connect. An open stream is closed only by the heartbeat check.
- **The denylist is best-effort.** The database stays the source of truth for the refresh side. If Redis is unavailable the request is **allowed**, with a logged warning — failing closed would take the whole API down on a Redis blip, which is worse than the 15-minute window this closes.
- **A token with no `sid` is accepted until it expires**, for one release only. Tokens minted before deploy have no session claim and there is nothing to check them against.
- `ACCESS_TOKEN_TTL=15m` is the denylist TTL. An entry only has to outlive the tokens it invalidates.
- Gate is 0 errors and 0 warnings: `pnpm exec eslint . --max-warnings 0 && pnpm lint && pnpm test`.
  **No `pnpm typecheck` exists in this repo** — `pnpm lint` already runs `tsc -p tsconfig.typecheck.json --noEmit`.

---

## File Structure

| File                                                    | Responsibility                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/utilities/token.utilities.ts`                      | `signAccessToken` gains `sessionId`; payload gains `sid` + `jti`; `verifyAccessToken` returns them |
| `src/controllers/auth.controller.ts:474,525`            | Pass the session id at both signing sites                                                          |
| `src/services/session-denylist.service.ts`              | **New.** `denySession()` / `isSessionDenied()` — the only module that knows the Redis key shape    |
| `src/repositories/user-token.repository.ts:120`         | `revokeAllForSession` also denies the session                                                      |
| `src/middlewares/auth.middleware.ts`                    | `requireAuth` rejects a denied session                                                             |
| `src/controllers/notification-stream.controller.ts:276` | The heartbeat closes a stream whose session is denied                                              |

---

### Task 1: Put the session in the access token

**Files:**

- Modify: `src/utilities/token.utilities.ts:50-52` (`AccessTokenPayload`), `:160-167` (`signAccessToken`), `:204-214` (`verifyAccessToken`)
- Modify: `src/controllers/auth.controller.ts:474`, `:525`
- Test: `tests/unit/utilities/token.utilities.test.ts`

**Interfaces:**

- Produces: `AccessTokenPayload = { sub: string; sid?: string; jti?: string }` and `signAccessToken(user: User, sessionId: string): string`. Tasks 4 and 5 read `payload.sid`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/utilities/token.utilities.test.ts`:

```ts
it('carries the session id and a unique token id', () => {
  const user = { id: 'user-1' } as User
  const token = signAccessToken(user, 'session-abc')

  const verified = verifyAccessToken(token)
  expect(verified.ok).toBe(true)
  if (!verified.ok) throw new Error('unreachable')
  expect(verified.payload.sub).toBe('user-1')
  expect(verified.payload.sid).toBe('session-abc')
  expect(verified.payload.jti).toEqual(expect.any(String))
})

it('gives two tokens for one session different jtis', () => {
  const user = { id: 'user-1' } as User
  const first = verifyAccessToken(signAccessToken(user, 'session-abc'))
  const second = verifyAccessToken(signAccessToken(user, 'session-abc'))
  if (!first.ok || !second.ok) throw new Error('unreachable')
  expect(first.payload.jti).not.toBe(second.payload.jti)
})

it('still verifies a token minted before sid existed, so a deploy does not sign everyone out', () => {
  // One release of tolerance. `sid` is optional precisely so tokens issued
  // by the previous version keep working until they expire.
  const legacy = jwt.sign({ sub: 'user-1' }, getEnv().JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: 900,
  })
  const verified = verifyAccessToken(legacy)
  expect(verified.ok).toBe(true)
  if (!verified.ok) throw new Error('unreachable')
  expect(verified.payload.sid).toBeUndefined()
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run tests/unit/utilities/token.utilities.test.ts
```

Expected: FAIL — `signAccessToken` takes one argument.

- [ ] **Step 3: Widen the payload**

Replace `AccessTokenPayload` (`:50-52`):

```ts
export interface AccessTokenPayload {
  sub: string
  /**
   * The session this token belongs to. Optional ONLY so that tokens minted
   * before this claim existed keep verifying for one release; a token
   * without it cannot be revoked and is accepted until it expires.
   */
  sid?: string
  /** This token's own id. Not checked — it exists so a token accepted after
   * a Redis flush can be identified in logs. */
  jti?: string
}
```

- [ ] **Step 4: Sign the new claims**

Replace `signAccessToken` (`:160-167`):

```ts
export function signAccessToken(user: User, sessionId: string): string {
  const env = getEnv()
  const payload: AccessTokenPayload = { sub: user.id, sid: sessionId, jti: randomUUID() }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: Math.floor(requireDurationMs(env.ACCESS_TOKEN_TTL) / MS_PER_SECOND),
  })
}
```

Add `import { randomUUID } from 'node:crypto'` if it is not already imported.

- [ ] **Step 5: Return the new claims**

In `verifyAccessToken` (`:210`), replace the success return:

```ts
return {
  ok: true,
  payload: {
    sub: decoded.sub,
    sid: typeof decoded.sid === 'string' ? decoded.sid : undefined,
    jti: typeof decoded.jti === 'string' ? decoded.jti : undefined,
  },
}
```

- [ ] **Step 6: Pass the session at both signing sites**

`src/controllers/auth.controller.ts:474` — the session id is declared on the line above:

```ts
const accessToken = signAccessToken(user, sessionId)
```

`:525` — the rotated refresh token carries it (`IssuedRefreshToken.sessionId`):

```ts
successResponse(
  response,
  { accessToken: signAccessToken(user, rotated.sessionId) },
  'Token refreshed.'
)
```

There is no third site: the Google callback sets only the refresh cookie and redirects, and the SPA then refreshes.

- [ ] **Step 7: Run the tests and watch them pass**

```bash
pnpm exec vitest run tests/unit/utilities/token.utilities.test.ts && pnpm test
```

Expected: PASS. The whole suite matters here — every auth test signs tokens.

- [ ] **Step 8: Commit**

```bash
git add src/utilities/token.utilities.ts src/controllers/auth.controller.ts tests/unit/utilities/token.utilities.test.ts
git commit -m "feat: carry the session id in the access token"
```

---

### Task 2: The denylist service

**Files:**

- Create: `src/services/session-denylist.service.ts`
- Create: `tests/unit/services/session-denylist.service.test.ts`

**Interfaces:**

- Consumes: `getRedis()` from `@/services/redis.service`, `getEnv()`.
- Produces: `denySession(sessionId: string): Promise<void>` and `isSessionDenied(sessionId: string): Promise<boolean>`. Tasks 3, 4 and 5 use both.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/session-denylist.service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redis = { set: vi.fn(), exists: vi.fn() }

vi.mock('@/services/redis.service', () => ({ getRedis: async () => redis }))
vi.mock('@/services/logger.service', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('session denylist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis.set.mockResolvedValue('OK')
    redis.exists.mockResolvedValue(0)
  })

  it('denies a session with a TTL, so the entry dies when the tokens do', async () => {
    const { denySession } = await import('@/services/session-denylist.service')
    await denySession('session-abc')

    expect(redis.set).toHaveBeenCalledWith(
      'denylist:session:session-abc',
      '1',
      expect.objectContaining({ EX: expect.any(Number) })
    )
    const options = redis.set.mock.calls[0][2] as { EX: number }
    expect(options.EX).toBeGreaterThan(0)
  })

  it('reports a denied session', async () => {
    redis.exists.mockResolvedValue(1)
    const { isSessionDenied } = await import('@/services/session-denylist.service')
    expect(await isSessionDenied('session-abc')).toBe(true)
  })

  it('ALLOWS when Redis is unreachable, rather than locking everyone out', async () => {
    // Fail-open is the deliberate trade. Failing closed turns a Redis blip
    // into a total outage; failing open returns to the pre-existing 15-minute
    // window. The warning is what makes it visible.
    redis.exists.mockRejectedValue(new Error('connection refused'))
    const { isSessionDenied } = await import('@/services/session-denylist.service')
    expect(await isSessionDenied('session-abc')).toBe(false)
  })

  it('never throws out of denySession, so a Redis outage cannot fail a logout', async () => {
    redis.set.mockRejectedValue(new Error('connection refused'))
    const { denySession } = await import('@/services/session-denylist.service')
    await expect(denySession('session-abc')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run tests/unit/services/session-denylist.service.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Create `src/services/session-denylist.service.ts`:

```ts
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'
import { requireDurationMs } from '@/utilities/duration.utilities'

const MS_PER_SECOND = 1000
const KEY_PREFIX = 'denylist:session:'

/**
 * Mark a session's access tokens as no longer honoured.
 *
 * The TTL is the whole design. An entry only has to outlive the tokens it
 * invalidates, so it is set to `ACCESS_TOKEN_TTL` and expires exactly when
 * it stops mattering — which is why this needs no sweeper and cannot grow
 * without bound.
 *
 * BEST-EFFORT, and deliberately so. A Redis outage or a FLUSHALL drops every
 * entry, and there is no database fallback because the database does not
 * know a given access token exists. What this closes is the ordinary case:
 * a logout should not leave a usable credential behind for fifteen minutes.
 * @param sessionId - The session whose access tokens should stop working.
 * @returns Resolves once the entry is written, or once the failure is logged.
 */
export async function denySession(sessionId: string): Promise<void> {
  try {
    const seconds = Math.ceil(requireDurationMs(getEnv().ACCESS_TOKEN_TTL) / MS_PER_SECOND)
    const redis = await getRedis()
    await redis.set(`${KEY_PREFIX}${sessionId}`, '1', { EX: seconds })
  } catch (error) {
    // Never rethrow. This runs inside logout and password change, and a
    // Redis blip must not turn either into a 500 — the refresh token is
    // already revoked in the database by the caller, which is the half that
    // actually ends the session.
    logger.warn('Could not deny session; access tokens stay valid until they expire', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Whether a session's access tokens have been revoked.
 * @param sessionId - The session claimed by the token being checked.
 * @returns True when the token must be rejected.
 */
export async function isSessionDenied(sessionId: string): Promise<boolean> {
  try {
    const redis = await getRedis()
    return (await redis.exists(`${KEY_PREFIX}${sessionId}`)) === 1
  } catch (error) {
    // FAIL OPEN. Failing closed would make every authenticated request fail
    // whenever Redis hiccups — a far larger outage than the window this
    // exists to close. The warning is what stops that being silent.
    logger.warn('Denylist unreachable; allowing the request', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
```

If `requireDurationMs` does not live in `@/utilities/duration.utilities`, import it from wherever `token.utilities.ts` imports it.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm exec vitest run tests/unit/services/session-denylist.service.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/session-denylist.service.ts tests/unit/services/session-denylist.service.test.ts
git commit -m "feat: add the session denylist"
```

---

### Task 3: Write the denylist when a session is revoked

**Files:**

- Modify: `src/repositories/user-token.repository.ts:120` (`revokeAllForSession`)
- Test: `tests/integration/api/auth.test.ts`

**Interfaces:**

- Consumes: `denySession` from Task 2.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/api/auth.test.ts`:

```ts
it('stops honouring the access token as soon as the user logs out', async () => {
  const agent = request.agent(app)
  const login = await agent
    .post('/api/v1/auth/login')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
  const accessToken = login.body.data.accessToken as string

  // Works before.
  await agent.get('/api/v1/profile').set('Authorization', `Bearer ${accessToken}`).expect(200)

  await agent.post('/api/v1/auth/logout').expect(200)

  // The whole point: the same token, which has NOT expired, is now refused.
  await agent.get('/api/v1/profile').set('Authorization', `Bearer ${accessToken}`).expect(401)
})
```

Use whatever `TEST_EMAIL`/`TEST_PASSWORD` fixtures that file already establishes.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run tests/integration/api/auth.test.ts -t 'logs out'
```

Expected: FAIL — the second profile call returns 200, because nothing checks the session yet. This failure is the bug, reproduced.

- [ ] **Step 3: Deny the session on revoke**

In `src/repositories/user-token.repository.ts`, after the update inside `revokeAllForSession`:

```ts
// The one write point. Logout, password change and refresh-token REUSE
// DETECTION all funnel through this method already, so denying here
// covers all three — and no call site can forget.
await denySession(sessionId)
```

Add the import:

```ts
import { denySession } from '@/services/session-denylist.service'
```

- [ ] **Step 4: Run it — it should still fail**

```bash
pnpm exec vitest run tests/integration/api/auth.test.ts -t 'logs out'
```

Expected: STILL FAILS. The entry is written but nothing reads it. That is Task 4 — this step exists so the two halves are not conflated.

- [ ] **Step 5: Commit the write half**

```bash
git add src/repositories/user-token.repository.ts tests/integration/api/auth.test.ts
git commit -m "feat: deny a session's access tokens when it is revoked"
```

---

### Task 4: Reject denied sessions in requireAuth

**Files:**

- Modify: `src/middlewares/auth.middleware.ts:189-191`

**Interfaces:**

- Consumes: `isSessionDenied` (Task 2), `payload.sid` (Task 1).

- [ ] **Step 1: Make the denied token fail**

In `requireAuth`, between verifying the token and loading the user:

```ts
const token = getBearerToken(request)
const { payload } = verifyBearerToken(token)
// A token with no `sid` predates this claim; accept it until it expires.
// See the spec's "Honest limits" — one release of tolerance.
if (payload.sid && (await isSessionDenied(payload.sid))) {
  throw new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
}
request.user = await loadAuthenticatedUser(payload.sub)
```

`ACCESS_TOKEN_EXPIRED_CODE` is deliberate: to the client this is indistinguishable from expiry, and the existing interceptor already knows to try a refresh — which will correctly fail, because the refresh token was revoked in the same operation.

Add the import for `isSessionDenied`.

- [ ] **Step 2: Run the test from Task 3 and watch it pass**

```bash
pnpm exec vitest run tests/integration/api/auth.test.ts -t 'logs out'
```

Expected: PASS.

- [ ] **Step 3: Verify the whole suite**

```bash
pnpm exec eslint . --max-warnings 0 && pnpm lint && pnpm test
```

Expected: green. Watch for tests that log out and then reuse a token — any that break were asserting the old, wrong behaviour.

- [ ] **Step 4: Commit**

```bash
git add src/middlewares/auth.middleware.ts
git commit -m "feat: reject access tokens from a revoked session"
```

---

### Task 5: Close an open stream when its session ends

This is the task most easily skipped and the one the audit exists for. `requireAuth` runs **once**, at connect; nginx allows a 24-hour read timeout. Without this, a logged-out tab keeps receiving notifications until the network drops.

**Files:**

- Modify: `src/controllers/notification-stream.controller.ts:276` (the heartbeat interval)
- Test: `tests/integration/api/notification-stream.test.ts`

**Interfaces:**

- Consumes: `isSessionDenied` (Task 2). Needs the `sid` captured at connect.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/api/notification-stream.test.ts`, following that file's existing raw-socket helper rather than supertest:

```ts
it('closes an open stream once its session is revoked', async () => {
  const { stream, sessionId } = await openStreamForNewSession()

  // Alive first, or the assertion below proves nothing.
  await expect(stream.nextFrame()).resolves.toBeDefined()

  await userTokenRepository.revokeAllForSession(sessionId)

  // Within one heartbeat, not immediately: the check rides the existing
  // interval rather than adding a second timer.
  await expect(stream.closed(getEnv().SSE_HEARTBEAT_INTERVAL_MS * 2)).resolves.toBe(true)
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run tests/integration/api/notification-stream.test.ts -t 'revoked'
```

Expected: FAIL — the stream stays open.

- [ ] **Step 3: Capture the session at connect**

`authenticateStreamRequest` currently returns only a user id. Return the session too:

```ts
async function authenticateStreamRequest(
  request: Request
): Promise<{ userId: string; sessionId: string | undefined }> {
```

and at its end:

```ts
return { userId: user.id, sessionId: verified.payload.sid }
```

Update the caller at `:236`:

```ts
const { userId, sessionId } = await authenticateStreamRequest(request)
```

- [ ] **Step 4: Check it on every heartbeat**

Replace the heartbeat body (`:276`):

```ts
const heartbeat = setInterval(() => {
  void (async () => {
    // The ONLY recurring check on a connection that may live 24 hours.
    // requireAuth ran once, at connect; nothing else revisits this.
    if (sessionId && (await isSessionDenied(sessionId))) {
      clearInterval(heartbeat)
      response.end()
      return
    }
    response.write(': ping\n\n')
  })()
}, getEnv().SSE_HEARTBEAT_INTERVAL_MS)
```

- [ ] **Step 5: Run it and watch it pass**

```bash
pnpm exec vitest run tests/integration/api/notification-stream.test.ts
```

Expected: PASS, including the existing 14 tests.

- [ ] **Step 6: Correct the comment that hid this**

`authenticateStreamRequest`'s doc comment claims the active-user check means _"a disabled account's outstanding SSE connections stop working the same way its outstanding bearer tokens do."_ That was false — it held for new connections only. Replace with:

```
 * load and confirm the claimed user is still active. NOTE: this runs ONCE,
 * at connect. An already-open connection is re-checked only by the
 * heartbeat below, which is what actually closes a stream whose session was
 * revoked or whose account was disabled.
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm exec eslint . --max-warnings 0 && pnpm lint && pnpm test
git add src/controllers/notification-stream.controller.ts tests/integration/api/notification-stream.test.ts
git commit -m "fix: close an open stream when its session is revoked"
```

---

## Self-Review

**Spec coverage (§3):** `sid` + `jti` — Task 1. Redis denylist TTL'd to `ACCESS_TOKEN_TTL` — Task 2. Written from `revokeAllForSession` only — Task 3. Two consumers — Tasks 4 and 5, deliberately split so neither can be mistaken for the other. Fail-open, no-`sid` tolerance, Redis-flush hole — Global Constraints plus dedicated tests in Task 2.

**The deliberate oddity:** Task 3 ends with a test that still fails, and says so. Splitting write from read is what stops "the entry is written" being mistaken for "the token is refused" — the exact conflation that would leave gap #2 open while the plan claimed otherwise.

**Placeholder scan:** clean. Two steps tell the implementer to match an existing local convention (the auth fixtures in Task 3, the socket helper in Task 5) rather than invent one, and both name the file to copy from.

**Type consistency:** `denySession(sessionId: string): Promise<void>` and `isSessionDenied(sessionId: string): Promise<boolean>` are defined in Task 2 and used unchanged in Tasks 3, 4 and 5. `AccessTokenPayload.sid` is `string | undefined` in Task 1 and every consumer guards on it before use.
