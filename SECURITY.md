# Security

This file is the threat model and the defences that answer it. A project
generated from this boilerplate reads it to decide what it does not have to
build, so a false "yes" and a false "no" are equally dangerous: either one
quietly removes a control from a real system. Verify a claim against the code
it cites before relying on it. How the pieces fit together is in
[ARCHITECTURE.md](ARCHITECTURE.md); the database tables are in
[DATABASE.md](DATABASE.md).

This is a boilerplate, not a hosted service. Fixes land on `main` and ship in
the next release; a project generated from it owns its own patch cadence, and
`renovate.json` starts that on day one.

## The threat model

| Actor                                                         | Trusted with                                                                         | Main defences                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| An anonymous caller                                           | Nothing. It can register, sign in, ask for links and preview an invitation it holds. | Identical replies and timing, per-IP and per-address limits, single-use hashed tokens                  |
| A signed-in user                                              | Their own account, and each tenant at the role their membership grants               | `requireAuth` on every request, `resolveTenant` and `requireRole`, service policies re-read under lock |
| A page on another site                                        | Nothing                                                                              | Bearer access tokens, `SameSite` cookies, the JSON content-type gate, CORS                             |
| A page on a sibling subdomain (same site, other origin)       | Nothing                                                                              | The Origin check on the two routes the refresh cookie authenticates, cookie prefixes                   |
| Platform staff (members of the platform tenant)               | Reading every user and tenant; acting in customer tenants at their platform role     | Per-route role gates answering 404, step-up, a stated reason, the audit log                            |
| Whoever holds a stolen refresh cookie or access token         | What the token grants, until it is revoked or expires                                | Rotation with reuse detection, an absolute session lifetime, the session denylist                      |
| An operator who can read Redis, logs, job payloads or PostHog | Operating the service, not reading passwords, tokens or addresses                    | Hashed tokens, keyed digests in Redis key names, redacted logs and job data, scrubbed error events     |

Out of scope: an attacker who controls the database, the Redis server, the
process environment (and so `JWT_ACCESS_SECRET` and `SESSION_SECRET`), or a
frontend origin the deployment trusts (`WEB_URL`, `APEX_URL`,
`CORS_ALLOWED_ORIGINS`). Each of those can act as the API itself.

## Authentication

### Password hashing: bcrypt at cost 12

`src/utilities/password.utilities.ts` is the one module that imports bcrypt.
It hashes at `BCRYPT_COST` (12, `src/constants/auth.constants.ts`), and
`tests/unit/utilities/password.utilities.test.ts` checks the cost in every hash
and the number in this heading against that constant.

bcrypt ignores everything after a password's 72nd byte, so two passwords
sharing that prefix would match each other's hash. `hashPassword` throws for a
password over `MAX_PASSWORD_BYTES` (72, counted in UTF-8 bytes), and
`isPasswordValid` answers "no match" for one, instead of truncating. A stored
hash bcrypt cannot read is also "no match", logged at `error` without the
password or the hash, so a corrupt row looks like a wrong password to the
caller.

OWASP prefers argon2id to bcrypt. `users.password_hash` is sized for bcrypt's
60-character output, and switching algorithms once real passwords are stored
needs a dual-verify path or a reset for everyone, so a project that wants
argon2id switches before it has users.

**Rehash on login.** A hash keeps the cost it was written with. After a
successful login, `rehashIfOutdated` (`src/services/auth.service.ts`) rewrites
a hash made below `BCRYPT_COST` (`isHashCostOutdated`). The write is a
compare-and-set: `replacePasswordHash` (`src/repositories/user.repository.ts`)
updates the row only while it holds the exact hash the login verified, so a
password change or reset that committed in between is never undone. It runs
after the login's token transaction, and a failure is logged at `warn` and
never fails the login.

### Password policy: a 15-character floor, no composition rules

