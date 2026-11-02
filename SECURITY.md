# Security

This file lists the threats this API defends against and the defence for
each. It is for a developer or reviewer of a project generated from this
boilerplate, deciding which security controls the project already has and
which it must build.

A false "yes" and a false "no" are equally dangerous here: either one removes a
control from a real system without anyone noticing. Verify a claim against the
code it cites before relying on it. How the pieces fit together is in
[ARCHITECTURE.md](ARCHITECTURE.md); the database tables are in
[DATABASE.md](DATABASE.md).

This is a boilerplate, not a hosted service. Fixes land on `main` and ship in
the next release. A project generated from it owns its own patch schedule, and
its `renovate.json` (dependency update bot configuration) starts that schedule
from the first commit.

Terms used throughout:

| Term                | Meaning                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Tenant or workspace | A customer organisation. Users join it through a membership with a role.                                              |
| Platform tenant     | The one tenant whose members are platform staff, who run the service.                                                 |
| Web and Apex        | The two frontends: web (`WEB_URL`) for customers, Apex (`APEX_URL`) for platform staff.                               |
| Step-up             | A fresh proof of identity, by emailed link or passkey, that a sensitive action requires.                              |
| Claim of a token    | One SQL statement that marks a token as used, so exactly one of two concurrent callers wins.                          |
| Claim of an account | Taking over a never-verified account for the mailbox owner ([Account creation on click](#account-creation-on-click)). |
| PostHog             | The product analytics and error tracking service the API and frontends report to.                                     |

## The threat model

Each row names one kind of caller, what the API trusts it with, and the main
defences this file describes. IP means Internet Protocol address; CORS is
cross-origin resource sharing, the browser rules for requests from another
origin.

| Actor                                                         | Trusted with                                                                                                 | Main defences                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| An anonymous caller                                           | Nothing. It can ask for a sign-in link, sign in with one or with Google, and preview an invitation it holds. | One reply before any lookup, per-IP and per-address limits, single-use hashed links                    |
| A signed-in user                                              | Their own account, and each tenant at the role their membership grants                                       | `requireAuth` on every request, `resolveTenant` and `requireRole`, service policies re-read under lock |
| A page on another site                                        | Nothing                                                                                                      | Bearer access tokens, `SameSite` cookies, the JSON content-type gate, CORS                             |
| A page on a sibling subdomain (same site, other origin)       | Nothing                                                                                                      | The Origin check on the two routes the refresh cookie authenticates, cookie prefixes                   |
| Platform staff (members of the platform tenant)               | Reading every user and tenant; acting in customer tenants at their platform role                             | Per-route role gates answering 404, step-up, a stated reason, the audit log                            |
| Whoever holds a stolen refresh cookie or access token         | What the token grants, until it is revoked or expires                                                        | Rotation with reuse detection, an absolute session lifetime, the session denylist                      |
| An operator who can read Redis, logs, job payloads or PostHog | Operating the service, not reading tokens or addresses                                                       | Hashed tokens, keyed digests in Redis key names, redacted logs and job data, scrubbed error events     |

Out of scope: an attacker who controls any of these, since each can act as the
API itself:

- the database;
- the Redis server;
- the process environment, and so `JWT_ACCESS_SECRET` and `SESSION_SECRET`;
- a frontend origin the deployment trusts (`WEB_URL`, `APEX_URL`,
  `CORS_ALLOWED_ORIGINS`).

## Authentication

This section covers how a person proves who they are: an emailed sign-in link,
or Google. Passkeys are under [Passkeys](#passkeys).

### Sign-in links: one answer, one reply before the lookup

A person signs in by a single-use link mailed to their address, or by Google
([Google sign-in](#google-sign-in)).

`POST /auth/link/request` takes `{ email, app, redirect? }`. It answers every
well-formed request with the same `202`, `Check your inbox for a sign-in link.`
and `data: null`.

It replies before it reads anything. The controller sends the reply, then
starts the follow-up that `requestSignInLink` returns
(`src/services/sign-in-link.service.ts`). So neither the body nor the timing
depends on the address. The follow-up never rejects, and it stops silently at
the first check that says no:

1. the per-address mail cooldown, one link per `SIGN_IN_LINK_MAIL_COOLDOWN`
   (default `1m`), which sends when Redis is down, because the owner must be
   able to sign in;
2. the per-address daily budget of `SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT` links
   (default 10) in a fixed 24-hour window, which fails open the same way
   (`src/services/sign-in-link-limit.service.ts`);
3. the lookup: an inactive account gets nothing, and in `full` maintenance an
   address that is not staff gets nothing;
4. on Apex, an address that is not staff gets its pending staff invitation
   again, unless that invitation is inside its own resend cooldown, and
   otherwise nothing (`resendPlatformInvitationForSignIn`);
5. the mail. On web an address with no account gets a link too: its click
   creates the account ([Account creation on click](#account-creation-on-click)).

Issuing a link revokes the address's earlier live links, so at most one is
live. It lasts `SIGN_IN_LINK_TTL` (default `15m`). The link opens
`<app origin>/auth/link?token=…&email=…`, plus `&redirect=…` when the request
stored one. Its `redirect` is a display hint the server never reads; its
`email` is read only when the client sends it back for the mismatch check
below ([Email links](#email-links)).

`POST /auth/link/verify` takes `{ token, email? }` and signs in the account the
link's address holds (`verifySignInLink`):

- **Every dead link gets one answer.** An unknown, used, expired, revoked or
  malformed link, a deactivated account, an Apex link to an account that is not
  staff and a mismatched `email` all answer `400 LINK_INVALID`,
  `This link expired or was already used. Ask for a new link.` It is a 400,
  never a 401, because the clients sign out on a 401.
- **One presentation is one attempt.** The claim spends the row before its
  expiry is judged, so of two concurrent verifies of one link exactly one gets
  a session.
- **The frontend and the redirect come from the row.** Verify reads `app` and
  `redirect` from the link's `user_tokens` row, never from the request. The
  redirect passed `redirectPathSchema` (a same-origin path of at most 2048
  characters) when it was stored. An Apex link signs in only an existing staff
  account; a web link signs a staff member in to the web app.
- **The address on the page must be the link's.** This is the login
  cross-site request forgery (CSRF) defence. The frontends show the link's
  `email` param ("This link is for …"), and anyone who forwards a link can edit
  it. An attacker could send their own token under the victim's address. The
  victim, reading their own address, would then work inside the attacker's
  account.
  - So the client sends the address it shows. Verify compares it, trimmed and
    lowercased, with the row's address on a read-only peek before the claim
    (`assertLinkShowsItsAddress`).
  - A mismatch answers `LINK_INVALID` and spends nothing, so the owner's link
    still works. Neither address is logged.
  - A verify with no `email` is refused the same way; otherwise removing the
    parameter would skip the check. A frontend given a link with no `email`
    never posts it.
- **Maintenance decides before the claim.** In `full` and `read_only`, verify
  reads the row without spending it first, so a refused link still works once
  the mode ends ([Maintenance mode](#maintenance-mode)).
- **The reply** is `Cache-Control: no-store` and sets the refresh cookie. The
  route runs the Origin check before its limiter ([CSRF](#csrf)), and a refresh
  cookie the request still carried has its session revoked once the new one is
  issued.

**Accepted:** the cooldown and the budget are silent by design, so a second
request inside a minute mails nothing. The frontends show a 60-second
countdown after every send instead.

**Accepted:** the daily budget can lock an owner out of email links. Anyone
who knows an address can spend its 10 links with requests spaced past the
1-minute cooldown. The owner then gets no link for up to 24 hours. Three facts
bound the harm:

- every one of those links reaches the owner's own mailbox;
- the newest stays live for 15 minutes;
- Google sign-in, where it is set up, still works.

### Account creation on click

A web link to an address with no account creates a verified account when it is
clicked (`createLinkedAccount`, `src/services/account-claim.service.ts`). One
transaction writes the user row, its `email` provider row and its
verification.

- **The click proves the mailbox.** So a request writes no account, and an
  address nobody clicks for never holds one.
- **The account is found by address.** A `sign_in_link` row never carries a
  user id, so a soft-deleted user's address gets a fresh account, never the
  deleted one.
- **Two racing clicks reach one account.** The loser's insert hits
  `users_email_unique`, and it signs in to the winner's account as an existing
  one (`isNewUser: false`).
- **Read-only maintenance creates no account.** In `read_only` a click that
  would create an account answers `503 READ_ONLY_MODE` before the claim, and a
  click to an existing account signs in. A web Google sign-in follows the same
  rule ([Maintenance mode](#maintenance-mode)).

**A never-verified account is claimed.** An account with a null
`email_verified_at` can hold a squatter's credentials (a squatter is someone
who registered an address they do not own). One function takes such an account
over, `claimNeverVerifiedAccount`. Four proofs of the mailbox call it:

1. a sign-in link;
2. an invitation link;
3. `pnpm platform:grant`;
4. an address Google verified.

The first three pass `clearSquatterCredentials`, which deletes the account's
federated links. The Google claim deletes every other Google link and links its
own. The claim runs in this order:

1. It revokes every session in a committed transaction of its own.
2. It locks the user row, runs those writes, marks the address verified and
   revokes every session again, so a session created between the two steps
   ends too.

A claim that finds the row verified under the lock writes nothing: a
concurrent claim won, and the account belongs to the mailbox owner.

**Rows written outside this API** (an import, for example) with a null
`email_verified_at` are claimed on their owner's first sign-in: their sessions
end and their federated links go. When the source system already trusted the
addresses, set it before they sign in:

```sql
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
```

### Google sign-in

Google sign-in is mounted only when `GOOGLE_CLIENT_ID` is set, and boot refuses
it without `GOOGLE_CLIENT_SECRET` (`src/configs/passport.config.ts`).

- **The OAuth `state` is checked.** OAuth is the authorization protocol Google
  sign-in uses. The callback's `state` must match the one kept in a
  Redis-backed session. That session lasts 5 minutes and exists only on the
  Google routes and their callback.
- **The start keeps `app` and `redirect`.** `GET /auth/google` takes `app` and
  an optional `redirect`, which the session keeps. A `redirect` that fails
  `redirectPathSchema` is dropped (`rememberOAuthApp`).
- **A cross-site start goes nowhere.** A start with `Sec-Fetch-Site: cross-site`
  goes to the login page instead, before any session or trip to Google
  (`refuseCrossSiteOAuthStart`). Google can approve with no prompt, so another
  site could otherwise switch the browser's account.

`resolveGoogleUser` (`src/services/google-auth.service.ts`) decides the
account:

- A Google address that Google has not verified never creates an account and
  never links to one (`403 email_not_verified`): anyone can add any address to a
  Google account. It is refused before the address is looked up, with the same
  status, code and message whether or not an account has it, so the answer
  does not tell whether the address is registered.
- A verified Google address that matches a verified account links to it.
- A verified Google address that matches a never-verified account claims it
  (`claimUnverifiedAccount`, through `claimNeverVerifiedAccount`): any other
  Google link is removed, the address is marked verified, and every session is
  revoked. The unverified row may be a squatter's.
- A verified Google address with no account gets a new one on web. On Apex,
  Google signs in only an existing, active staff account and creates nothing:
  any other profile gets the same `google_auth_failed` (`assertApexStaff`).

## Sessions and tokens

This section covers what a signed-in client holds and how the API ends it. A
session is the chain of tokens one sign-in starts. The client holds a
short-lived access token, sent as a bearer header, and a long-lived refresh
token in a cookie. TTL in a variable name means time to live.

### Access tokens

An access token is a JSON Web Token (JWT) signed with HMAC-SHA256 (HS256)
under `JWT_ACCESS_SECRET` (at least 32 characters). It lasts
`ACCESS_TOKEN_TTL` (default `15m`) (`signAccessToken`,
`src/services/session.service.ts`). Its claims are:

- `sub`: the user id;
- `sid`: the session;
- `jti`: a random universally unique identifier (UUID) per token, which no
  code checks or logs;
- `auth_time`: when the session last authenticated.

`verifyAccessToken` pins `algorithms: ['HS256']`, so a token's own header
cannot choose another algorithm. It reports only "expired" or "invalid".

`requireAuth` (`src/middlewares/auth.middleware.ts`) runs on every protected
request. It verifies the token, refuses a session on the denylist, then loads
the user and refuses one that is soft-deleted or inactive. Loading the user on
every request is deliberate: deactivation and deletion take effect on the next
request, and a cache of known-good ids would reopen that window. A verified
token with no `sid` skips the denylist and is admitted until it expires.

Every response behind `requireAuth` is `Cache-Control: no-store`, as are the
login and refresh responses, so a browser keeps no authenticated body on disk
after sign-out. Every error response is `no-store` too, so a refusal carries
the same header whichever gate answered:

- `errorHandler` marks each error it writes;
- the analytics proxy marks its own 417 and 503 and the proxy library's
  upstream failure answers;
- `/health/ready` marks its two 503s (shutting down, not ready).

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

- **The prefixes stop cookie tossing**, where another site or subdomain plants
  a cookie for the API's host. A browser refuses a `__Host-` cookie unless it
  is `Secure`, host-only and on `Path=/`, and a `__Secure-` one unless it is
  `Secure`.
  - Neither can be planted over plain http.
  - A sibling subdomain cannot plant a `__Host-` one. It can plant a
    `__Secure-` one: any host under `COOKIE_DOMAIN` can set it over HTTPS,
    since `COOKIE_DOMAIN` already trusts its subdomains.
  - Under `COOKIE_SECURE` the API never reads an unprefixed `refreshToken`:
    redeeming a planted one would sign the victim into the planter's session.
  - The cost of `__Host-` is `Path=/`, so the browser sends the cookie to every
    path on the API's origin. A deployment that wants it scoped to the auth
    routes sets `COOKIE_DOMAIN`.
- **The newest cookie wins.** Within one name the API reads the last value
  sent, the most recently created one. So a stale cookie from an older
  `COOKIE_DOMAIN` never reaches reuse detection (`readCookie`,
  `src/controllers/helpers.controller.ts`). One exception: after
  `COOKIE_DOMAIN` is reverted to an earlier value, the browser keeps the
  overwritten cookie's original creation time. The other scope's cookie then
  reads as newer, and refresh fails until the user signs in again or the cookie
  expires (`REFRESH_TOKEN_TTL`).
- **Signing in again ends the presented session.** A link verify and an
  invitation verify revoke the session of the refresh cookie the request
  carries, once the new session is issued. So an overwritten cookie's session
  does not stay refreshable.
  - The Google callback does the same, but a cross-site navigation reaches it,
    and that navigation withholds a `Strict` cookie. Every rotation re-sets the
    cookie `Strict`.
  - So the callback sees no cookie unless the browser still holds the `Lax`
    cookie of an earlier Google callback that has not rotated yet.
  - The session the new cookie overwrites in the browser then stays
    refreshable until it goes unused for `REFRESH_TOKEN_TTL` or reaches
    `SESSION_ABSOLUTE_TTL`, unless something else ends it.
- **The Google callback sets the cookie `SameSite=Lax`.** `Lax` costs nothing
  here. It is still withheld from cross-site `POST`s and from subresource
  requests. The two routes that act on the cookie are `POST`s behind the Origin
  check (see [Transport and browser](#transport-and-browser)), and the one `GET`
  that reads it is this callback, which only revokes. It is also short-lived:
  the frontend refreshes as soon as it lands, and every rotation re-sets the
  cookie `Strict`.

`SameSite` assumes the frontend and this API share a registrable domain
(eTLD+1, the effective top-level domain plus one label, such as
`example.com`). A deployment that splits them across registrable domains makes
every refresh a cross-site `fetch`, which carries neither a `Strict` nor a
`Lax` cookie. Such a deployment needs `SameSite=None; Secure` plus a CSRF
token.

The OAuth session cookie of the Google round trip takes the same prefix rule:
`__Host-oauth.sid`, `__Secure-oauth.sid` with `COOKIE_DOMAIN`, or `oauth.sid`
without `COOKIE_SECURE` (`src/configs/passport.config.ts`). A planted
`oauth.sid` would bind the victim's callback to the planter's OAuth `state`.

### Rotation and reuse detection

`POST /auth/refresh` reads the token from the cookie only, never the body, and
rotates it (`rotateRefreshToken`). The claim is one `UPDATE … RETURNING` that
matches the hash, `purpose = 'refresh'` and an unrevoked row. So of two
requests presenting the same token exactly one wins, and a sign-in or step-up
link can never be redeemed as a refresh token.

- **Reuse kills the session.** Presenting a token that is already revoked
  revokes every token of its session (the rotation chain from one sign-in) and
  denies its access tokens. A legitimate client presents each token once.
- **A grace window keeps tabs from logging each other out.** Within
  `REFRESH_REUSE_GRACE_MS` (10 seconds) of a token's rotation, and only while
  the session has not been killed since, a replay gets a sibling token in the
  same session instead.
  - **Accepted:** a thief who replays within those 10 seconds gets a second
    chain that reuse detection never catches.
  - The sibling lives until `SESSION_ABSOLUTE_TTL`, until it goes unused for
    `REFRESH_TOKEN_TTL`, or until its session ends. The comment on
    `REFRESH_REUSE_GRACE_MS` lists every way a session ends.
- **Two clocks bound a session.**
  - `REFRESH_TOKEN_TTL` (default `30d`) slides on every rotation and bounds
    idleness.
  - `SESSION_ABSOLUTE_TTL` (default `30d`) is measured from the sign-in and
    copied forward unchanged. So a client that keeps refreshing, or a stolen
    cookie, still has an end date. Past it, the rotation answers 401 and the
    session is revoked.
  - An expired token is refused without touching its session.
- **A 401 clears the cookie it read**, so the browser stops presenting a dead
  token; an empty cookie is cleared too. A 429 or a 5xx clears nothing.

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
  within `REDIS_REQUEST_DEADLINE_MS` (300 milliseconds) and is in its
  5-second stall cooldown, `isSessionDenied` answers false and logs a warning. Failing closed would sign
  out every user whenever Redis blinked. During that time every session denied
  in the last `ACCESS_TOKEN_TTL` is honoured on its unexpired access tokens.
- **The write never fails the request.** The database revocation already
  stands. A write that fails is logged at `error`
  (`session denylist write failed after revocation`, with the user id), and the
  revoked sessions' access tokens stay valid for up to `ACCESS_TOKEN_TTL`. A
  write still in flight at the deadline lands when Redis answers.
- A Redis flush, or a restart without persistence, drops every entry.

What revokes sessions:

| Event                                                                                         | Sessions revoked               |
| --------------------------------------------------------------------------------------------- | ------------------------------ |
| Logout                                                                                        | the presented one              |
| Reuse of a revoked refresh token                                                              | that token's session           |
| The absolute lifetime                                                                         | the expired one                |
| A claim of a never-verified account ([Account creation on click](#account-creation-on-click)) | every session of the account   |
| `POST /auth/sessions/revoke-others`                                                           | every session but the caller's |
| A staff deactivation, sign-out or deletion                                                    | every session of the user      |

`POST /auth/sessions/revoke-others` allows 10 calls an hour per user, and only
after a recent sign-in, so a stolen session can't sign its owner out and keep
the account. It spares only the caller's own row when the request presents the
caller's refresh cookie and that cookie is not revoked, so a grace-window
sibling in the caller's session ends too. With no such cookie it spares the
caller's whole session.

A `sign_in_link` row has no user id, so these user-wide revocations never reach
one. Revoke-others, a staff sign-out and a deactivation also revoke the
address's live sign-in links in their own transaction (`revokeSignInLinksOf`,
`src/services/session.service.ts`). A sign-out (`revokeAllForSession`) revokes
the session's live step-up link with its chain.

### Deactivation against a concurrent sign-in

A sign-in that read an active account never keeps a session once a
deactivation or a deletion commits.

- A link, invitation or Google sign-in issues its refresh token in a
  transaction that re-reads the user row `FOR SHARE` and refuses an account
  that is inactive or gone by then, with that surface's own generic answer
  (`LINK_INVALID`, `invitation_invalid`, `google_auth_failed`). A rotation
  holds the same lock while it claims.
- A staff deactivation, sign-out or deletion locks the user row
  `FOR NO KEY UPDATE` (`lockStaffPair`, `src/services/platform-user.service.ts`),
  writes and revokes the sessions in one transaction, then denies the revoked
  sessions after commit. A deactivation and a sign-out also revoke the
  address's live sign-in links there. A deletion leaves them: a later click
  re-proves the mailbox and creates a fresh account for its owner
  ([Account creation on click](#account-creation-on-click)), never the deleted
  one, and a user purge deletes them (`deleteForEmail`).
- So either the sign-in commits first and the deactivation revokes its
  session, or it waits for the lock and finds the account inactive.
- A write that makes the user a tenant owner or staff takes the same
  `FOR SHARE` lock before its write, so a staff delete holding the row
  `FOR NO KEY UPDATE` either waits for the grant and sees it, or wins and the
  grant finds the account gone ([Platform staff](#platform-staff)).
  Single-statement updates of the row on the pool (the last sign-in time, a
  profile edit, email verification) queue behind a grant for its few
  statements.

A link or Google sign-in stamps `last_logged_in_at` before that re-read,
outside the lock, so a sign-in the re-read refuses has still stamped it. An
invitation verify stamps it after its transaction commits, best effort.

### Passkeys

A passkey is a WebAuthn (Web Authentication standard) credential: a key pair
on the person's device or password manager, unlocked by a fingerprint, face or
device PIN. `PASSKEY_MODE` sets how far passkeys reach:

| Mode                 | Effect                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `off`                | Hides every passkey route behind the unknown-route 404 and keeps the stored rows. Switching back restores the rows.  |
| `optional` (default) | A person can create passkeys and sign in with one.                                                                   |
| `required`           | Also refuses every signed-in route outside a short allowlist until the account has a passkey (Required mode, below). |

`GET /auth/passkeys/config` is public and answers the mode in every mode, so a
frontend knows whether to show the passkey screens.

- **The relying party.** The relying party is the site a passkey belongs to,
  named by its relying party identifier (RP ID).
  - `WEBAUTHN_RP_ID` defaults to the host of `WEB_URL`. The expected origins
    are `WEB_URL` and, when set, `APEX_URL`. The `CORS_ALLOWED_ORIGINS` extras
    are not passkey origins.
  - Unless the mode is `off`, boot refuses an RP ID that is neither equal to
    nor a parent domain of each expected origin's host (`passkeyRpIdProblem`,
    `src/configs/env-consistency.config.ts`).
  - Boot also refuses an IPv4 or IPv6 address as the RP ID, since browsers
    refuse one; `localhost` is allowed.
  - A passkey is bound to the RP ID, so changing it orphans every stored
    passkey.
- **What the browser must prove.** Every ceremony asks for user verification
  (`userVerification: 'required'`) and no attestation (`attestation: 'none'`).
  Creation also asks for a discoverable credential (`residentKey: 'required'`)
  and excludes the user's existing passkeys, so one device is not registered
  twice. The server stores the public key, the counters and a name taken from
  the authenticator's listed provider name. It never holds a private key, and
  audit metadata never carries key material or the credential ID.
- **Single-use challenges.** Each ceremony starts with an options call that
  stores a challenge in Redis for 5 minutes (`PASSKEY_CHALLENGE_TTL_MS`).
  The verify call deletes it on the first read, so a replay finds nothing. A
  challenge is bound to its purpose (`sign_in`, `create` or `step_up`), and
  the last two to the user and, for step-up, the session. A challenge
  presented to the wrong ceremony, by another user or from another session
  answers `400 PASSKEY_VERIFICATION_FAILED`.
- **Another user's passkey.** A passkey that is not the caller's answers as if
  it did not exist: rename and delete answer the passkey 404, and a step-up
  assertion by another user's credential answers `PASSKEY_VERIFICATION_FAILED`.
- **The signature counter.** A regression is refused only for a passkey that
  is not backup eligible and whose stored count is above 0. Synced passkeys
  report 0 or a count that does not advance, so refusing them would lock out
  honest users.
- **Sign-in** (`POST /auth/passkeys/sign-in/options`, `.../verify`; public, a
  per-IP limiter on each) issues a session the way a link click does: a recent
  sign-in (`auth_time` set), a refresh cookie, `lastLoggedInAt`, and a
  `user_signed_in` event with `method: 'passkey'`. The checks run in this
  order:
  1. The assertion is verified against the stored row (signature, origin, RP
     ID, user verification, user handle, counter), so a caller who cannot sign
     learns nothing about the account. An unknown credential, or one deleted
     mid-request, answers `400 PASSKEY_UNKNOWN`. A bad assertion answers
     `400 PASSKEY_VERIFICATION_FAILED`.
  2. Only then do the account checks run:
     - A deactivated, soft-deleted or never-verified account, and a non-staff
       account on Apex, answer `403 PASSKEY_NO_ACCESS` ("This passkey can't
       sign you in here. Sign in with an email link instead.") and issue no
       session.
     - On Apex, an active, verified account with no platform membership gets
       the same code and status with "This account doesn't have staff access.
       Ask a staff owner to invite you." The apps keep the passkey instead of
       deleting it.
     - The account is re-read under the row lock, as in a link sign-in.
     - In `full` maintenance `assertSignInAllowed` refuses a non-staff
       account.

  A dead credential answers 400, never 401, because the clients sign out on a 401.

- **Create, rename and delete** (`POST /auth/passkeys/registration/options`,
  `.../verify`, `PATCH` and `DELETE /auth/passkeys/:id`) need a signed-in
  user and share the `passkey-manage` limiter. Create and delete also need a
  recent sign-in (`requireRecentAuth`, which runs before the limiter, so a
  `REAUTH_REQUIRED` answer spends no budget).
  - An account holds at most 20 passkeys (`409 PASSKEY_LIMIT`).
  - An address that was never verified cannot create one
    (`403 EMAIL_UNVERIFIED`).
  - In `required` mode the last passkey cannot be deleted
    (`409 LAST_PASSKEY`).
  - Create and delete write `user.passkey_created` and `user.passkey_deleted`
    to the platform tenant's audit log, with the row id and the provider name.
    They also mail the owner a notice (`passkey_created`, `passkey_deleted`),
    so a passkey added by someone else is visible.
- **A claim drops passkeys.** When a sign-in claims a never-verified account
  ([Account creation on click](#account-creation-on-click)), the claim deletes
  every passkey on it in the same transaction, for every claim path: link,
  invitation, Google and the platform grant script. An address squatted with a
  passkey cannot keep a way in after its owner proves the mailbox. A claim
  that deletes at least one writes one `user.passkeys_cleared_on_claim` row to
  the platform tenant's audit log, in the same transaction, with only the
  `count` (no row IDs, no credential IDs).
  Passkey sign-in and step-up refuse an unverified account for the same reason.
- **Required mode.** `requireAuth` ends with `assertPasskeySetupDone`. With
  `PASSKEY_MODE=required`, an account with no passkey gets
  `403 PASSKEY_SETUP_REQUIRED` on every route outside `PASSKEY_SETUP_ALLOWED`
  (`src/constants/passkey.constants.ts`): listing and creating passkeys, the
  config read, both link confirm routes, logout, `GET /profile` and
  `GET /auth/providers`. The match is on method and the lower-cased path
  without a trailing slash or query. The count query runs only in required mode
  and only off the allowlist. A person signed in by Google has no recent
  sign-in, so they confirm it's them by link, then create a passkey. Those two
  steps are all it takes to leave the lockout.

## Email links

This section covers the links the API emails: what each token is, how long it
lives and what spends it.

Sign-in, step-up and invitation emails carry a link to a frontend page, never
to this API. The page `POST`s the token (`src/services/link-token.service.ts`),
which has two effects:

- The token never sits in an API request URL that tracing or proxy logs
  record.
- A mail scanner that follows links does not spend it.

The token does sit in the frontend page's URL (`?token=`). So the frontend's
access logs and its `Referrer-Policy` are part of this defence, and the
frontends strip `token` and `email` from every URL they report to analytics.
Which frontend a link opens is an enum (`app: 'web' | 'apex'`), never a URL, so
a request can only choose between `WEB_URL` and `APEX_URL`.

| Link               | Token                                                                      | Lifetime                   | Claimed by                                                      |
| ------------------ | -------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Sign-in            | 32 random bytes, base64url, SHA-256 stored (`user_tokens`, `sign_in_link`) | `SIGN_IN_LINK_TTL` (`15m`) | `claimLinkToken`, single use                                    |
| Step-up confirm    | The same, as `step_up_link`, bound to one user and session                 | `STEP_UP_LINK_TTL` (`15m`) | `claimLinkToken` with that binding, single use                  |
| Tenant invitation  | 32 random bytes, base64url, SHA-256 stored                                 | `INVITATION_TTL` (`3d`)    | `claimForAccept`, one `UPDATE` with the expiry in its predicate |
| Invitation confirm | The same, as `invitation_link`, naming the invitation by id                | `SIGN_IN_LINK_TTL` (`15m`) | `claimLinkToken` inside the joining transaction, single use     |

`claimLinkToken` spends a link before it judges its expiry, so presenting an
expired link also spends it: one presentation is one attempt. It matches the
purpose too, so a step-up link never signs anyone in, a sign-in link never
confirms a step-up, and neither joins an invitation.

Staff never choose a user's credential. An account staff create gets a
`welcome` email with a sign-in link. A staff-sent sign-in link
(`POST /platform/users/:id/sign-in-link`) is an ordinary sign-in link, mailed
to the account's own address.

**UTM parameters.** UTM (Urchin Tracking Module) parameters are the standard
query keys analytics tools read to attribute a visit. Every link a user
receives carries `utm_source`, `utm_medium`, `utm_campaign` and `utm_content`.
One helper adds them, `withUtm` (`src/utilities/utm.utilities.ts`), and every
link builder calls it.

- The values are code constants: the channel, the template key or
  notification type, and which link in the message was clicked. None is an
  address, a name, an id or a token.
- The helper writes only those four pairs, after the link's own query. So
  `token`, `email` and `redirect` stay byte for byte, and no parameter goes
  inside `redirect`.
- The frontends' analytics URL sanitizer keeps a `utm_*` key only while its
  value matches `/^[a-z0-9_-]{1,64}$/`, so an address or a token pasted into
  one is dropped. The server never reads them.

### Invitation links are single-use

An invitation link lives 3 days and is forwardable, so a click on it
(`POST /invitations/verify`, `verifyInvitation`,
`src/services/tenant-invitation.service.ts`) proves no mailbox and signs nobody
in.

1. Every click answers `202` "Check your inbox to finish joining." The server
   mails the invited address a 15-minute, single-use confirm link, whether the
   address has an account or not.
2. The confirm link's click (`POST /invitations/confirm`, `confirmInvitation`)
   signs in and joins in one step, creating the account for an address with
   none.

A forwarded invitation therefore gets no session, no account and no staff
role: only the invitee's mailbox receives the confirm link. Without this
split, two attacks would work:

- A session on an address with no account would outlive its owner's first
  sign-in.
- An attacker's own invitation sent to a victim would sign the victim in to the
  attacker's account.

- **The link is checked before any account is touched.**
  `findValidByTokenHash` runs first, outside a transaction, so a used, expired,
  revoked, suspended-tenant or archived-tenant link creates nothing. A confirm
  is one transaction that creates the account when the address has none, claims
  the invitation, joins, audits the join and issues the session. When two clicks
  race, the loser's transaction rolls back, the new account included, and it
  answers `404 invitation_invalid` with no cookie.
- **The `202` writes nothing.** It sets no cookie, leaves the browser's
  session alone, spends neither the invitation nor any account, and replies
  before the mail work. A second click on the invitation is the resend.
- **The confirm link carries no invitation token.** It is a `user_tokens` row
  of purpose `invitation_link` that holds the invitation's id, the address and
  the frontend (Apex for a platform invitation, web otherwise), stored as a
  SHA-256 hash like every link. A new one revokes the address's earlier confirm
  link for that invitation, never another invitation's. Deleting the
  invitation deletes its links.
- **Its mail is bounded.** At most one confirm mail per address and
  invitation per `SIGN_IN_LINK_MAIL_COOLDOWN` (default `1m`), on a cooldown of
  its own, so a sign-in request a moment earlier does not hold it, and a click
  on one workspace's invitation does not hold back another's. The daily
  budget, per address, is the one sign-in links spend (`SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT`), not the
  invitation budget, so a token holder cannot burn an admin's resends. Inside
  the cooldown, or once the budget is spent, the reply is the same `202` and
  nothing is mailed.
- **One answer on the confirm.** An unknown, used, expired or malformed link,
  an `email` that is not the link's address, an invitation revoked, accepted
  or expired since, a suspended or archived workspace and a deactivated
  account all answer `404 invitation_invalid`; the one other refusal is a
  full workspace's `402 PLAN_LIMIT_REACHED`. Each refusal spends nothing:
  the link is claimed inside the joining transaction, after the user row is
  locked, and the invitation is re-checked atomically by
  `claimForAcceptById`, so a refusal rolls the claim back. A never-verified
  account is claimed before the transaction, as a sign-in link claims one;
  that claim stands even if the join is then refused. Neither address is
  logged. The answer's message names both next steps: select Join again in
  the invitation email, or ask for a new invite.
- **The confirm session is a recent sign-in.** The confirm click proves the
  mailbox within 15 minutes with a single-use link, the proof a sign-in link
  gives. Sessions are not
  bound to an app: Apex access follows the platform role, which a staff
  invitation grants only through the confirm link.
- **Once accepted, it signs nobody in,** the invitee included. A signed-in
  invitee who opens it again goes through `POST /invitations/accept`, which
  answers `alreadyMember: true`.
- **The gates of a link sign-in.** Both routes run `assertSignInAllowed` and
  the maintenance check on the account they resolve, as `verifySignInLink`
  does. A never-verified account is claimed only by the confirm click, which
  clears the squatter's sessions and federated links.
- **Revocation.** A deactivation, a staff sign-out and a sign-out of the other
  sessions revoke the address's live confirm links with its sign-in links
  (`revokeSignInLinksOf`). Revoking or resending the invitation revokes no
  link: the confirm re-checks the invitation itself, and a resent invitation is
  the same invitation.
- **Both routes are maintenance `write`s.** In `read_only` and `full` they
  answer 503 for everyone, staff invitees included, and a link still works
  after the mode ends.
- **One answer for every click:** `POST /invitations/verify` answers `202`
  "Check your inbox to finish joining." for a customer and a staff invitation
  alike, so the reply never tells the holder of the invitation token whether
  the invited address has an account (`verifyInvitation`,
  `src/controllers/invitation.controller.ts`). Signing out everywhere revokes
  no invitation: invitations belong to the admins who sent them.
- **An Apex sign-in request from a staff invitee mails the invitation's
  confirm link,** not a sign-in link and not the invitation again, so one mail
  and one click join them. It goes only to the invited address, after the
  request's fixed `202`, and spends the request's cooldown and daily budget
  once. It shares the confirm link's per-invitation cooldown with a Join
  click, so whichever comes second mails nothing and never revokes the link
  the first one mailed. The invitation itself is untouched.

### Invitations

A user joins a customer tenant only by creating it or by accepting an
invitation. The platform tenant also admits staff by `pnpm platform:grant`
([Platform staff](#platform-staff)). An Apex sign-in request from a staff
invitee mails them the invitation's confirm link, never a sign-in link. No
route adds a registered address to a tenant directly
(`src/services/tenant-invitation.service.ts`).

- **No enumeration.** Inviting answers the same `202` whether or not the
  address has an account. The one distinct answer is `409 already_member`,
  which tells an owner or admin who is already in their own tenant. A
  workspace at its members limit answers `402 PLAN_LIMIT_REACHED` whatever the
  address: the count it reads (members and pending invitations) is one the
  inviter can list already.
- **A full workspace refuses the join, privately.** An accept, verify or
  confirm into a workspace over its members limit (after a downgrade) answers
  `402 PLAN_LIMIT_REACHED` with no `details`: the invitee is not a member, so
  the workspace's count and limit stay hidden. The check runs under the seat
  lock before the claim, so the refusal spends neither the invitation nor the
  confirm link. Two joins are never refused: a user who is already a member,
  and an owner invitation while the workspace has no active owner, so a
  workspace can always get an owner. An owner invitation to a workspace that
  has an owner is checked like any other.
- **Consent.** The confirm link was mailed to the invited address, so one click
  on it proves the mailbox
  ([Invitation links are single-use](#invitation-links-are-single-use)). A
  never-verified account is claimed as a sign-in link claims one
  ([Account creation on click](#account-creation-on-click)). Accepting signed
  in (`POST /invitations/accept`) needs a user whose verified address is the
  invited one: a different address gets `403 invitation_email_mismatch`, the
  right one unverified gets `403 invitation_email_unverified`, and nothing is
  claimed. A second accept by the same user succeeds with
  `alreadyMember: true`; anyone else's fails.
- **The token travels in bodies only.** `POST /invitations/preview`,
  `POST /invitations/verify` and `POST /invitations/accept` take it as JSON. The API answers with
  `Referrer-Policy: no-referrer`; the accept page's own header is the
  frontend's (`react-boilerplate/nginx.conf`).
- **The grant is re-checked.** Invite, resend and revoke apply
  `canActorGrantRole` to the actor's role re-read under lock, so an admin can
  neither send, resend nor revoke an owner or admin invitation. An invite that
  replaces a live invitation to the same address is a revoke: it is refused the
  same way (an expired one does not count) and audits `invitation.revoked`. Resending
  replaces the token, so the old link dies.
- **A pending invitation stands on its sender's authority.** Removing a member,
  or a member leaving, revokes the invitations they sent there; a role change
  revokes those the new role could not grant; deactivating or deleting an
  account revokes its invitations everywhere.
- **Mail volume is bounded three ways.**

  | Bound          | Limit                                                                                                                                       | Answer past it                   |
  | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
  | Per sender     | `invite-tenant-member`: 30 an hour, shared by invite and resend                                                                             | `429 RATE_LIMITED`               |
  | Per invitation | one resend per `INVITATION_RESEND_COOLDOWN` (default `10m`)                                                                                 | `429 invitation_resend_cooldown` |
  | Per recipient  | `INVITATION_RECIPIENT_DAILY_LIMIT` (default 10) invitation emails to one address in 24 hours across every tenant, at most 3 from one tenant | `429 RATE_LIMITED`               |

  The recipient ceiling (`src/services/invitation-recipient-limit.service.ts`)
  fails open when Redis does not answer.

### Mail at rest

This section covers what stored email data can reveal: failed jobs, stored
message rows, the sending domain, the delivery webhook and staff resends.

- A failed email job stays in Redis for 7 days, and a failed notification job
  for 3 days, so an operator can read why it failed. Once it will not be
  retried, every key in its stored payload that ends in `Url` or `Token`, and
  every recipient-address key, is replaced with `[redacted]`
  (`src/jobs/job-failure.job.ts`). Until then a retry needs them.
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
  signature over the raw body before reading it. For Resend that is a Svix
  HMAC-SHA256 signature (hash-based message authentication code) with a
  5-minute timestamp tolerance (`src/services/email-webhook-resend.service.ts`).
  Two limiters guard it (`src/routes/email-webhook.routes.ts`):
  - `email-webhook-rejected` counts only failed responses, 60 a minute per IP,
    which caps forged traffic from one address;
  - `email-webhook` counts only accepted ones, 3000 a minute per provider, so
    unsigned traffic cannot spend the budget a provider's bounce storm needs.
- A staff resend never replays a stored mail: it runs the action that sent it,
  which issues a fresh token under that action's own gates. A mail with no such
  action, such as a security notice, cannot be resent
  (`src/services/platform-email.service.ts`).

## Authorization

This section covers what a signed-in user may do: tenant roles, platform
staff, step-up, the audit log and purges.

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
  - Changing a member's role needs an owner on the route. Removing a member,
    inviting and reading the audit log need an owner or admin.
  - Member and invitation writes re-check the policy (`canActorModifyTarget`,
    `canActorGrantRole`) against the role re-read under lock in their own
    transaction. So a demotion mid-request cannot finish on the old role.
  - In a customer tenant only an owner acting on themself changes or removes
    an owner, and an admin cannot grant owner or admin. The platform tenant
    lets an owner act on another owner (`canPlatformActorModifyTarget`).
  - A tenant's last owner cannot leave (`409 LAST_OWNER`).
- `PATCH /profile` writes only `firstName`, `lastName` and `analyticsOptOut`;
  any other key is stripped (`src/validators/profile.validators.ts`). No
  endpoint changes a user's email.

### Platform staff

Staff are the members of one seeded tenant, the row with `is_platform = true`;
their role there is their platform role (`src/services/platform.service.ts`).

- **Gated per route, not by prefix.** Every staff route but the step-up routes
  under `/api/v1/auth/step-up` lives under `/api/v1/platform`. Each names its
  own `requirePlatformRole`, which reads the role on every request with no
  cache across requests (`src/middlewares/platform.middleware.ts`). The prefix
  secures nothing, and neither does serving Apex from its own host.
- **A refused caller sees an unknown route.** A signed-in caller the route
  refuses (non-staff, or staff below the route's role) gets exactly what an
  unknown path on the same router gets: same status, body and headers.
  - On a `/platform` route the role gate answers the app's own unknown-route
    `404` ("No route matches this method and path. Check both, then try
    again.") before the JSON gate, the step-up check and the limiter. So a
    refused caller sees no `415` and no `RateLimit-*` headers.
  - On the step-up routes the auth router's JSON gate runs first, as on every
    auth path, so a form body gets the same `415` an unknown `/auth/*` path
    gets. Then the role gate's 404 comes before the limiter.
  - Every error response is `no-store`, so no header tells the gates apart.
  - An anonymous caller can tell the step-up routes exist, since
    `requireAuth` must run before the role gate and answers 401, as on every
    `/platform` route. The route table is public anyway.
  - `cors` answers an `OPTIONS` with no `Origin` or an allowed one itself,
    with the same 204 for every path. Any other authenticated `OPTIONS` that
    reaches the platform router, and any other `OPTIONS` under
    `/auth/step-up`, gets the same 404 (`refusePlatformOptions`). Either way
    Express's automatic `Allow` answer never lists a route's methods.
- **In a customer tenant, staff act at their platform role.** With no
  membership there, `resolveTenant` uses the platform role
  (`access: 'platform'`) and audits the visit (`tenant.accessed_by_platform`,
  once an hour per staff user and tenant). The route's `requireRole` and the
  service policies apply to it as to a member's role, so a platform viewer reads
  but cannot write. Where a staff user is also a member, only the membership
  counts. The platform tenant itself is members-only.
- **Joining.** Staff join only by an invitation to the platform tenant or
  `pnpm platform:grant`; no address joins by its domain. Apex sign-in, by link
  or by Google, reaches only an existing staff account and never creates one.
- **Deleting a user never leaves a tenant ownerless.** The delete refuses
  while the user is the last live owner of a customer tenant or the last
  active platform owner. It re-counts under the owner-row locks and holds the
  user's row `FOR NO KEY UPDATE` (`deleteUser`,
  `src/services/platform-user.service.ts`).
  - Every write that makes a user an owner (creating a tenant, accepting an
    owner invitation, a role change to owner), and accepting any
    platform-tenant invitation, locks that user's row `FOR SHARE` before its
    write (`lockUserForOwnership`).
  - A grant that holds the row first commits before the delete reads on. A new
    customer tenant answers `409` at the delete's second ownership read. A new
    platform role is re-read after the user-row lock, so the staff rank rule
    (`403`) and the last-owner guard (`409`) apply to it.
  - A grant that waits finds the account gone and grants nothing (`401`, or
    `404 member_not_found` for a role change).
- **Billing.** Staff read a tenant's billing as a platform viewer
  (`/platform/tenants/:id/billing`), never with the billing email or another
  owner-only field. The reads are audited as `billing.viewed`, once per staff
  member and tenant every 10 minutes.
  - Its paged lists (`…/billing/history`, `events`, `subscriptions` and
    `invoices`) are a viewer's too. They share that audit window and bind
    their cursors to the tenant.
  - An event shows its type, outcome and error, never a provider id or
    payload. A staff invoice carries no link, since the provider's invoice
    page shows the payer's contact details.
  - A manager resyncs the tenant's billing, extends its trial and adds or
    revokes grants. An admin cancels its subscription.
  - Staff never take payment for a tenant, and never make it pay or mark it
    paying. A grant covers a complimentary plan, and it only ever adds access.
  - A staff member whose role is revoked between a cancel's provider call and
    its write is refused at the write. The provider cancel stands, no audit
    entry is written, and the next sync records it, as with an owner's cancel.
  - The platform tenant has no billing and answers `tenant_billing_not_found`.
    A grant id from another tenant answers `grant_not_found`.
- **Plans and billing settings.** Viewers read the plans and the billing
  settings. An admin previews and edits a plan, adds a price, changes the
  settings and reads the billing alerts. A plan or settings edit carries the
  version it read, and is refused `409 PLAN_VERSION_CONFLICT` when someone
  saved first. A plan edit reaches every tenant on the plan at once; a new
  price never moves a subscriber off the price it pays.
- **Tax records.** A tenant's tax records follow the same gates
  (`…/billing/tax-details`, `tax-documents`, `tax-held-charges`):
  - a viewer reads the tax details, the documents with their PDFs and the held
    charges from a Special Economic Zone (SEZ) buyer, inside the same audit
    window;
  - a manager saves the tax details under the owner's rules, with a reason;
  - an admin issues a manual credit note (for a lost dispute) and marks a held
    charge resolved.

  The credit note re-checks the admin role in the transaction that locks the
  billing row, the invoice and the number counter, so a role lowered
  mid-request writes nothing. A held charge's resolve records the staff
  member's note and issues nothing.

- **Staff writes leave a log line.** Each successful `/platform` write the role
  gate admitted logs one `Staff write` line: method, path, status, actor id and
  the target named in the path, never the body, so never a reason or an
  address. Apex's flag exposure report (`POST /platform/me/flags/exposures`) is
  telemetry and logs nothing. The audit log is the record.

### Step-up and a stated reason

`requireRecentAuth` (`src/middlewares/auth.middleware.ts`) refuses a session
that last authenticated more than `STEP_UP_MAX_AGE_MS` (10 minutes) ago with
`401 REAUTH_REQUIRED`. The time comes from the token's `auth_time`, which the
refresh row records at sign-in (a Google sign-in records none) and rotation
carries forward. A token without it counts as stale. A user moves it forward
by confirming it's them, by an emailed link or a passkey
([Confirm it's you](#confirm-its-you)); every signed-in user can. A client must
not sign out on `REAUTH_REQUIRED`.

Step-up guards:

- on `/platform`:
  - deactivating, deleting and purging a user;
  - suspending, archiving and purging a tenant;
  - re-inviting a tenant's owner;
  - changing the maintenance mode;
  - every write to a tenant's billing (resync, trial extension, a grant and
    its revocation, the staff cancel, a tax details save, a manual credit
    note, a held charge's resolve);
  - a plan edit, a new price and a billing settings change (a plan preview
    writes nothing and needs none);
  - an email resend of an invitation, which the service checks because the
    route cannot know the tenant;
- on the platform tenant's member routes: a role change, a removal, leaving, an
  invitation and a resend (`requireRecentAuthOnPlatformTenant`), since each
  changes who holds staff power;
- staff acting in a customer tenant through their platform role: a role change,
  a removal, and an invitation's send, resend or revoke
  (`requireRecentAuthAndReasonOnPlatformAccess`).

Staff actions that change an account's, a tenant's or an email's state record
why:

- deactivating, reactivating, signing out, deleting and purging a user;
- suspending, reactivating, archiving and purging a tenant, and re-inviting
  its owner;
- resending an email and lifting a suppression;
- completing an onboarding step or sending a reminder;
- resyncing a tenant's billing, extending its trial, adding or revoking a
  grant and cancelling its subscription;
- editing a plan, adding a price and changing the billing settings;
- the member and invitation writes made through platform access.

A `reason` of 1 to 500 characters of safe text (`reasonSchema`,
`src/validators/platform.validators.ts`) goes into the audit entry's metadata.
Staff acting in a customer tenant through their platform role send it in the
body or get `400 REASON_REQUIRED`, and the services check it again under the
lock.

### Confirm it's you

Any signed-in user can confirm it's them, by an emailed link or by a passkey.
Either moves the calling session's `authenticated_at` to now without minting a
session (`src/services/step-up.service.ts`), and answers a new access token
carrying the new `auth_time`. Staff need it for the guards above. A customer
needs it to create or delete a passkey.

- **By link, bound to the session.** `POST /auth/step-up/link/request` takes
  `{ app }` (`web` or `apex`; a missing or unknown value answers 400). It mails
  a link to the account's own address and answers `202` with
  `resendAvailableAt` and the link's own `expiresAt`, so the dialog states the
  time the mail states. A request for `apex` by an account with no platform role
  answers the unknown-route 404 and mails nothing. Another request by the same
  user, from any of their sessions, inside `STEP_UP_LINK_COOLDOWN` (default
  `1m`) answers `429 STEP_UP_LINK_COOLDOWN` with `Retry-After`. The
  `step_up_link` row names the user and the session (the token's `sid`) that
  asked: a new link revokes that session's earlier one, and a sign-out revokes
  it. `POST /auth/step-up/link/verify` claims it only for that user and
  session, so a bearer from another session, the same user's included, gets
  `400 LINK_INVALID` and leaves the link unspent. The confirm is one
  transaction: it locks the user row, claims the link, moves the
  `authenticated_at` of the chain the request's refresh cookie names, and audits
  `auth.step_up_confirmed { method: 'link' }`. A grace-window sibling keeps its
  old time, so a thief who replayed a token gains nothing from the owner's
  confirmation; a request with no live cookie in the session moves every row. A
  dead link writes no audit entry: it is not attributable beyond the bearer,
  and the limiter bounds it.
- **By passkey, bound to the session.** `POST /auth/passkeys/step-up/options`
  answers a challenge bound to the user and session, with the user's own
  credentials as the allowed list (`409 NO_PASSKEY` when there are none).
  `POST /auth/passkeys/step-up/verify` accepts only an assertion by one of the
  caller's credentials and applies the same counter rule as sign-in. In one
  transaction it moves `authenticated_at` on the same terms, records the use and audits
  `auth.step_up_confirmed { method: 'passkey' }`. A refusal answers
  `400 PASSKEY_VERIFICATION_FAILED`, never 401. An unverified account is
  refused. A passkey sign-in counts as a recent sign-in, so it needs no
  step-up for the next 10 minutes (`STEP_UP_MAX_AGE_MS`).
- **One audit home.** Step-up rows go to the platform tenant.
  `auth.step_up_refused` has no writer; the action stays in the schema so
  earlier rows read back.
- **No Google step-up.** Google documents no account re-authentication. It
  ignores `max_age`, and `auth_time`, when Google sends it at all, is the
  user's last Google sign-in on that browser, not a fresh one. A Google round
  trip therefore cannot prove the person is present, and an unattended,
  signed-in browser would pass it.
  - So Google stays a sign-in method only.
  - For the same reason a Google sign-in does not count as a recent sign-in:
    its session starts with `authenticated_at` NULL, so a step-up route asks
    first.
  - Audit rows with `method: 'google'` predate this rule; the API writes only
    `link` or `passkey`.

### The audit log

`audit_logs` records:

- every tenant, settings, member and invitation change, in the same
  transaction as the change;
- platform joins and grants;
- every staff action on a user, a tenant, an email or a suppression;
- each step-up;
- each passkey created or deleted, and the passkeys a claim clears;
- staff visits;
- throttled staff reads of a flag evaluation.

Each action's metadata has a strict schema (`src/constants/audit.constants.ts`).
Invitation entries keep the address's domain, never the address or the token.

**The table is append-only for application code.** A `BEFORE UPDATE OR DELETE`
trigger refuses every update and delete except the retention purge and the
owner purges. Migration `0016_platform_access.sql` creates it, and
`0017_retention.sql` and `0019_audit_redact.sql` extend its function.
`TRUNCATE` is left open on purpose, for test and operations resets.

The trigger guards against a stray statement in application code. It is not a
privilege boundary: any role that can run arbitrary SQL can set the same
transaction settings or truncate the table. So revoke `UPDATE`, `DELETE` and
`TRUNCATE` on `audit_logs` from every role but the app's.

A tenant's owners and admins read its audit log; platform owners and admins
read the platform audit log. The IP, user agent and request id are stored and
never returned.

### Purge: the only hard delete

A purge is the only hard delete of a user or a tenant
(`src/services/platform-purge.service.ts`). Deleting a user and archiving a
tenant are soft; a platform owner then purges with step-up and a reason. Each
purge is recorded in the platform tenant.

- **A user purge** removes the row and nulls their actor id, IP and user agent
  in the audit entries they acted in. It queues the deletion of their PostHog
  person with its events and recordings. Like a user delete, it clears the
  user as payer along with the billing address they gave.
- **A tenant purge** removes the tenant and its own audit entries. It is
  refused in two cases, so no card is charged for a tenant that is gone:
  - while the payment provider shows a subscription that can still charge a
    card;
  - whenever the tenant holds a subscription the provider can't be asked about
    (payments off, another account or mode, or a failed read). A purge never
    proceeds unchecked.

[ARCHITECTURE.md](ARCHITECTURE.md#analytics), under Purges and what stays in
PostHog, describes what stays there.

## Input and output

This section covers what the API accepts in a request and what it reveals in
a response or a log.

- **Validation.** Every JSON body and query goes through a zod schema
  (`parseBody`, `src/validators/parse.validators.ts`), and a failure is a 400
  with field-level `errors`. A malformed path id or invitation token answers the
  route's 404 instead, so a guess learns nothing more than a miss. Email and
  name fields are capped at their column widths, so an over-long value is a 400,
  not a Postgres 500. JSON bodies are limited to 1 MB and form bodies to 100 KB
  (`src/app.ts`). The email webhook and the collect proxy are mounted before
  those parsers: the webhook reads its raw body up to 256 KB, and the proxy
  streams bodies to PostHog unread and unbounded.
- **List cursors are signed and bound.** A list cursor carries the last row's
  sort values. A client could otherwise edit it to probe rows past a filter's
  edge, or feed seek values its schema never produced.
  - Each cursor is HMAC-SHA256 signed under `CURSOR_SECRET`. It carries a hash
    of the request's effective sort, search and filters, narrowed by
    `bindScope` to the list's name, the path tenant and the calling user
    (`src/utilities/list-cursor.utilities.ts`).
  - One `400 CURSOR_INVALID` refuses, before any query runs, a cursor that is
    empty or over 4,096 characters, or has a bad signature, another version,
    or another sort, scope, tenant, user or list. The signature compare is
    constant-time.
  - A decoded key still meets its column's schema (`sortAtField` for a
    timestamp), so a signed cursor can never reach a `::timestamptz` cast with
    text Postgres refuses.
  - Boot refuses an unset `CURSOR_SECRET` outside `local`. Rotating it sends
    every client back to its first page and has no other effect.
- **Free text.** `safeText` (`src/validators/safe-text.validators.ts`) refuses
  control characters, Unicode format characters (bidi marks and overrides,
  zero-width spaces and the like) and line and paragraph separators in every
  stored, rendered field: names, tenant fields, the maintenance message and
  reason, and every staff reason. The two joiners real scripts and emoji need
  are allowed inside a word. A name is still not an identifier: it accepts
  cross-script lookalikes, so identify an account by its id or verified address.
- **The error envelope.** `errorHandler` (`src/middlewares/error.middleware.ts`)
  decides what message a client sees:

  | Error                                        | Message shown                                                                                                            | `errorId` |
  | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- |
  | Any 5xx but the two below                    | "Our server hit an error. Try again, and email {support address} with the error ID if it happens again."                 | yes       |
  | A 5xx `HttpError` with `exposeMessage: true` | its own message, guidance written for the client (a busy billing row, a payment provider that did not answer or refused) | yes       |
  | A maintenance `503`                          | the owner's message, with `Retry-After`                                                                                  | no        |
  | Below 500, an `HttpError`                    | its own message, since it is written for the client                                                                      | no        |
  | Below 500, any other error                   | its message only when it is marked for exposure, else the status's reason phrase                                         | no        |

  An exposed 5xx is still logged and reported like any other. The
  `exposeMessage` flag goes only on literal text written in this repository,
  never on text taken from a cause, a provider or a driver. `errorId` grants
  nothing: it names a log line and an error event.

- **Logged errors lose their bound query values.** A failed query's error
  message embeds its bound parameters, which for a failed `insert into users`
  are the address and the row's other values. The logger replaces every query
  error logged as an `Error` field, through a five-deep `cause` chain, with its
  SQL text, driver code, parameter count and stack frames (`redactedForLog`,
  `src/errors/postgres-errors.ts`; `src/services/logger.service.ts`). It cannot
  redact what it does not see as an error:
  - a query-shaped value that is not an `Error` needs `redactedForLog` at the
    call site;
  - a logged `error.message` string is written as it is, so log the error
    object.
- **No stack traces to clients.** Boot refuses `NODE_ENV` other than
  `production` outside `local`, since Express's own handler sends stack traces
  otherwise (`src/configs/env-consistency.config.ts`).

## Transport and browser

This section covers the defences against other web pages acting through a
victim's browser, and the response headers.

### CSRF

A CSRF attack is another site making a victim's browser send a request that
carries the victim's credentials. There is no CSRF
middleware, by design. The access token travels in an
`Authorization` header, which a browser never attaches by itself. The one
cookie credential, the refresh cookie, is `SameSite`, so no cross-site `POST`
carries it. If a project relaxes `SameSite` further, or mounts a cookie session
on other routes, this reasoning does not cover it.

- **Forced login.** `SameSite` governs when a cookie is sent, not whether a
  cross-site response may set one. Without a gate, an attacker's page could
  auto-submit a form to `POST /auth/link/verify` with the attacker's own link
  and sign the victim into the attacker's account.
  - `requireJsonContentType` (`src/middlewares/content-type.middleware.ts`)
    refuses any content type but `application/json` with `415`. A form can
    only send the other three (`application/x-www-form-urlencoded`,
    `multipart/form-data`, `text/plain`), and JSON from a script on another
    origin needs a preflight that a disallowed origin fails.
  - It needs no configuration, so it holds on a same-origin deployment with no
    allow-list.
  - It is mounted on the whole auth router and on the writes of the tenant,
    invitation, platform and flags routers.
  - A request with no content type passes, because an untyped body is never
    parsed.
  - A link opened in the victim's own browser is the other route in; the
    address binding answers it
    ([Sign-in links](#sign-in-links-one-answer-one-reply-before-the-lookup)).
- **Same-site is not same-origin.** A page on a sibling subdomain is the same
  site, so a body-less `POST` from it carries a `Strict` cookie with no
  preflight. Four routes run `requireAllowedOriginWhenPresent`
  (`src/middlewares/origin.middleware.ts`) before their limiters:
  `POST /auth/refresh` and `POST /auth/logout`, the two routes the cookie
  authenticates, and `POST /auth/link/verify` and `POST /invitations/verify`,
  the two that set it.
  - An `Origin` that is not `WEB_URL`, `APEX_URL` or listed in
    `CORS_ALLOWED_ORIGINS` gets `403 ORIGIN_NOT_ALLOWED`, unless the browser
    marks the request `Sec-Fetch-Site: same-origin`.
  - A request with no `Origin` passes.
  - A browser without Fetch Metadata (the `Sec-Fetch-*` request headers) on an
    origin that is not configured is refused, so a deployment lists its
    frontend's origin.
  - `/auth/sessions/revoke-others` reads the cookie too, but only to narrow
    what it spares. It authenticates with the bearer token, so it needs no
    Origin check.

### CORS

`isAllowedOrigin` (`src/utilities/origin.utilities.ts`) grants exactly
`WEB_URL`'s origin, `APEX_URL`'s and each origin in `CORS_ALLOWED_ORIGINS`.
It compares by exact string equality, never a suffix or pattern.

- Responses are `credentials: true`, so the origin is never `*`
  (`src/configs/cors.config.ts`).
- A request with no `Origin` is allowed: CORS is a browser mechanism.
- A disallowed origin gets no grant header rather than an error.
- Boot refuses an opaque origin (`file:`, `data:`, an extension scheme) in
  `CORS_ALLOWED_ORIGINS`, since its origin is `null` and would grant every
  sandboxed iframe.

Every origin in `CORS_ALLOWED_ORIGINS` can drive credentialed JSON requests. So
a cross-site scripting (XSS) flaw on that frontend reaches this API as the
primary frontend does. List only origins trusted at the primary frontend's
level.

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
- No `Strict-Transport-Security`. HTTP Strict Transport Security (HSTS)
  belongs to the edge that terminates TLS (Transport Layer Security). That edge
  is the only hop that knows the response left over HTTPS, and which hosts
  `includeSubDomains` may cover. An Express server served straight over TLS
  sends none until the operator adds it.

### Behind a proxy: `TRUST_PROXY`

`TRUST_PROXY` decides `request.ip`, and so every IP-keyed limiter and the
address the analytics proxy forwards.

- Behind a proxy with it off, every client shares one bucket.
- Trusting too much lets a client name its own IP in `X-Forwarded-For` and
  escape the limiters, so boot refuses `TRUST_PROXY=true`
  (`src/configs/env.config.ts`).
- Set the number of proxies you control (`1` for a single load balancer or
  ingress in front of the API), or their addresses.
- Behind TLS termination it also decides whether express-session sees the
  request as secure. Without it the OAuth session cookie is never set and
  Google sign-in fails; boot warns about this. The refresh cookie does not
  depend on it.

## Analytics and error tracking privacy

This section covers what the API and the browsers send to PostHog, and what
they keep out.

With `POSTHOG_PROJECT_KEY` unset, no event reaches PostHog and the collect
proxy answers 503 (`src/configs/analytics.config.ts`). The deletion of purged
users and `pnpm flags:sync` use the personal API key instead. They run
whenever `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` are set.

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
  dropped. An upstream silent for 30 seconds gets a 504.
- **It is not an open relay.** It reaches only the configured PostHog hosts.
- **It serves only this deployment's project.** The assets host answers each
  project's `/array/<key>/config.js` as JavaScript, which `script-src 'self'`
  would admit from this origin. So `/array/*` for any other key answers the
  unknown-route 404. So does any path holding a dot segment or an encoded
  separator, which the upstream could normalize into another prefix.

### Server events

- **Ids, not names.** The event builder holds every rule on personally
  identifiable information (PII)
  (`src/services/analytics/analytics-event-builder.service.ts`).
  - No person names, full addresses, staff reasons or email contents go into
    an event; an address's domain may.
  - A tenant's name goes into the tenant group's properties
    (`$groupidentify`).
  - A user id `distinct_id` and a `$session_id` are pseudonymous, not
    anonymous.
  - Billing events carry ids, plans, states and amounts only, never a billing
    address, card, Virtual Payment Address (VPA, an Indian UPI payment id) or
    payer name. They name their cause `downgrade_cause` or `failure_code`,
    since `reason` is dropped.
- **The opt-out is the browser's.** `analyticsOptOut` tells the frontends to
  stop capturing; server events do not read it (`src/presenters/user.presenter.ts`).
- **Server events are signed; browser events are client-reported.** The project
  key is public, so anyone can send PostHog any event under any `distinct_id`.
  Every server event carries `server_sig`, an HMAC keyed from `SESSION_SECRET`
  (`src/services/analytics/analytics-signature.service.ts`). A reader of
  PostHog's events trusts a row's source, access and target only when it
  verifies. **Accepted risk:** PostHog's own UI shows forged events.
- **A trace id authorizes nothing.** A request's `traceparent` is the client's
  choice; a trace id only correlates.

### Error tracking: what reaches PostHog

When `POSTHOG_PROJECT_KEY` is set and `ERROR_TRACKING_ENABLED` is true (the
default), three things each send one `$exception` event: an unexpected 5xx, a
process fault and a job's final failure. The event goes from memory, not
through the outbox, because an error can arrive while the database is down
(`src/services/errors/error-reporter.service.ts`).

- **What is sent.** An error's name, message, stack frames and `cause` chain,
  the route template (never the URL), the request id, and the acting user and
  tenant. A thrown non-`Error` contributes its class name, or the first
  `Error` it holds (whose message is then sent, scrubbed), never its own keys
  or values (`src/services/errors/error-event.service.ts`).
- **What is never sent.** Request bodies, headers, query strings or cookies; a
  Postgres error's `detail`, `query`, `parameters` or `where`; a failed query's
  bound values; a job's data; an `HttpError`'s `errors`.
- **What is not reported.** Any 4xx, a client that went away, an `HttpError`
  5xx with no `cause`, and a call to PostHog's private API that PostHog could
  not answer.
- **Everything sent is scrubbed first.** `scrubText`
  (`src/services/errors/error-scrubber.service.ts`) removes:
  - email addresses, IPs and `+`-prefixed phone numbers;
  - JWTs and vendor keys;
  - URL logins, query strings and fragments;
  - Authorization and Cookie values;
  - Bearer and Basic credentials, with the unquoted or quoted `,key=value` or
    `;key=value` pairs glued to them;
  - secret-named `key=value` pairs and OAuth codes;
  - the token segment of a link path;
  - long hex and base64 runs.

  It then caps each value at 1024 characters. The span that records the
  exception gets the same scrubbed text, and so does every log record
  forwarded to Slack. The react and apex frontends hold the same file byte for
  byte (`react-boilerplate/src/observability/errors/scrub.ts`), and all three
  repositories test it against `tests/fixtures/error-scrub-vectors.json`. The
  file's own comments list what each rule catches and what it misses.

  Known gaps:
  - A `Bearer` or `Basic` glued to a letter from `g` to `z` or a `_`
    (`xBearer abc`, `_Bearer abc`) is not taken.
  - A fully URL-encoded header (`Bearer%20abc%2Crefresh%3Dxyz`) is not taken.
  - Pairs after a credential that a secret key's value took
    (`token=Bearer abc,refresh=xyz`) are kept.
  - A quoted pair value glued to more text or split by a line break is kept.

  Regex scrubbing is best-effort: keep secrets and personal data out of error
  messages.

- **`/health` and `/health/ready` are public.** `/health` names the release
  (`APP_VERSION`); a private fork that treats its commit sha as sensitive drops
  it in `src/app.ts`. `/health/ready` names which of `database`, `redis` and
  `queue` failed, never a host or driver text.

## Rate limits and abuse

This section lists the request limits, what each one defends against, and how
the counters behave when Redis fails.

### Rate limiting: one store prefix per limiter

`RATE_LIMITS` (`src/constants/rate-limit.constants.ts`) holds 33 limiter specs,
each commented with the reason for its window, budget and key.
`createRateLimiter` builds each into middleware with its own Redis key prefix
(`<REDIS_KEY_PREFIX>:rl:<name>:`, `src/middlewares/rate-limit.middleware.ts`),
so no limiter spends another's budget. Two are shared across routers on
purpose: `authenticatedWrite`, the floor every authenticated write without its
own limiter carries, and `flagExposure`. A 429 carries `code: RATE_LIMITED` and
the standard `RateLimit-*` headers. `tests/unit/routes/route-limiters.test.ts`
fails a write route with no limiter.

- **No address is a key name.** Wherever an address keys a counter (the mail
  cooldowns, and the sign-in link and invitation recipient ceilings), the key
  is `hashRateLimitIdentity`. That is HMAC-SHA256 under a key derived from
  `SESSION_SECRET` by HKDF, the HMAC-based key derivation function
  (`src/utilities/rate-limit-key.utilities.ts`). An operator cannot read an
  address off a key, and nobody without the secret can test a guess against
  one. Rotating `SESSION_SECRET` restarts those counters.
- **Counting survives a Redis outage, per process.** The store switches to Redis
  once it answers and falls back to memory for any command that fails or stalls
  (`src/configs/rate-limit-store.config.ts`). Limits are never switched off, but
  during an outage N replicas allow up to N times a limit.
- **A scale for end-to-end runs, local only.** `RATE_LIMIT_SCALE` (1 to 100,
  unset meaning 1) multiplies the limit of every limiter `createRateLimiter`
  builds from its `RATE_LIMITS` spec; windows and keys stay as they are.
  - Not scaled: an explicit override (`flag-evaluate`, through
    `FLAG_EVALUATE_REQUESTS_PER_MINUTE`), and the counters outside
    `RATE_LIMITS` (mail cooldowns, the sign-in link and invitation recipient
    ceilings, the cap on server-sent event (SSE) streams).
  - It exists because an end-to-end run sends every request from one IP and
    spends the per-IP budgets of several suites at once.
  - Boot refuses any value but 1 unless `APP_ENV` is `local`
    (`assertEnvConsistent`, `src/configs/env-consistency.config.ts`).
    `rateLimitScale` (`src/configs/env.config.ts`) answers 1 outside local
    even where that check never ran, so it can never raise a deployed limit.

The auth limiters each answer a specific threat:

- **Sign-in link request** counts by IP alone (10 in 15 minutes). A
  per-address limiter on the request would let anyone who knows an address
  deny its owner their link; the silent mail cooldown and the daily budget
  bound one inbox instead, after the reply. The budget itself can lock an
  owner out for up to 24 hours, which is accepted under
  [Sign-in links](#sign-in-links-one-answer-one-reply-before-the-lookup).
- **Sign-in link verify and invitation verify** count by IP (20 in 15 minutes
  each). A link carries 256 random bits, so they bound a client working through
  dead links, not guessing.
- **Confirm it's you** counts per user: one `step-up-link` budget shared by the
  link request and its verify (10 in 15 minutes; a normal confirm spends two),
  and one `passkey-step-up` budget shared by the passkey options and verify
  (10 in 15 minutes).
- **Passkey sign-in** counts by IP, with two budgets: `passkey-sign-in-options`
  on the options call (300 in 15 minutes; it is cheap and runs on every
  sign-in page load) and `passkey-sign-in` on the verify call (20 in 15
  minutes). The Origin check runs before the limiter, so a refused page spends
  nothing.
- **Passkey create, rename and delete** count per user: one `passkey-manage`
  budget across all four writes (20 in 15 minutes). Create and delete check
  for a recent sign-in first, so a refusal spends none of it. Listing passkeys
  has no limiter: it reads the caller's own rows.
- **Refresh and logout** are volume protection (300 in 5 minutes per IP): a
  refresh token is 256 random bits. Logout's budget is generous because a 429
  leaves the cookie uncleared.

The billing limiters guard the payment provider, whose own rate limit every
workspace shares:

| Limiter           | Key      | Budget       | Covers                                                                                                            |
| ----------------- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `billing-write`   | per user | 10 a minute  | a workspace owner's checkout, confirm, interval switch, card change and cancel                                    |
| `billing-read`    | per user | 30 a minute  | the invoice list, which reads the provider on every page (the billing read itself has no limiter)                 |
| `upgrade-request` | per user | 10 an hour   | a member's upgrade request; a request while one is open notifies no one, so the limit only bounds a script        |
| `public-plans`    | per IP   | 120 a minute | the public plan list (`GET /plans`), which needs no sign-in, carries no provider id and is cacheable for a minute |

The Razorpay webhook (`POST /webhooks/razorpay`) is public. So it verifies
Razorpay's HMAC-SHA256 signature over the raw body, against the current and
then the previous webhook secret, before it reads anything
(`src/services/billing/billing-webhook.service.ts`).

- **Two limiters guard it, both per IP.** `billing-webhook-rejected` counts
  only failed responses (30 a minute), which caps forged traffic from one
  address. `billing-webhook` counts only accepted ones (3000 a minute), so
  unsigned traffic cannot spend the budget Razorpay's deliveries need.
- **Valid bursts can see a 429.** The rejected limiter counts each request
  when it arrives and gives the count back once it succeeds. So more than 30
  valid deliveries in flight at once from one address can briefly get 429;
  Razorpay retries those.
- **A bad signature answers 401** with no detail and writes nothing.
- **No body is stored.** The route stores the event's ids, type and outcome,
  never its body, which carries the payer's address, phone and card ids.
- **Other environments' events are dropped.** An event whose subscription
  notes name another environment is acknowledged and not stored. An invoice,
  refund or dispute event, whose payload carries no such notes, is checked
  against its subscription's notes by the Worker and marked
  `other_environment` without an alert.
- **The route can be absent.** With payments off, or on the fake provider, the
  route answers the unknown-route 404 before either limiter runs.

There is no global limiter, and most authenticated reads mount no limiter.
Notification streams (SSE) are capped per process:

- `SSE_MAX_STREAMS_PER_USER` (default 5) answers `429 too_many_streams`;
- `SSE_MAX_STREAMS_TOTAL` (default 2000) answers `503 stream_capacity`;
- a stream ends when its access token expires.

## Billing

The webhook's signature check and limiters, and the billing limiters, are under
[Rate limits and abuse](#rate-limits-and-abuse); what staff can do to a
workspace's billing is under [Platform staff](#platform-staff). The rest:

- **One workspace's payment never activates another.** Every subscription
  carries the workspace id in its provider notes, set by the server at
  checkout. A checkout confirm accepts only the subscription id the row
  stored for that checkout, a valid checkout signature for it, and notes that
  name the path's workspace; anything else answers 400 `CHECKOUT_MISMATCH` and
  changes nothing (`confirmCheckout`, `src/services/billing/checkout.service.ts`).
  The sync ignores, and alerts staff about, a subscription whose notes name
  another workspace, whichever path brought it (`syncTenantBilling`).
- **The server sets the price.** A checkout names an interval; the plan, the
  amount and the provider plan come from `plan_prices`. Only the provider's
  state, read by the server, makes a workspace Paid.
- **No card data is stored.** Card entry happens in the provider's checkout.
  The database holds subscription, plan and event ids, states and
  amounts, plus the payer's user id and billing address for the owner's
  billing page. `billing_events` never stores a webhook's body, and job
  payloads carry ids only.
- **Owners pay; members ask.** Only a workspace owner by membership can start,
  confirm, switch, change the card on or cancel a subscription; staff with
  platform access cannot, and use the audited staff routes instead. A member's
  upgrade request only notifies the owners.
- **The fake provider and the dev tools stay local.** `BILLING_FAKE_PROVIDER`
  is refused outside `APP_ENV=local` and beside Razorpay keys
  ([Boot-time consistency checks](ARCHITECTURE.md#boot-time-consistency-checks)).
  `pnpm billing:seed` and `pnpm billing:time-travel` refuse to run elsewhere,
  and time travel refuses a workspace whose row names a real provider.
- **Tax details are personal data.** A buyer's legal name, address and GSTIN
  (Goods and Services Tax Identification Number) sit in `tenant_tax_details`
  and in each document's snapshot.
  - They go in no log line (ids only), no job payload (a tax job carries a
    workspace id and payment ids), no alert text, and no analytics property or
    audit metadata (field names and document types only).
  - Only the workspace's owner reads its details, documents and PDFs. A member
    gets the owner-only 403, and another workspace's document answers the
    document 404.
- **The tax export is a bulk read of that data.** It is admin only, needs
  step-up like a write, and records `billing.tax_export_downloaded` with the
  period. Every text cell of the comma-separated values (CSV) file goes
  through a formula guard (`csvCell`). A value starting with `=`, `+`, `-`,
  `@`, a tab or a carriage return gets a leading `'`, so a buyer named
  `=HYPERLINK(…)` stays text in a spreadsheet.
- **Documents are immutable.** No code path updates or deletes a
  `tax_documents` row, and a fix is a credit note, so the record an auditor
  reads is the record issued.

## Maintenance mode

Maintenance mode lets an operator stop writes (`read_only`) or stop customer
traffic (`full`) while keeping staff able to sign in and switch it off. It is
an availability control, not an access control.

Its gate (`src/middlewares/maintenance-mode.middleware.ts`) decides from each
replica's in-memory mode, by method and path (`MAINTENANCE_ROUTE_RULES`,
`src/constants/maintenance-mode.constants.ts`), before any router runs.

- In `read_only` it refuses writes outside a short allowlist.
- In `full` it refuses everything but this let-through list:
  - health;
  - the email and Razorpay webhooks;
  - the collect proxy;
  - the public status;
  - `/platform`;
  - the sign-in link routes;
  - Google sign-in;
  - the step-up routes (link and passkey);
  - the passkey sign-in routes;
  - refresh and logout;
  - `GET /auth/providers`, `GET /auth/passkeys/config` and `GET /profile`;
  - the public client settings (`GET /status/client-settings`);
  - the public plan list (`GET /plans`).

Listing, creating, renaming and deleting a passkey are customer routes:
`read_only` refuses the writes. On the routes Apex calls, `requireAuth` decides
the refusal, and it lets platform staff through.

**Accepted:** the let-through list is visible during maintenance. A route on it
reaches its router while an unknown path gets the 503. The list names only
routes the frontends already call.

- In `full`, a sign-in refuses a user with no platform role
  (`503 MAINTENANCE_MODE`) before anything is written (`assertSignInAllowed`).
  A link verify runs the check on a read-only peek of the link, so a refused
  link still works after the mode ends, and a link request for an address that
  is not staff mails nothing. In `read_only` a link click that would create an
  account answers `503 READ_ONLY_MODE` on the same peek. An invitation verify
  is a maintenance `write`, so both modes refuse it.
- A web Google callback that starts in `full` runs the same check on a
  read-only account lookup before `resolveGoogleUser`. So a non-staff Google
  sign-in that starts in `full` creates, links and claims nothing
  (`completeGoogleSignIn`, `src/services/google-auth.service.ts`).
  - The lookup matches an email only when Google verified it, as
    `resolveGoogleUser` does.
  - A profile that reaches no account cannot be staff, so it is refused too.
    Every refused web Google caller gets the same 503 after the same role read,
    whether the address is unknown, a customer's or staff's. The 503 comes
    ahead of the 400 (no email), 403 (unverified email) or 401 (a link to a
    deleted account, or an inactive account) it would otherwise get.
  - The check runs again on the resolved account. A switch to `full`, or a
    platform role revoked, while a callback is between the two checks is
    refused there, after `resolveGoogleUser` has written.
  - On Apex a profile that is not staff gets `google_auth_failed` in every
    mode.
- In `read_only` a web Google sign-in creates no account, as a link click
  does not: a profile that reaches no account answers `503 READ_ONLY_MODE` on
  the same read-only lookup, before `resolveGoogleUser`, and the creation
  re-checks the mode just before its insert. An existing account signs in
  without its Google link being written; a never-verified one is still
  claimed, as a link click claims it.
- Auth mail keeps flowing. `full` pauses every queue but `auth-email`, which
  carries the sign-in, step-up, welcome, invitation and passkey notice mail
  (`AUTH_EMAIL_TEMPLATE_KEYS`, `src/jobs/email.job.ts`), so staff can still
  sign in to switch the mode off.
- Changing the mode needs a platform owner, a recent sign-in, JSON, its own
  limiter (10 a minute), and, to switch on or escalate, a `confirm` equal to
  `APP_ENV`. A stale `expectedVersion` answers 409. The change and its audit
  entry commit together.
- The public `GET /status/maintenance` returns the mode, the customer message
  and when it began, never the internal reason or who changed it.
- The public `GET /status/client-settings` returns the lifetimes of the
  sign-in, step-up and invitation links in seconds (`SIGN_IN_LINK_TTL`,
  `STEP_UP_LINK_TTL`, `INVITATION_TTL`) and the support address
  (`SUPPORT_EMAIL`, or `support@` on `MAIL_FROM`'s domain).
  - Every value is already in the email anyone can request: the sign-in email
    states its link's lifetime, and billing email names the support address.
  - The answer is the same for every caller, so it says nothing about any
    account.
  - Knowing a lifetime does not help guess a link, which carries 256 random
    bits.
  - It counts per IP on `client-settings` (120 a minute) and is cacheable for
    5 minutes.

[ARCHITECTURE.md](ARCHITECTURE.md#maintenance-mode) describes the store, the
reload and the queue pause.

## What this boilerplate does not implement

A project that needs one of these controls builds it, or for HSTS configures
its edge. MFA is multi-factor
authentication; TOTP is a time-based one-time password from an authenticator
app; OpenAPI is the standard machine-readable format for describing an HTTP
API.

| Control                                               | Status              | What it means for you                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MFA                                                   | **Not implemented** | No TOTP, no recovery codes. Passkeys are a sign-in method and a way to confirm it's you, not a second factor.                                                                                                                                                                                                  |
| CSRF tokens                                           | **Not implemented** | By design; see [CSRF](#csrf). A deployment that splits the frontend and the API across registrable domains needs them.                                                                                                                                                                                         |
| Global rate limiting                                  | **Partial**         | 33 limiters, and every write route has one. Most authenticated reads have none.                                                                                                                                                                                                                                |
| Audit of sign-in and credential events                | **Partial**         | `audit_logs` records no sign-in or sign-out. It records a staff-sent sign-in link (`user.sign_in_link_sent`), each step-up (`auth.step_up_confirmed`) and each passkey created or deleted (`user.passkey_created`, `user.passkey_deleted`) and the passkeys a claim clears (`user.passkeys_cleared_on_claim`). |
| Session list                                          | **Not implemented** | A user can end every other session, and staff can end all of a user's, but no endpoint lists sessions.                                                                                                                                                                                                         |
| Email change and self-service account deletion        | **Not implemented** | `PATCH /profile` sets only the names and the analytics opt-out. Staff delete accounts.                                                                                                                                                                                                                         |
| Impersonation, break-glass access, row-level security | **Not implemented** | Staff act only through their platform role; tenant isolation is enforced in the application.                                                                                                                                                                                                                   |
| HSTS                                                  | **Not in the API**  | The TLS-terminating edge sends it.                                                                                                                                                                                                                                                                             |
| Uniform logout timing                                 | **Not implemented** | A logout whose cookie matches a row takes longer than one that does not. Every logout answers the same body.                                                                                                                                                                                                   |
| OpenAPI documentation and seed data                   | **Not implemented** | No spec is generated or served. No seed script; `pnpm platform:grant` grants a platform role, creating a verified account when needed.                                                                                                                                                                         |

## Reporting a vulnerability

Report a security problem privately through GitHub's private vulnerability
reporting on this repository: open the **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for a security problem.