Every password a user sets (`registerSchema`, `resetPasswordSchema` and
`changePasswordSchema`'s `newPassword`, all through
`registrationPasswordSchema` in `src/validators/auth.validators.ts`) must be at
least `MIN_PASSWORD_LENGTH` (15) and at most `MAX_PASSWORD_BYTES` (72) bytes. The
floor counts Unicode code points (zod's `.min()`), which the error message calls
characters: 15 emoji pass, 14 do not. There are no composition rules. 15 is the
NIST SP 800-63B revision 4 minimum for a password used as a single factor, and
that guidance holds that required character classes push people toward more
predictable passwords.

The floor applies only where a password is set. `loginSchema`,
`reauthenticateSchema` and change-password's `currentPassword` only require a
non-empty string, so an account whose password was set under a shorter floor
still signs in, and a too-short or too-long login password fails with the same
401 as a wrong one rather than a 400 that would tell the two apart.

### Login: one answer, one cost

`login` (`src/services/auth.service.ts`) runs one bcrypt comparison and then
one guard, whether or not the address has an account. A password over 72 bytes
skips the comparison as "no match", and a hash that changed since the first read
is compared again under the lock; neither depends on whether the account
exists. An unknown address, a wrong password, a deactivated account, an
account with no password (Google only) and an unverified account all get
`401 Invalid email or password`. For an unknown address the comparison runs
against `getDummyHash()`, a hash at the current `BCRYPT_COST`, so the reply
costs the same.

- **The unverified case answers falsely on purpose.** A truthful "not verified
  yet" would confirm that the address is registered and the password right. The
  cost is a user who has not clicked their link seeing "wrong password".
- **Timing is equal only while stored hashes use the current cost.** After
  `BCRYPT_COST` is raised, an account whose hash is at the old cost answers a
  wrong password faster than an unknown address does, until its next successful
  login rehashes it (`BCRYPT_COST`'s comment in `src/constants/auth.constants.ts`).
- **Rows written outside this API** (an import, for example) are refused by
  `login` while their `email_verified_at` is null. Set it for accounts whose
  addresses the source system already trusted, before they sign in:

  ```sql
  UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
  ```

After the guard, `assertSignInAllowed` refuses a non-staff user in `full`
maintenance (see [Maintenance mode](#maintenance-mode)), and only then is
anything written. The token is issued in a transaction that re-reads the user
row `FOR SHARE`: a deactivation or deletion that committed since the first read
answers the same 401, and a hash that changed is compared again (see
[Password change and reset against a concurrent login](#password-change-and-reset-against-a-concurrent-login)).

### Registration and forgot-password

`POST /auth/register` answers every request with the same `202`,
`If that address can be registered, a verification email has been sent.`, and
`data: null`. Both branches hash the password first. A free address gets a
verification mail; a taken one gets a "someone tried to register with your
address" notice that greets the account's stored name, never the submitted
one, at most once per `REGISTRATION_ATTEMPT_NOTICE_COOLDOWN` (default `1h`) per
address, skipped when Redis is down. Nothing on the taken branch overwrites the
existing row. The reply is sent before either mail is queued. After the same
bcrypt hash, the two branches differ by one rolled-back insert against two more
statements and a commit; that residual timing is accepted.

`POST /auth/forgot-password` answers the same `202` for every address before it
looks the address up. It mails a reset link only to an existing, active account,
at most once per `PASSWORD_RESET_MAIL_COOLDOWN` (default `5m`) per address. The
cooldown is claimed for any address, registered or not, and the mail is sent
when Redis is down, because the owner must be able to reset.

### Google sign-in

Google sign-in is mounted only when `GOOGLE_CLIENT_ID` is set, and boot refuses
it without `GOOGLE_CLIENT_SECRET` (`src/configs/passport.config.ts`). The OAuth
`state` is checked against the one kept in a Redis-backed session that lasts 5
minutes and exists only on `/auth/google` and its callback.
`resolveGoogleUser` (`src/services/google-auth.service.ts`) decides the account:

- A Google address that Google has not verified never creates an account and
  never links to one (`403 email_not_verified`): anyone can add any address to a
  Google account.
- A verified Google address that matches a verified account links to it.
- A verified Google address that matches a never-verified account takes it
  over (`claimUnverifiedAccount`): the password and any other Google link are
  removed, the address is marked verified, and every session is revoked. The
  unverified row may be a squatter's.

## Sessions and tokens

### Access tokens

An access token is an HS256 JWT signed with `JWT_ACCESS_SECRET` (at least 32
characters), lasting `ACCESS_TOKEN_TTL` (default `15m`)
(`signAccessToken`, `src/services/session.service.ts`). Its claims are `sub`
(the user id), `sid` (the session), `jti` and `auth_time` (when the session last
authenticated). `jti` is a random UUID per token; nothing checks it and nothing
logs it. `verifyAccessToken` pins `algorithms: ['HS256']`, so a token's own
header cannot choose another algorithm, and reports only "expired" or
"invalid".

`requireAuth` (`src/middlewares/auth.middleware.ts`) runs on every protected
request: it verifies the token, refuses a session on the denylist, then loads
the user and refuses one that is soft-deleted or inactive. Loading the user on
every request is deliberate: deactivation and deletion take effect on the next
request, and a cache of known-good ids would reopen that window. Every response
behind it is `Cache-Control: no-store`, as are the login and refresh responses,
so a browser keeps no authenticated body on disk after sign-out. A verified
token with no `sid` skips the denylist and is admitted until it expires.

### The refresh cookie

A refresh token is 32 random bytes, hex-encoded, never a JWT. Only its SHA-256
is stored (`user_tokens.token_hash`); the raw value exists only in the cookie.
There is no `JWT_REFRESH_SECRET`: a refresh token has to be revocable
server-side anyway, and a signed one would only leak its claims.

`refreshCookieSpec` (`src/constants/auth.constants.ts`) names and scopes the
cookie, so every set, read and clear agrees:

| Deployment                               | Name                    | Path           | Domain                   |
| ---------------------------------------- | ----------------------- | -------------- | ------------------------ |
| `COOKIE_SECURE` off (local http)         | `refreshToken`          | `/api/v1/auth` | `COOKIE_DOMAIN` when set |
| `COOKIE_SECURE` on, no `COOKIE_DOMAIN`   | `__Host-refreshToken`   | `/`            | none                     |
| `COOKIE_SECURE` on, with `COOKIE_DOMAIN` | `__Secure-refreshToken` | `/api/v1/auth` | `COOKIE_DOMAIN`          |

Every form is `HttpOnly`, and `Secure` when `isCookieSecure` says so
(`COOKIE_SECURE`, or by default every `APP_ENV` but `local`). It is
`SameSite=Strict`, except when the Google callback sets it.

- **The prefixes stop cookie tossing.** A browser refuses a `__Host-` cookie
  unless it is `Secure`, host-only and on `Path=/`, and a `__Secure-` one unless
  it is `Secure`. Neither can be planted over plain http, and a `__Host-` one
  cannot be planted by a sibling subdomain. A `__Secure-` one can: any host
  under `COOKIE_DOMAIN` can set it over HTTPS, since `COOKIE_DOMAIN` already
  trusts its subdomains. Under `COOKIE_SECURE` the API never
  reads an unprefixed `refreshToken`: redeeming a planted one would sign the
  victim into the planter's session. The cost of `__Host-` is `Path=/`, so the
  browser sends the cookie to every path on the API's origin; a deployment that
  wants it scoped to the auth routes sets `COOKIE_DOMAIN`.
- **The newest cookie wins.** Within one name the API reads the last value
  sent, the most recently created one, so a stale cookie from an older
  `COOKIE_DOMAIN` never reaches reuse detection (`readCookie`,
  `src/controllers/auth.controller.ts`).
- **Signing in again ends the presented session, for a password login.** Login
  revokes the session of the refresh cookie the request carries once the new
  session is issued, so an overwritten cookie's session does not stay
  refreshable. The Google callback does the same, but it is reached by a
  cross-site navigation, which withholds a `Strict` cookie, and every rotation
  re-sets the cookie `Strict`. So the callback usually sees no cookie, and the
  session the new cookie overwrites in the browser stays refreshable until it
  goes unused for `REFRESH_TOKEN_TTL` or reaches `SESSION_ABSOLUTE_TTL`, unless
  something else ends it.
- **The Google callback sets the cookie `SameSite=Lax`.** `Lax` costs nothing
  here. It is still withheld from cross-site `POST`s and from subresource
  requests. The two routes that act on the cookie are `POST`s behind the Origin
  check (see [Transport and browser](#transport-and-browser)), and the one `GET`
  that reads it is this callback, which only revokes. It is also short-lived:
  the frontend refreshes as soon as it lands, and every rotation re-sets the
  cookie `Strict`.

`SameSite` assumes the frontend and this API share a registrable domain
(eTLD+1). A deployment that splits them across registrable domains makes every
refresh a cross-site `fetch`, which carries neither a `Strict` nor a `Lax`
cookie, and needs `SameSite=None; Secure` plus a CSRF token.

The OAuth session cookie of the Google round trip takes the same prefix rule:
`__Host-oauth.sid`, `__Secure-oauth.sid` with `COOKIE_DOMAIN`, or `oauth.sid`
without `COOKIE_SECURE` (`src/configs/passport.config.ts`). A planted
`oauth.sid` would bind the victim's callback to the planter's OAuth `state`.

### Rotation and reuse detection

`POST /auth/refresh` reads the token from the cookie only, never the body, and
rotates it (`rotateRefreshToken`). The claim is one `UPDATE … RETURNING` that
matches the hash, `purpose = 'refresh'` and an unrevoked row, so of two requests
presenting the same token exactly one wins, and a reset or verification token
can never be redeemed as a refresh token.

- **Reuse kills the session.** Presenting a token that is already revoked
  revokes every token of its session (the rotation chain from one sign-in) and
  denies its access tokens. A legitimate client presents each token once.
- **A grace window keeps tabs from logging each other out.** Within
  `REFRESH_REUSE_GRACE_MS` (10 s) of a token's rotation, and only while the
  session has not been killed since, a replay gets a sibling token in the same
  session instead. The trade-off is accepted: a thief who replays within those
  10 s gets a second chain that reuse detection never catches. The sibling
  lives until `SESSION_ABSOLUTE_TTL`, until it goes unused for
  `REFRESH_TOKEN_TTL`, or until its session ends (`REFRESH_REUSE_GRACE_MS`'s
  comment lists every way).
- **Two clocks bound a session.** `REFRESH_TOKEN_TTL` (default `30d`) slides on
  every rotation and bounds idleness. `SESSION_ABSOLUTE_TTL` (default `30d`) is
  measured from the sign-in and copied forward unchanged, so a client that keeps
  refreshing, or a stolen cookie, still has an end date; past it the rotation
  answers 401 and the session is revoked. An expired token is refused without
  touching its session.
- **A 401 clears the cookie it read**, so the browser stops presenting a dead
  token. A 429 or a 5xx clears nothing.

`POST /auth/logout` needs no access token, since a user whose access token has
just expired must still be able to sign out. It revokes the presented cookie's
session and clears the cookie, and answers the same for a missing, forged or
revoked token. Its timing is not uniform: a token that matches a row opens a
locked transaction, and a miss returns at once.

### Revocation and the session denylist

Revoking a session revokes its rows in Postgres, which is what ends it, and
then writes its `sid` to a Redis denylist so its access tokens stop working
before they expire (`src/services/session-denylist.service.ts`). An entry lasts
`ACCESS_TOKEN_TTL`, longer than any token minted before it.

The denylist is best-effort, and both halves of that are deliberate:

- **The read fails open.** While Redis is unreachable, or has not answered
  within `REDIS_REQUEST_DEADLINE_MS` (300 ms) and is in its 5 s stall cooldown,
  `isSessionDenied` answers false and logs a warning. Failing closed would sign
  out every user whenever Redis blinked. During that time every session denied
  in the last `ACCESS_TOKEN_TTL` is honoured on its unexpired access tokens.
- **The write never fails the request.** The database revocation already
  stands. A write that fails is logged at `error`
  (`session denylist write failed after revocation`, with the user id), and the
  revoked sessions' access tokens stay valid for up to `ACCESS_TOKEN_TTL`. A
  write still in flight at the deadline lands when Redis answers.
- A Redis flush, or a restart without persistence, drops every entry.

What revokes sessions: logout, reuse, the absolute lifetime, a password change
(every session but the caller's), a password reset and a Google account claim
(every session), `POST /auth/sessions/revoke-others` (every session but the
caller's, 10 an hour per user), and a staff deactivation, sign-out or deletion
(every session). A password change and revoke-others spare only the caller's own
row when the request presents the caller's refresh cookie and that cookie is not
revoked, so a grace-window sibling in the caller's session ends too; with no
such cookie they spare the caller's whole session.

### Password change and reset against a concurrent login

A login that checked the old password never keeps a session once a password
change or reset commits.

- A change and a reset each lock the user row `FOR NO KEY UPDATE`, write the
  hash and revoke sessions in one transaction, then deny the revoked sessions
  after commit.
- A reset, and a Google account claim, first run `revokeAllSessions`
  (`src/services/session.service.ts`) in a transaction of its own that takes the
  same lock and commits before the main transaction starts. It fails closed: if
  it throws, the reset never stores the new password and the claim never changes
  the account (the reset token is already spent by then). If the main
  transaction then fails, every session that existed, and the successor of a
  rotation that was in flight, stays revoked. The main transaction revokes
  again, for a session created between the two.
- A login re-reads the user row `FOR SHARE` before it issues its token, and
  a rotation holds the same lock while it claims. So either the login or
  rotation commits first and the password write revokes its session, or it waits
  and sees the new state: a changed hash is compared again, and only a password
  that matches the stored one (another login's rehash, or a reset to the same
  password) gets a session.

A correct password still updates `last_logged_in_at` and runs the platform
auto-join before that re-read, even when the re-read then answers 401.

## Email links

Verification, password-reset, account-setup and invitation mails carry a link to
a frontend page, never to this API: the page `POST`s the token, so the token
never sits in an API request URL that tracing or proxy logs record, and a mail
scanner that follows links does not spend it (`buildTokenUrl`,
`src/services/verification.service.ts`). The token does sit in the frontend
page's URL (`?token=`), so the frontend's access logs and its
`Referrer-Policy` are part of this defence. Which frontend a link opens is an enum
(`app: 'web' | 'apex'`), never a URL, so a request can only choose between
`WEB_URL` and `APEX_URL`.

| Link               | Token                                      | Lifetime                         | Claimed by                                                      |
| ------------------ | ------------------------------------------ | -------------------------------- | --------------------------------------------------------------- |
| Email verification | 32 random bytes, SHA-256 stored            | `EMAIL_VERIFICATION_TTL` (`24h`) | `claimToken`, single use                                        |
| Password reset     | 32 random bytes, SHA-256 stored            | `PASSWORD_RESET_TTL` (`1h`)      | `claimToken`, single use                                        |
| Account setup      | a password-reset token                     | `ACCOUNT_SETUP_TTL` (`24h`)      | `claimToken`, single use                                        |
| Tenant invitation  | 32 random bytes, base64url, SHA-256 stored | `INVITATION_TTL` (`7d`)          | `claimForAccept`, one `UPDATE` with the expiry in its predicate |

`claimToken` spends a token before it judges its expiry, so presenting an
expired token also spends it: one presentation is one attempt. `claimToken` also
matches the token's purpose, so a reset or account-setup token never verifies an
address and a verification token never resets a password. The reset link is
shorter-lived than the verification link because redeeming it takes the account
over. Staff never set a user's password: a staff-created account gets a
set-password link.

### Verification needs the password

`POST /auth/verify-email` takes `{ token, password }`. Without the password, an
attacker who registers someone else's address with a password of their own would
have the account verified by the owner's own click on the mailed link. The
attacker knows the password but never sees the token; the owner sees the token
but not the password.

`verifyEmail` claims the token before it compares the password, so a wrong
password spends the link and the user asks for another. Every failure answers
the same 400, with one exception: a link that was used while valid, for an
account that is verified, answers `409 email_already_verified` ("This email is
already verified. Sign in to continue."), writes nothing and never applies the
submitted password. A successful verification revokes the account's other
verification links.

The owner recovers a squatted address through a password reset: a completed
reset proves the mailbox, so on a never-verified account it removes any Google
link, sets the new password, marks the address verified and revokes every
session, in one transaction.

### Invitations

A user joins a tenant only by accepting an invitation; no route adds a
registered address to a tenant directly
(`src/services/tenant-invitation.service.ts`).

- **No enumeration.** Inviting answers the same `202` whether or not the
  address has an account. The one distinct answer is `409 already_member`,
  which tells an owner or admin who is already in their own tenant.
- **Consent.** Accepting needs a signed-in user whose verified address is the
  invited one: a different address gets `403 invitation_email_mismatch`, the
  right one unverified gets `403 invitation_email_unverified`, and nothing is
  claimed. A second accept by the same user succeeds; anyone else's fails.
- **The token travels in bodies only.** `POST /invitations/preview` and
  `POST /invitations/accept` take it as JSON. The API answers with
  `Referrer-Policy: no-referrer`; the accept page's own header is the
  frontend's (`react-boilerplate/nginx.conf`).
- **The grant is re-checked.** Invite, resend and revoke apply
  `canActorGrantRole` to the actor's role re-read under lock, so an admin can
  neither send, resend nor revoke an owner or admin invitation. Resending
  replaces the token, so the old link dies.
- **A pending invitation stands on its sender's authority.** Removing a member,
  or a member leaving, revokes the invitations they sent there; a role change
  revokes those the new role could not grant; deactivating or deleting an
  account revokes its invitations everywhere.
- **Mail volume is bounded three ways.** Per sender, `invite-tenant-member` (30
  an hour, shared by invite and resend). Per invitation, a resend within
  `INVITATION_RESEND_COOLDOWN` (default `10m`) answers
  `429 invitation_resend_cooldown`. Per recipient, at most
  `INVITATION_RECIPIENT_DAILY_LIMIT` (default 10) invitation mails to one address
  in 24 hours across every tenant, of which one tenant may send 3
  (`src/services/invitation-recipient-limit.service.ts`); past either, `429
RATE_LIMITED`. The recipient ceiling fails open when Redis does not answer.

### Mail at rest

- A failed email or notification job stays in Redis (7 days and 3 days) so an
  operator can read why. Once it will not be retried, its stored payload has
  every key ending in `Url` or `Token`, and every recipient-address key, replaced
  with `[redacted]` (`src/jobs/job-failure.job.ts`). Until then a retry needs
  them.
- An `email_messages` row refuses template variables whose key ends in `Url` or
  `Token` (`src/repositories/email-message.repository.ts`), so no stored row
  holds a link or a token.
- Token mails go out from `MAIL_FROM_TRANSACTIONAL`, which belongs on a
  domain with click tracking off, so a provider never rewrites a token link
  through itself. While it is unset they go from `MAIL_FROM`, and outside
  `local` boot warns whenever the two share a domain
  (`src/configs/env-consistency.config.ts`). Setting it up is in
  [README.md](README.md#email-tracking).
- The email webhook is public, so each adapter verifies the provider's
  signature over the raw body before reading it (Resend: Svix HMAC-SHA256 with a
  5-minute timestamp tolerance, `src/services/email-webhook-resend.service.ts`).
  Two limiters guard it: `email-webhook-rejected` counts only failed responses,
  60 a minute per IP, which caps forged traffic from one address;
  `email-webhook` counts only accepted ones, 3000 a minute per provider, so
  unsigned traffic cannot spend the budget a provider's bounce storm needs
  (`src/routes/email-webhook.routes.ts`).
- A staff resend never replays a stored mail: it runs the action that sent it,
  which issues a fresh token under that action's own gates. A mail with no such
  action, such as a security notice, cannot be resent
  (`src/services/platform-email.service.ts`).

## Authorization

### Tenant roles

Roles rank `owner > admin > manager > editor > viewer`
(`src/policies/tenant.policy.ts`). Every `/tenants/:slug/*` route runs
`requireAuth`, then `resolveTenant`, then its own gate
(`src/middlewares/tenant.middleware.ts`, `src/routes/tenant.routes.ts`).

- **The slug is the only tenant selector.** There is no header selector: one
  would let a request name one tenant in the URL and another in a header, and
  whichever a handler forgot to re-check would become a confused deputy.
- **No access looks like no tenant.** A missing, suspended, archived or deleted
  tenant and one the caller cannot access all answer the same `404`, never a
  `403` that would confirm a guessed slug.
- **Routes gate early, services gate again.** `requireRole` refuses with `403`.
  Changing a member's role needs an owner on the route; removing a member,
  inviting and reading the audit log need an owner or admin. Member and
  invitation writes re-check the policy (`canActorModifyTarget`,
  `canActorGrantRole`) against the role re-read under lock in their own
  transaction, so a demotion mid-request cannot finish on the old role. In a
  customer tenant only an owner acting on themself changes or removes an
  owner, and an admin cannot grant owner or admin. The platform tenant lets an
  owner act on another owner (`canPlatformActorModifyTarget`). A tenant's last
  owner cannot leave (`409 LAST_OWNER`).
- `PATCH /profile` writes only `firstName`, `lastName` and `analyticsOptOut`;
  any other key is stripped (`src/validators/profile.validators.ts`). No
  endpoint changes a user's email.

### Platform staff

Staff are the members of one seeded tenant, the row with `is_platform = true`;
their role there is their platform role (`src/services/platform.service.ts`).

- **Gated per route, not by prefix.** Every staff route lives under
  `/api/v1/platform`, and each names its own `requirePlatformRole`, which reads
  the role on every request with no cache across requests
  (`src/middlewares/platform.middleware.ts`). The prefix secures nothing, and
  neither does serving Apex from its own host. A non-staff caller, or staff
  below the route's role, gets the app's own `404 Not found`, before the JSON
  gate, the step-up check and the limiter, so a refused caller sees no `415` and
  no `RateLimit-*` headers. `cors` answers an `OPTIONS` with no `Origin`
  or an allowed one itself, with the same 204 for every path; any other
  authenticated `OPTIONS` that reaches the platform router gets the same 404
  (`refusePlatformOptions`). Either way Express's automatic `Allow` answer never
  lists a route's methods.
- **In a customer tenant, staff act at their platform role.** With no
  membership there, `resolveTenant` uses the platform role
  (`access: 'platform'`) and audits the visit (`tenant.accessed_by_platform`,
  once an hour per staff user and tenant). The route's `requireRole` and the
  service policies apply to it as to a member's role, so a platform viewer reads
  but cannot write. Where a staff user is also a member, only the membership
  counts. The platform tenant itself is members-only.
- **Joining.** A verified address whose domain is exactly one listed in
  `PLATFORM_EMAIL_DOMAINS` (no subdomains) joins as `viewer` when it is verified
  and at each successful sign-in. It never changes an existing platform role;
  anything above viewer takes an invitation or `pnpm platform:grant`. Every
  platform role reads every user, tenant and address, so list only domains
  whose mailboxes you control.
- **Staff writes leave a log line.** Each successful `/platform` write the role
  gate admitted logs one `Staff write` line: method, path, status, actor id and
  the target named in the path, never the body, so never a reason or an
  address. The audit log is the record.

### Step-up and a stated reason

`requireRecentAuth` (`src/middlewares/auth.middleware.ts`) refuses a session
that last authenticated more than `STEP_UP_MAX_AGE_MS` (10 minutes) ago with
`401 REAUTH_REQUIRED`. The time comes from the token's `auth_time`, which the
refresh row records at sign-in and rotation carries forward; a token without it
counts as stale. `POST /auth/reauthenticate`, for staff only, checks the
password and moves the session's authentication time forward. A wrong password
there is a 400, never a 401, so a typo does not sign the user out, and success
and failure are both audited (`auth.reauthenticated`). Step-up is
password-only: a Google-only account is asked to set a password first. A client
must not sign out on `REAUTH_REQUIRED`.

Step-up guards:

- on `/platform`: deactivating, deleting and purging a user; suspending,
  archiving and purging a tenant; re-inviting a tenant's owner; changing the
  maintenance mode; and an email resend of an invitation, which the service
  checks because the route cannot know the tenant;
- on the platform tenant's member routes: a role change, a removal, leaving, an
  invitation and a resend (`requireRecentAuthOnPlatformTenant`), since each
  changes who holds staff power;
- staff acting in a customer tenant through their platform role: a role change,
  a removal, and an invitation's send, resend or revoke
  (`requireRecentAuthAndReasonOnPlatformAccess`).

Staff actions that change an account's, a tenant's or a mail's state record why:
deactivating, reactivating, signing out, deleting and purging a user;
suspending, reactivating, archiving and purging a tenant; re-inviting its owner;
resending an email; lifting a suppression; completing an onboarding step or
sending a reminder; and the member and invitation writes made through platform
access. A `reason` of 1 to 500 characters of safe text (`reasonSchema`,
`src/validators/platform.validators.ts`) goes into the audit entry's metadata.
Staff acting in a customer tenant through their platform role send it in the
body or get `400 REASON_REQUIRED`, and the services check it again under the
lock.

### The audit log

`audit_logs` records every tenant, settings, member and invitation change in the
same transaction as the change, platform joins and grants, every staff action on
a user, a tenant, an email or a suppression, each staff step-up, staff visits,
and throttled staff reads of a timeline, an errors view or a flag evaluation.
Each action's metadata has a strict schema (`src/constants/audit.constants.ts`);
invitation entries keep the address's domain, never the address or the token. A
`BEFORE UPDATE OR DELETE` trigger refuses every update and delete except the
retention purge and the owner purges (created in `0016_platform_access.sql`, its
function extended in `0017_retention.sql` and `0019_audit_redact.sql`).
`TRUNCATE` is left open on purpose, for test and ops resets. The trigger guards
against a stray statement in application code; it is not a privilege boundary,
since any role that can run arbitrary SQL can set the same transaction settings
or truncate the table, so revoke `UPDATE`, `DELETE` and `TRUNCATE` on
`audit_logs` from every role but the app's. A tenant's audit log is readable by
its owners and admins; the platform audit log by platform owners and admins. The
IP, user agent and request id are stored and never returned.

### Purge: the only hard delete

A purge is the only hard delete of a user or a tenant
(`src/services/platform-purge.service.ts`). Deleting a user and archiving a
tenant are soft; a platform owner then purges with step-up and a reason. A user
purge removes the row, nulls their actor id, IP and user agent in the audit
entries they acted in, and queues the deletion of their PostHog person with its
events and recordings. A tenant purge removes the tenant and its own audit
entries. Each purge is recorded in the platform tenant.
[ARCHITECTURE.md](ARCHITECTURE.md#analytics), under Purges and what stays in
PostHog, describes what stays there.

## Input and output

- **Validation.** Every body, query and set of params goes through a zod schema
  (`parseBody`, `src/validators/parse.validators.ts`); a failure is a 400 with
  field-level `errors`. Email and name fields are capped at their column widths,
  so an over-long value is a 400, not a Postgres 500. JSON bodies are limited to
  1 MB and form bodies to 100 KB (`src/app.ts`). The email webhook and the
  collect proxy are mounted before those parsers: the webhook reads its raw
  body up to 256 KB, and the proxy streams bodies to PostHog unread and
  unbounded.
- **Free text.** `safeText` (`src/validators/safe-text.validators.ts`) refuses
  control characters, Unicode format characters (bidi marks and overrides,
  zero-width spaces and the like) and line and paragraph separators in every
  stored, rendered field: names, tenant fields, the maintenance message and
  reason, and every staff reason. The two joiners real scripts and emoji need
  are allowed inside a word. A name is still not an identifier: it accepts
  cross-script lookalikes, so identify an account by its id or verified address.
- **The error envelope.** `errorHandler` (`src/middlewares/error.middleware.ts`)
  answers every 5xx but a maintenance refusal with `Internal server error` and
  an `errorId`, whatever the error says. A maintenance `503` shows the owner's
  message and `Retry-After`, and carries no `errorId`. Below 500, an
  `HttpError`'s message is shown, since it is written for the client; any other
  error's message only when it is marked for exposure, else the status's reason
  phrase. `errorId` grants nothing: it names a log line and an error event.
- **Logged errors lose their bound query values.** A failed query's error
  message embeds its bound parameters, which for a failed `insert into users`
  are the address and the bcrypt hash. The logger replaces every query error
  logged as an `Error` field, through a five-deep `cause` chain, with its SQL
  text, driver code, parameter count and stack frames (`redactedForLog`,
  `src/errors/postgres-errors.ts`; `src/services/logger.service.ts`). It cannot
  redact what it does not see as an error: a query-shaped value that is not an
  `Error` needs `redactedForLog` at the call site, and a logged `error.message`
  string is written as it is, so log the error object.
- **No stack traces to clients.** Boot refuses `NODE_ENV` other than
  `production` outside `local`, since Express's own handler sends stack traces
  otherwise (`src/configs/env-consistency.config.ts`).

## Transport and browser

### CSRF

There is no CSRF middleware, by design. The access token travels in an
`Authorization` header, which a browser never attaches by itself. The one
cookie credential, the refresh cookie, is `SameSite`, so no cross-site `POST`
carries it. If a project relaxes `SameSite` further, or mounts a cookie session
on other routes, this reasoning does not cover it.

- **Forced login.** `SameSite` governs when a cookie is sent, not whether a
  cross-site response may set one. Without a gate, an attacker's page could
  auto-submit a form to `POST /auth/login` with the attacker's credentials and
  sign the victim into the attacker's account. `requireJsonContentType`
  (`src/middlewares/content-type.middleware.ts`) refuses any content type but
  `application/json` with `415`: a form can only send the other three, and JSON
  from a script on another origin needs a preflight that a disallowed origin
  fails. It needs no configuration, so it holds on a same-origin deployment with
  no allow-list. It is mounted on the whole auth router and on the writes of the
  tenant, invitation, platform and flags routers. A request with no content type
  passes, because an untyped body is never parsed.
- **Same-site is not same-origin.** A page on a sibling subdomain is the same
  site, so a body-less `POST` from it carries a `Strict` cookie with no
  preflight. `POST /auth/refresh` and `POST /auth/logout`, the two routes the
  cookie authenticates, run `requireAllowedOriginWhenPresent`
  (`src/middlewares/origin.middleware.ts`) before their limiters: an `Origin`
  that is not `WEB_URL`, `APEX_URL` or listed in `CORS_ALLOWED_ORIGINS` gets
  `403 ORIGIN_NOT_ALLOWED`, unless the browser marks the request
  `Sec-Fetch-Site: same-origin`. A request with no `Origin` passes. A browser
  without Fetch Metadata on an origin that is not configured is refused, so a
  deployment lists its frontend's origin. `/auth/change-password` and
  `/auth/sessions/revoke-others` read the cookie too, but only to narrow what
  they spare; they authenticate with the bearer token, so they need no Origin
  check.

### CORS

`isAllowedOrigin` (`src/utilities/origin.utilities.ts`) grants exactly
`WEB_URL`'s origin, `APEX_URL`'s and each origin in `CORS_ALLOWED_ORIGINS`, by
exact string equality, never a suffix or pattern. Responses are
`credentials: true`, so the origin is never `*` (`src/configs/cors.config.ts`).
A request with no `Origin` is allowed: CORS is a browser mechanism. A disallowed
origin gets no grant header rather than an error. Boot refuses an opaque origin
(`file:`, `data:`, an extension scheme) in `CORS_ALLOWED_ORIGINS`, since its
origin is `null` and would grant every sandboxed iframe.

Every origin in `CORS_ALLOWED_ORIGINS` can drive credentialed JSON requests, so
an XSS on that frontend reaches this API as the primary frontend does. List only
origins trusted at the primary frontend's level.

### Headers

`helmet` is the first middleware (`src/app.ts`, `src/configs/helmet.config.ts`),
so every response carries its headers, a preflight, a 404 and an error
included:

- `Content-Security-Policy: default-src 'none';frame-ancestors 'none'`: the
  API serves no HTML.
- `Cross-Origin-Resource-Policy: same-site`, not `same-origin`: it governs only
  no-cors embeds, and a frontend on a sibling subdomain is a different origin of
  the same site. Credentialed fetches are gated by CORS alone.
- `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- No `Strict-Transport-Security`. HSTS belongs to the TLS-terminating edge,
  the only hop that knows the response left over HTTPS and which hosts
  `includeSubDomains` may cover. An express served straight over TLS sends none
  until the operator adds it.

### Behind a proxy: `TRUST_PROXY`

`TRUST_PROXY` decides `request.ip`, and so every IP-keyed limiter and the
address the analytics proxy forwards. Behind a proxy with it off, every client
shares one bucket. Trusting too much lets a client name its own IP in
`X-Forwarded-For` and escape the limiters, so boot refuses `TRUST_PROXY=true`
(`src/configs/env.config.ts`). Set the number of proxies you control (`1` for a
typical ingress), or their addresses. Behind TLS termination it also decides
whether express-session sees the request as secure; without it the OAuth
session cookie is never set and Google sign-in fails, which boot warns about.
The refresh cookie does not depend on it.

## Analytics and error tracking privacy

With `POSTHOG_PROJECT_KEY` unset, no event reaches PostHog and the collect
proxy answers 503 (`src/configs/analytics.config.ts`). The staff timeline and
Errors reads and the deletion of purged users use the personal API key
instead, and run whenever `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`
are set.

### The analytics proxy

`/api/v1/collect` proxies the browsers' posthog-js traffic to PostHog's ingest
and assets hosts, under its own per-IP limiter (3000 a minute), streaming bodies
unread (`src/routes/analytics-proxy.routes.ts`).

- **It carries no credential.** It removes `Cookie` and `Authorization` before
  the request leaves, so PostHog never receives the `Path=/` refresh cookie or a
  bearer token. A request carrying `Expect` is refused `417` first, because the
  proxy library skips that header rewrite for such a request.
- **The client address is the one Express resolved.** `X-Forwarded-For`,
  `-Proto`, `-Host` and `-Port` are set from what this server saw, never
  appended to what the client sent, so a client cannot choose the address
  PostHog geolocates.
- **PostHog decides nothing on the API's origin.** The upstream's `Set-Cookie`
  (which could overwrite the refresh cookie) and `Access-Control-*` headers are
  dropped. An upstream silent for 30 s gets a 504.
- It reaches only the configured PostHog hosts, so it is not an open relay.

### Server events

- **Ids, not names.** The event builder holds every PII rule
  (`src/services/analytics/analytics-event-builder.service.ts`): no person names,
  full addresses, staff reasons or email contents go into an event; an
  address's domain may. A tenant's name goes into the tenant group's properties
  (`$groupidentify`). A user id `distinct_id` and a `$session_id` are pseudonymous, not
  anonymous.
- **The opt-out is the browser's.** `analyticsOptOut` tells the frontends to
  stop capturing; server events do not read it (`src/presenters/user.presenter.ts`).
- **Server events are signed; browser events are client-reported.** The project
  key is public, so anyone can send PostHog any event under any `distinct_id`.
  Every server event carries `server_sig`, an HMAC keyed from `SESSION_SECRET`
  (`src/services/analytics/analytics-signature.service.ts`), and the staff
  timelines trust a row's source, access and target only when it verifies.
  **Accepted risk:** PostHog's own UI shows forged events, and a flood of them
  can push real rows onto later timeline pages. A request's `traceparent` is
  the client's choice; a trace id correlates and authorizes nothing.

### Error tracking: what reaches PostHog

With `ERROR_TRACKING_ENABLED` (default true) as well, an unexpected 5xx, a
process fault and a job's final failure each send one `$exception` from memory,
not through the outbox, since errors often arrive while the database is down
(`src/services/errors/error-reporter.service.ts`).

- **What is sent.** An error's name, message, stack frames and `cause` chain,
  the route template (never the URL), the request id, and the acting user and
  tenant. Never request bodies, headers, query strings or cookies, a Postgres
  error's `detail`, `query`, `parameters` or `where`, a failed query's bound
  values, a job's data, or an `HttpError`'s `errors`. A thrown non-`Error`
  contributes its class name, or the first `Error` it holds (whose message is
  then sent, scrubbed), never its own keys or values
  (`src/services/errors/error-event.service.ts`).
- **What is not reported.** Any 4xx, a client that went away, an `HttpError`
  5xx with no `cause`, and a timeline that PostHog could not answer.
- **Everything sent is scrubbed first.** `scrubText`
  (`src/services/errors/error-scrubber.service.ts`) removes addresses, IPs,
  `+`-prefixed phone numbers, JWTs and vendor keys, URL logins, query strings
  and fragments, Authorization and Cookie values, secret-named `key=value`
  pairs, OAuth codes, the token segment of a link path, and long hex and base64
  runs, then caps each value at 1024 characters. The span that records the
  exception gets the same scrubbed text, and so does every log record forwarded
  to Slack. The react and apex frontends hold the same file byte for byte
  (`react-boilerplate/src/observability/errors/scrub.ts`), and all three test it
  against `tests/fixtures/error-scrub-vectors.json`. The file's own comments
  list what each rule catches and what it misses. Regex scrubbing is best-effort:
  keep secrets and personal data out of error messages.
- **`$exception` events are signed too.** The staff Errors views verify the most
  recent event of each issue and scrub its type and message again, because a
  forged browser event can carry anything
  (`src/services/analytics/errors-mapper.service.ts`). **Accepted risk:** a
  forged event newer than an issue's real ones can mask its latest type and
  message in the staff view, which then marks the row unverified.
- **`/health` and `/health/ready` are public.** `/health` names the release
  (`APP_VERSION`); a private fork that treats its commit sha as sensitive drops
  it in `src/app.ts`. `/health/ready` names which of `database`, `redis` and
  `queue` failed, never a host or driver text.

## Rate limits and abuse

### Rate limiting: one store prefix per limiter

`RATE_LIMITS` (`src/constants/rate-limit.constants.ts`) holds 30 limiter specs,
each commented with the reason for its window, budget and key, and
`createRateLimiter` builds each into middleware with its own Redis key prefix
(`<REDIS_KEY_PREFIX>:rl:<name>:`, `src/middlewares/rate-limit.middleware.ts`),
so no limiter spends another's budget. Two are deliberately shared across
routers: `authenticatedWrite`, the floor every authenticated write without its
own limiter carries, and `flagExposure`. A 429 carries `code: RATE_LIMITED` and
the standard `RateLimit-*` headers. `tests/unit/routes/route-limiters.test.ts`
fails a write route with no limiter.

- **No address is a key name.** Wherever an address keys a counter (the
  email-keyed limiters, the login composite, the mail cooldowns, the invitation
  recipient ceiling) the key is `hashRateLimitIdentity`: HMAC-SHA256 under a key
  derived from `SESSION_SECRET` by HKDF (`src/utilities/rate-limit-key.utilities.ts`).
  An operator cannot read an address off a key, and nobody without the secret
  can test a guess against one. Rotating `SESSION_SECRET` restarts those
  counters.
- **Counting survives a Redis outage, per process.** The store switches to Redis
  once it answers and falls back to memory for any command that fails or stalls
  (`src/configs/rate-limit-store.config.ts`). Limits are never switched off, but
  during an outage N replicas allow up to N times a limit.

The auth limiters each answer a specific threat:

- **Login** counts the IP and the submitted address together (5 in 15 minutes):
  the address alone would let anyone lock a victim out, and the IP alone would
  share five attempts across an office. `login-ip` (100 in 15 minutes) bounds
  one IP spraying many accounts, and `login-account` (100 an hour) bounds many
  IPs against one account. `login-account` counts only well-formed attempts
  that were refused, so malformed requests and the owner's own sign-ins spend
  nothing. **Accepted:** 100 well-formed wrong passwords an hour still lock an
  account.
- **Register** counts by IP alone (100 an hour): enumeration changes the address
  on every request, so only an IP key bounds it, and it bounds bcrypt CPU and
  outbound mail.
- **Forgot-password** has only a per-IP limiter (5 an hour). A per-address
  limiter would let anyone who knows an address deny its owner their reset mail;
  the silent per-address mail cooldown bounds one inbox instead.
- **Change-password and reauthenticate** compare a submitted password, so each
  gets login's budget (5 in 15 minutes), per user.
- **Refresh and logout** are volume protection (300 in 5 minutes per IP): a
  refresh token is 256 random bits. Logout's budget is generous because a 429
  leaves the cookie uncleared.

There is no global limiter: most authenticated reads mount none. Notification
streams are capped per process: `SSE_MAX_STREAMS_PER_USER` (default 5) answers
`429 too_many_streams`, and `SSE_MAX_STREAMS_TOTAL` (default 2000) answers
`503 stream_capacity`; a stream ends when its access token expires.

## Maintenance mode

Maintenance mode is an availability control, not an access control. Its gate
(`src/middlewares/maintenance-mode.middleware.ts`) decides from each replica's
in-memory mode, by method and path (`MAINTENANCE_ROUTE_RULES`,
`src/constants/maintenance-mode.constants.ts`), before any router runs. In
`read_only` it refuses writes outside a short allowlist; in `full` it refuses
everything but health, the email webhook, the collect proxy, the public status,
`/platform`, sign-in, refresh, logout, reauthenticate, `GET /auth/providers`
and `GET /profile`. On the customer routes Apex calls, the
refusal is decided in `requireAuth`, which lets platform staff through.

- In `full`, password login refuses a user with no platform role
  (`503 MAINTENANCE_MODE`) after the credentials pass and before anything is
  written (`assertSignInAllowed`). The Google callback refuses the same user
  only after `resolveGoogleUser` has run, so a non-staff Google sign-in in
  `full` can create an account, link a Google identity or claim an unverified
  account before it gets the 503 (`completeGoogleSignIn`,
  `src/services/google-auth.service.ts`); see the gaps table.
- Changing the mode needs a platform owner, a recent sign-in, JSON, its own
  limiter (10 a minute), and, to switch on or escalate, a `confirm` equal to
  `APP_ENV`. A stale `expectedVersion` answers 409. The change and its audit
  entry commit together.
- The public `GET /status/maintenance` returns the mode, the customer message
  and when it began, never the internal reason or who changed it.

[ARCHITECTURE.md](ARCHITECTURE.md#maintenance-mode) describes the store, the
reload and the queue pause.

## What this boilerplate does not implement

| Control                                               | Status              | What it means for you                                                                                                                          |
| ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| MFA                                                   | **Not implemented** | No TOTP, no recovery codes. The one step-up is a password re-check before staff actions.                                                       |
| CSRF tokens                                           | **Not implemented** | By design; see [CSRF](#csrf). A deployment that splits the frontend and the API across registrable domains needs them.                         |
| Global rate limiting                                  | **Partial**         | 30 limiters, and every write route has one. Most authenticated reads have none.                                                                |
| Audit of sign-in and credential events                | **Partial**         | `audit_logs` records no login, logout, password change or reset. The one sign-in event it records is a staff step-up (`auth.reauthenticated`). |
| Session list                                          | **Not implemented** | A user can end every other session, and staff can end all of a user's, but no endpoint lists sessions.                                         |
| Email change and self-service account deletion        | **Not implemented** | `PATCH /profile` sets only the names and the analytics opt-out. Staff delete accounts.                                                         |
| Impersonation, break-glass access, row-level security | **Not implemented** | Staff act only through their platform role; tenant isolation is enforced in the application.                                                   |
| Google sign-in writes before the maintenance refusal  | **Gap**             | In `full`, a non-staff Google sign-in can create, link or claim an account before `assertSignInAllowed` refuses it with a 503.                 |
| HSTS                                                  | **Not in the API**  | The TLS-terminating edge sends it.                                                                                                             |
| Uniform logout timing                                 | **Not implemented** | A logout whose cookie matches a row takes longer than one that does not. Every logout answers the same body.                                   |
| OpenAPI documentation and seed data                   | **Not implemented** | No spec is generated or served. No seed script; `pnpm platform:grant` grants a platform role to an existing verified user.                     |

## Reporting a vulnerability

Report a security problem privately through GitHub's private vulnerability
reporting on this repository: open the **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for a security problem.
