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

| Actor                                                         | Trusted with                                                                                                 | Main defences                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| An anonymous caller                                           | Nothing. It can ask for a sign-in link, sign in with one or with Google, and preview an invitation it holds. | One reply before any lookup, per-IP and per-address limits, single-use hashed links                    |
| A signed-in user                                              | Their own account, and each tenant at the role their membership grants                                       | `requireAuth` on every request, `resolveTenant` and `requireRole`, service policies re-read under lock |
| A page on another site                                        | Nothing                                                                                                      | Bearer access tokens, `SameSite` cookies, the JSON content-type gate, CORS                             |
| A page on a sibling subdomain (same site, other origin)       | Nothing                                                                                                      | The Origin check on the two routes the refresh cookie authenticates, cookie prefixes                   |
| Platform staff (members of the platform tenant)               | Reading every user and tenant; acting in customer tenants at their platform role                             | Per-route role gates answering 404, step-up, a stated reason, the audit log                            |
| Whoever holds a stolen refresh cookie or access token         | What the token grants, until it is revoked or expires                                                        | Rotation with reuse detection, an absolute session lifetime, the session denylist                      |
| An operator who can read Redis, logs, job payloads or PostHog | Operating the service, not reading tokens or addresses                                                       | Hashed tokens, keyed digests in Redis key names, redacted logs and job data, scrubbed error events     |

Out of scope: an attacker who controls the database, the Redis server, the
process environment (and so `JWT_ACCESS_SECRET` and `SESSION_SECRET`), or a
frontend origin the deployment trusts (`WEB_URL`, `APEX_URL`,
`CORS_ALLOWED_ORIGINS`). Each of those can act as the API itself.

## Authentication

### Sign-in links: one answer, one reply before the lookup

A person signs in by a single-use link mailed to their address, or by Google
([Google sign-in](#google-sign-in)).

`POST /auth/link/request` takes `{ email, app, redirect? }` and answers every
well-formed request with the same `202`, `Check your inbox for a sign-in link.`
and `data: null`. It replies before it reads anything: the controller sends the
reply, then starts the follow-up that `requestSignInLink` returns
(`src/services/sign-in-link.service.ts`), so neither the body nor the timing
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
stored one; its `email` and `redirect` are display hints the server never reads
([Email links](#email-links)).

`POST /auth/link/verify` takes `{ token, email? }` and signs in the account the
link's address holds (`verifySignInLink`):

- **Every dead link gets one answer.** An unknown, used, expired, revoked or
  malformed link, a deactivated account, an Apex link to an account that is not
  staff and a mismatched `email` all answer `400 LINK_INVALID`, `This link has
expired or was already used.` It is a 400, never a 401, because the clients
  sign out on a 401.
- **One presentation is one attempt.** The claim spends the row before its
  expiry is judged, so of two concurrent verifies of one link exactly one gets
  a session.
- **The frontend and the redirect come from the row.** Verify reads `app` and
  `redirect` from the link's `user_tokens` row, never from the request. The
  redirect passed `redirectPathSchema` (a same-origin path of at most 2048
  characters) when it was stored. An Apex link signs in only an existing staff
  account; a web link signs a staff member in to the web app.
- **The address on the page must be the link's.** This is the login CSRF
  defence. The frontends show the link's `email` param ("This link is for …"),
  and anyone who forwards a link can edit it. An attacker could send their own
  token under the victim's address, and the victim, reading their own address,
  would then work inside the attacker's account. So the client sends the
  address it shows, and verify compares it, trimmed and lowercased, with the
  row's on a read-only peek before the claim (`assertLinkShowsItsAddress`). A
  mismatch answers `LINK_INVALID` and spends nothing, so the owner's link still
  works. Neither address is logged. A client that sends no `email` skips the
  check, so a frontend sends it whenever the link carries one.
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

### Account creation on click

A web link to an address with no account creates a verified account when it is
clicked (`createLinkedAccount`, `src/services/account-claim.service.ts`): the
user row, its `email` provider row and its verification, in one transaction.
The click proves the mailbox, so a request writes no account, and an address
nobody clicks for never holds one. A `sign_in_link` row never carries a user
id: the click looks the account up by address, so a soft-deleted user's
address gets a fresh account, never the deleted one. When two clicks race on
one address, the loser's insert hits `users_email_unique`, and it signs in to
the winner's account as an existing one (`isNewUser: false`). In `read_only` a
click that would create an account answers `503 READ_ONLY_MODE` before the
claim, and a click to an existing account signs in. A web Google sign-in
follows the same rule ([Maintenance mode](#maintenance-mode)).

**A never-verified account is claimed.** An account with a null
`email_verified_at` may hold a squatter's credentials. One function takes such
an account over, `claimNeverVerifiedAccount`, and four proofs of the mailbox
call it: a sign-in link, an invitation link, `pnpm platform:grant` and an
address Google verified. The first three pass `clearSquatterCredentials`, which
deletes the account's federated links; the Google claim deletes every other
Google link and links its own. The claim revokes every session in a committed
transaction of its own, then locks the user row, runs those writes, marks the
address verified and revokes again, so a session created between the two ends
too. A claim that finds the row verified under the lock writes nothing: a
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
it without `GOOGLE_CLIENT_SECRET` (`src/configs/passport.config.ts`). The OAuth
`state` is checked against the one kept in a Redis-backed session that lasts 5
minutes and exists only on the Google routes and their callback.
`GET /auth/google` takes `app` and an optional `redirect`, which the session
keeps; a `redirect` that fails `redirectPathSchema` is dropped
(`rememberOAuthApp`). `resolveGoogleUser` (`src/services/google-auth.service.ts`)
decides the account:

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
so a browser keeps no authenticated body on disk after sign-out. Every error
response is `no-store` too: `errorHandler` marks each one it writes, the
analytics proxy marks its own 417 and 503 and the proxy library's upstream
failure answers, and `/health/ready` marks its two 503s (shutting down, not
ready). So a refusal carries the same header whichever gate answered. A
verified token with no `sid` skips the denylist and is admitted until it
expires.

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
  `src/controllers/helpers.controller.ts`). After `COOKIE_DOMAIN` is reverted to
  an earlier value the browser keeps the overwritten cookie's original creation
  time, so the other scope's cookie reads as newer and refresh fails until the
  user signs in again or the cookie expires (`REFRESH_TOKEN_TTL`).
- **Signing in again ends the presented session.** A link verify and an
  invitation verify revoke the session of the refresh cookie the request
  carries once the new session is issued, so an overwritten cookie's session
  does not stay refreshable. The Google callback does the same, but it is
  reached by a cross-site navigation, which withholds a `Strict` cookie, and
  every rotation re-sets the cookie `Strict`. So the callback usually sees no
  cookie, and the session the new cookie overwrites in the browser stays
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
presenting the same token exactly one wins, and a sign-in or step-up link can
never be redeemed as a refresh token.

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

What revokes sessions: logout, reuse, the absolute lifetime, a claim of a
never-verified account (every session;
[Account creation on click](#account-creation-on-click)),
`POST /auth/sessions/revoke-others` (every session but the caller's, 10 an hour
per user), and a staff deactivation, sign-out or deletion (every session).
Revoke-others spares only the caller's own row when the request presents the
caller's refresh cookie and that cookie is not revoked, so a grace-window
sibling in the caller's session ends too; with no such cookie it spares the
caller's whole session. A `sign_in_link` row has no user id, so these user-wide
revocations never reach one: revoke-others, a staff sign-out and a deactivation
also revoke the address's live sign-in links in their own transaction
(`revokeSignInLinksOf`, `src/services/session.service.ts`). A sign-out
(`revokeAllForSession`) revokes the session's live step-up link with its chain.

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

## Email links

Sign-in, step-up and invitation mails carry a link to a frontend page, never
to this API: the page `POST`s the token, so the token never sits in an API
request URL that tracing or proxy logs record, and a mail scanner that follows
links does not spend it (`src/services/link-token.service.ts`). The token does
sit in the frontend page's URL (`?token=`), so the frontend's access logs and
its `Referrer-Policy` are part of this defence, and the frontends strip `token`
and `email` from every URL they report to analytics. Which frontend a link
opens is an enum (`app: 'web' | 'apex'`), never a URL, so a request can only
choose between `WEB_URL` and `APEX_URL`.

| Link              | Token                                                                      | Lifetime                   | Claimed by                                                      |
| ----------------- | -------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Sign-in           | 32 random bytes, base64url, SHA-256 stored (`user_tokens`, `sign_in_link`) | `SIGN_IN_LINK_TTL` (`15m`) | `claimLinkToken`, single use                                    |
| Step-up confirm   | The same, as `step_up_link`, bound to one user and session                 | `STEP_UP_LINK_TTL` (`15m`) | `claimLinkToken` with that binding, single use                  |
| Tenant invitation | 32 random bytes, base64url, SHA-256 stored                                 | `INVITATION_TTL` (`3d`)    | `claimForAccept`, one `UPDATE` with the expiry in its predicate |

`claimLinkToken` spends a link before it judges its expiry, so presenting an
expired link also spends it: one presentation is one attempt. It matches the
purpose too, so a step-up link never signs anyone in and a sign-in link never
confirms a step-up. Staff never choose a user's credential: an account staff
create gets a `welcome` mail with a sign-in link, and a staff-sent sign-in link
(`POST /platform/users/:id/sign-in-link`) is an ordinary sign-in link, mailed
to the account's own address.

**UTM parameters.** Every link a user receives carries `utm_source`,
`utm_medium`, `utm_campaign` and `utm_content`, added by one helper, `withUtm`
(`src/utilities/utm.utilities.ts`), which every link builder calls. The values
are code constants: the channel, the template key or notification type, and
which link in the message was clicked. None is an address, a name, an id or a
token. The helper writes only those four pairs, after the link's own query, so
`token`, `email` and `redirect` stay byte for byte, and no parameter goes
inside `redirect`. The frontends' analytics URL sanitizer keeps a `utm_*` key
only while its value matches `/^[a-z0-9_-]{1,64}$/`, so an address or a token
pasted into one is dropped; the server never reads them.

### Invitation links are single-use

An invitation link is a credential for its 3-day lifetime: one click on it
signs the invitee in and joins them (`POST /invitations/verify`,
`verifyInvitation`, `src/services/tenant-invitation.service.ts`).

- **The link is checked before any account is touched.**
  `findValidByTokenHash` runs first, outside a transaction, so a used, expired,
  revoked, suspended-tenant or archived-tenant link creates nothing. One
  transaction then creates or locks the account, claims the invitation, joins,
  audits the join and issues the session. When two clicks race, the loser's
  transaction rolls back, a new account included, and it answers
  `404 invitation_invalid` with no cookie.
- **Once accepted, it signs nobody in,** the invitee included. A signed-in
  invitee who opens it again goes through `POST /invitations/accept`, which
  answers `alreadyMember: true`.
- **One answer.** A used, expired or revoked link, a suspended or archived
  tenant and a deactivated invitee all answer `404 invitation_invalid`.
- **The gates of a link sign-in.** Verify runs `assertSignInAllowed` and the
  maintenance check on the account it resolved, as `verifySignInLink` does.
- **Its session is not a recent sign-in.** Sessions are not bound to an app:
  the session is an ordinary one, and Apex access follows from the platform
  role the account holds or the invitation just granted. The session starts
  with `authenticated_at` NULL, so every `requireRecentAuth` route answers
  `401 REAUTH_REQUIRED` until the user confirms it's them, which needs the
  invitee's mailbox or Google account. A later change routes existing accounts
  and staff invitations through an emailed confirm link instead of the one
  click.
- **The route is a maintenance `write`.** In `full` it answers 503 for
  everyone, staff invitees included, and the link still works after the mode
  ends.
- **Accepted:** a forwarded invitation signs the forwardee in as the invitee
  until it is used or expires. On a platform-tenant invitation that session
  holds the staff role it grants, short of every step-up route. The link reaches only the invitee's mailbox,
  which can get a 15-minute sign-in link anyway, and single use bounds it.
  Signing out everywhere revokes no invitation: invitations belong to the
  admins who sent them.

### Invitations

A user joins a customer tenant only by creating it or by accepting an
invitation; the platform tenant also admits staff by
`pnpm platform:grant` ([Platform staff](#platform-staff)). An Apex sign-in
request from a staff invitee mails them their invitation again (outside its
resend cooldown), never a sign-in link. No route adds a
registered address to a tenant directly
(`src/services/tenant-invitation.service.ts`).

- **No enumeration.** Inviting answers the same `202` whether or not the
  address has an account. The one distinct answer is `409 already_member`,
  which tells an owner or admin who is already in their own tenant.
- **Consent.** The link was mailed to the invited address, so one click on it
  proves the mailbox
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
  every key ending in `Url` or `Token`, and every recipient-address key,
  replaced with `[redacted]` (`src/jobs/job-failure.job.ts`). Until then a retry
  needs them.
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

- **Gated per route, not by prefix.** Every staff route but the step-up routes
  under `/api/v1/auth/step-up` lives under `/api/v1/platform`, and each names
  its own `requirePlatformRole`, which reads the role on every request with no
  cache across requests (`src/middlewares/platform.middleware.ts`). The prefix
  secures nothing, and neither does serving Apex from its own host. A signed-in
  caller the route refuses (non-staff, or staff below the route's role) gets
  exactly what an unknown path on the same router gets: same status, body and
  headers. On a `/platform` route the role gate answers the app's own
  `404 Not found` before the JSON gate, the step-up check and the limiter, so a
  refused caller sees no `415` and no `RateLimit-*` headers. On the step-up
  routes the auth router's JSON gate runs first, as on every auth path, so a
  form body gets the same `415` an unknown `/auth/*` path gets; then the role
  gate's 404 comes before the limiter. Every error response is `no-store`, so
  no header tells the gates apart. An anonymous caller can tell the step-up
  routes exist, since `requireAuth` must run before the role gate and answers
  401, as on every `/platform` route; the route table is public anyway. The
  popup's `GET /auth/step-up/google` carries no bearer: it needs the intent the
  staff-only start wrote, and without one it redirects to Apex's confirm page
  with `error=step_up_failed`. `cors` answers an `OPTIONS` with no `Origin` or
  an allowed one itself, with the same 204 for every path; any other
  authenticated `OPTIONS` that reaches the platform router, and any other
  `OPTIONS` under `/auth/step-up`, gets the same 404 (`refusePlatformOptions`).
  Either way Express's automatic `Allow` answer never lists a route's methods.
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
  active platform owner, re-counting under the owner-row locks, and holds the
  user's row `FOR NO KEY UPDATE` (`deleteUser`,
  `src/services/platform-user.service.ts`). Every write that makes a user an
  owner (creating a tenant, accepting an owner invitation, a role change to
  owner), and accepting any platform-tenant invitation, locks that user's row
  `FOR SHARE` before its write (`lockUserForOwnership`). A grant that holds
  the row first commits before the delete reads on: a new customer tenant
  answers `409` at the delete's second ownership read, and a new platform role
  is re-read after the user-row lock, so the staff rank rule (`403`) and the
  last-owner guard (`409`) apply to it. A grant that waits finds the account
  gone and grants nothing (`401`, or `404 member_not_found` for a role
  change).
- **Staff writes leave a log line.** Each successful `/platform` write the role
  gate admitted logs one `Staff write` line: method, path, status, actor id and
  the target named in the path, never the body, so never a reason or an
  address. Apex's flag exposure report (`POST /platform/me/flags/exposures`) is
  telemetry and logs nothing. The audit log is the record.

### Step-up and a stated reason

`requireRecentAuth` (`src/middlewares/auth.middleware.ts`) refuses a session
that last authenticated more than `STEP_UP_MAX_AGE_MS` (10 minutes) ago with
`401 REAUTH_REQUIRED`. The time comes from the token's `auth_time`, which the
refresh row records at sign-in and rotation carries forward; a token without it
counts as stale. Staff move it forward by confirming it's them, by an emailed
link or by Google
([Step-up by link and by Google](#step-up-by-link-and-by-google)).
A client must not sign out on `REAUTH_REQUIRED`.

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

### Step-up by link and by Google

Both ways are for staff only (`requirePlatformRole('viewer')` on each route),
and both move the calling session's `authenticated_at` to now without minting a
session (`src/services/step-up.service.ts`).

- **By link, bound to the session.** `POST /auth/step-up/link/request` mails a
  link to the account's own address and answers `202` with
  `resendAvailableAt`. Another request inside `STEP_UP_LINK_COOLDOWN` (default
  `1m`) answers `429 STEP_UP_LINK_COOLDOWN` with `Retry-After`. The
  `step_up_link` row names the user and the session (the token's `sid`) that
  asked: a new link revokes that session's earlier one, and a sign-out revokes
  it. `POST /auth/step-up/link/verify` claims it only for that user and
  session, so a bearer from another session, the same user's included, gets
  `400 LINK_INVALID` and leaves the link unspent. The confirm is one
  transaction: it locks the user row, claims the link, re-checks the platform
  role, moves the session's `authenticated_at` and audits
  `auth.step_up_confirmed { method: 'link' }`, so a refusal after the claim
  rolls the claim back. A caller who lost the role since the gate gets the
  gate's 404, audited `auth.step_up_refused`. A dead link writes no audit
  entry: it is not attributable beyond the bearer, and the limiter bounds it.
  The reply is a new access token carrying the new `auth_time`.
- **By Google, a fresh login of the linked identity.** A popup carries no
  bearer, so the start takes two calls. `POST /auth/step-up/google/start`
  (bearer, staff, a linked Google account, else `409 google_not_linked`) writes
  `{ kind: 'step_up', userId, sessionId, startedAt }` into the OAuth session
  and answers `204`. The popup's `GET /auth/step-up/google` needs that intent,
  no older than the 5-minute OAuth session, and redirects to Google with
  `prompt=select_account` and `max_age=0`. The callback decodes the ID token
  without a signature check, which OIDC Core §3.1.3.7 (step 6) allows for a
  token received straight from Google's token endpoint over TLS. It checks
  `iss` (`accounts.google.com`, with or without `https://`), `aud`
  (`GOOGLE_CLIENT_ID`), `sub` against the profile, and `auth_time` no earlier
  than the start less 60 seconds of clock skew; a missing `auth_time` fails
  closed. The profile's `sub` must be the account's linked Google identity: an
  address match is not enough. On success the callback moves the session's
  `authenticated_at`, audits `auth.step_up_confirmed { method: 'google' }` and
  redirects the popup to `<apex>/auth/confirm?result=confirmed`, setting no
  cookie. Every refusal redirects to `?error=step_up_failed` and is audited
  `auth.step_up_refused { method: 'google' }`.
- **`max_age=0`, not `prompt=login`.** Google documents only `none`, `consent`
  and `select_account` for `prompt`, so the forced login comes from
  `max_age=0` and the `auth_time` check. If Google omits `auth_time`, every
  Google step-up fails closed and staff confirm by link.

### The audit log

`audit_logs` records every tenant, settings, member and invitation change in the
same transaction as the change, platform joins and grants, every staff action on
a user, a tenant, an email or a suppression, each staff step-up, staff visits,
and throttled staff reads of a flag evaluation.
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
  sort values, which a client could otherwise edit to probe rows past a
  filter's edge or feed the seek values its schema never produced. Each is
  HMAC-SHA256 signed under `CURSOR_SECRET` and carries a hash of the request's
  effective sort, search and filters, narrowed by `bindScope` to the list's name, the
  path tenant and the calling user
  (`src/utilities/list-cursor.utilities.ts`). A cursor that is empty or over
  4,096 characters, with a bad signature, another version, or another sort,
  scope, tenant, user or list is refused before any query runs, as one
  `400 CURSOR_INVALID`, and the signature compare is constant-time. A decoded
  key still meets its column's schema (`sortAtField` for a timestamp), so a
  signed cursor can never reach a `::timestamptz` cast with text Postgres
  refuses. Boot refuses an unset `CURSOR_SECRET` outside `local`; rotating it
  sends every client back to its first page and nothing else.
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
  are the address and the row's other values. The logger replaces every query error
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
  auto-submit a form to `POST /auth/link/verify` with the attacker's own link
  and sign the victim into the attacker's account. `requireJsonContentType`
  (`src/middlewares/content-type.middleware.ts`) refuses any content type but
  `application/json` with `415`: a form can only send the other three, and JSON
  from a script on another origin needs a preflight that a disallowed origin
  fails. It needs no configuration, so it holds on a same-origin deployment with
  no allow-list. It is mounted on the whole auth router and on the writes of the
  tenant, invitation, platform and flags routers. A request with no content type
  passes, because an untyped body is never parsed. A link opened in the
  victim's own browser is the other route in; the address binding answers it
  ([Sign-in links](#sign-in-links-one-answer-one-reply-before-the-lookup)).
- **Same-site is not same-origin.** A page on a sibling subdomain is the same
  site, so a body-less `POST` from it carries a `Strict` cookie with no
  preflight. `POST /auth/refresh` and `POST /auth/logout`, the two routes the
  cookie authenticates, and `POST /auth/link/verify` and
  `POST /invitations/verify`, the two that set it, run
  `requireAllowedOriginWhenPresent` (`src/middlewares/origin.middleware.ts`)
  before their limiters: an `Origin` that is not `WEB_URL`, `APEX_URL` or
  listed in `CORS_ALLOWED_ORIGINS` gets `403 ORIGIN_NOT_ALLOWED`, unless the
  browser marks the request `Sec-Fetch-Site: same-origin`. A request with no
  `Origin` passes. A browser without Fetch Metadata on an origin that is not
  configured is refused, so a deployment lists its frontend's origin.
  `/auth/sessions/revoke-others` reads the cookie too, but only to narrow what
  it spares; it authenticates with the bearer token, so it needs no Origin
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
proxy answers 503 (`src/configs/analytics.config.ts`). The deletion of purged
users and `pnpm flags:sync` use the personal API key instead, and run whenever `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`
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
  (`src/services/analytics/analytics-event-builder.service.ts`): no person
  names, full addresses, staff reasons or email contents go into an event; an
  address's domain may. A tenant's name goes into the tenant group's properties
  (`$groupidentify`). A user id `distinct_id` and a `$session_id` are
  pseudonymous, not anonymous.
- **The opt-out is the browser's.** `analyticsOptOut` tells the frontends to
  stop capturing; server events do not read it (`src/presenters/user.presenter.ts`).
- **Server events are signed; browser events are client-reported.** The project
  key is public, so anyone can send PostHog any event under any `distinct_id`.
  Every server event carries `server_sig`, an HMAC keyed from `SESSION_SECRET`
  (`src/services/analytics/analytics-signature.service.ts`), and a reader of
  PostHog's events trusts a row's source, access and target only when it
  verifies. **Accepted risk:** PostHog's own UI shows forged events. A request's `traceparent` is
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
  5xx with no `cause`, and a call to PostHog's private API that PostHog could not answer.
- **Everything sent is scrubbed first.** `scrubText`
  (`src/services/errors/error-scrubber.service.ts`) removes addresses, IPs,
  `+`-prefixed phone numbers, JWTs and vendor keys, URL logins, query strings
  and fragments, Authorization and Cookie values, Bearer and Basic credentials
  with the unquoted or quoted `,key=value` or `;key=value` pairs glued to
  them, secret-named `key=value` pairs, OAuth codes, the token segment of a
  link path, and long hex and base64 runs, then caps each value at 1024
  characters. The span that records the exception gets the same scrubbed
  text, and so does every log record forwarded to Slack. The react and apex
  frontends hold the same file byte for byte
  (`react-boilerplate/src/observability/errors/scrub.ts`), and all three test it
  against `tests/fixtures/error-scrub-vectors.json`. The file's own comments
  list what each rule catches and what it misses. Known gaps: a `Bearer` or
  `Basic` glued to a letter from `g` to `z` or a `_` (`xBearer abc`,
  `_Bearer abc`) is not taken, nor is a fully URL-encoded header
  (`Bearer%20abc%2Crefresh%3Dxyz`); pairs after a credential that a secret
  key's value took (`token=Bearer abc,refresh=xyz`) are kept, and so is a
  quoted pair value glued to more text or split by a line break. Regex
  scrubbing is best-effort: keep secrets and personal data out of error
  messages.
- **`/health` and `/health/ready` are public.** `/health` names the release
  (`APP_VERSION`); a private fork that treats its commit sha as sensitive drops
  it in `src/app.ts`. `/health/ready` names which of `database`, `redis` and
  `queue` failed, never a host or driver text.

## Rate limits and abuse

### Rate limiting: one store prefix per limiter

`RATE_LIMITS` (`src/constants/rate-limit.constants.ts`) holds 24 limiter specs,
each commented with the reason for its window, budget and key, and
`createRateLimiter` builds each into middleware with its own Redis key prefix
(`<REDIS_KEY_PREFIX>:rl:<name>:`, `src/middlewares/rate-limit.middleware.ts`),
so no limiter spends another's budget. Two are deliberately shared across
routers: `authenticatedWrite`, the floor every authenticated write without its
own limiter carries, and `flagExposure`. A 429 carries `code: RATE_LIMITED` and
the standard `RateLimit-*` headers. `tests/unit/routes/route-limiters.test.ts`
fails a write route with no limiter.

- **No address is a key name.** Wherever an address keys a counter (the mail
  cooldowns, and the sign-in link and invitation recipient ceilings) the key is
  `hashRateLimitIdentity`: HMAC-SHA256 under a key
  derived from `SESSION_SECRET` by HKDF (`src/utilities/rate-limit-key.utilities.ts`).
  An operator cannot read an address off a key, and nobody without the secret
  can test a guess against one. Rotating `SESSION_SECRET` restarts those
  counters.
- **Counting survives a Redis outage, per process.** The store switches to Redis
  once it answers and falls back to memory for any command that fails or stalls
  (`src/configs/rate-limit-store.config.ts`). Limits are never switched off, but
  during an outage N replicas allow up to N times a limit.
- **A scale for end-to-end runs, local only.** `RATE_LIMIT_SCALE` (1 to 100,
  unset meaning 1) multiplies the limit of every limiter `createRateLimiter`
  builds from its `RATE_LIMITS` spec; windows and keys stay as they are. Not
  scaled: an explicit override (`flag-evaluate`, through
  `FLAG_EVALUATE_REQUESTS_PER_MINUTE`) and the counters outside `RATE_LIMITS` (mail
  cooldowns, the sign-in link and invitation recipient ceilings, the SSE stream cap). It exists because an end-to-end run sends every request from one IP
  and spends the per-IP budgets of several suites at once. Boot refuses any
  value but 1 unless `APP_ENV` is `local` (`assertEnvConsistent`,
  `src/configs/env-consistency.config.ts`), and `rateLimitScale`
  (`src/configs/env.config.ts`) answers 1 outside local even where that check
  never ran, so it can never raise a deployed limit.

The auth limiters each answer a specific threat:

- **Sign-in link request** counts by IP alone (10 in 15 minutes). A
  per-address limiter would let anyone who knows an address deny its owner
  their link; the silent mail cooldown and the daily budget bound one inbox
  instead, after the reply.
- **Sign-in link verify and invitation verify** count by IP (20 in 15 minutes
  each). A link carries 256 random bits, so they bound a client working through
  dead links, not guessing.
- **Step-up** counts per staff member: one `step-up-link` budget shared by the
  link request and its verify (10 in 15 minutes; a normal confirm spends two),
  and `step-up-google` for the Google start (10 in 15 minutes), each of which
  writes an OAuth session to Redis.
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
`/platform`, the sign-in link routes, Google sign-in, the step-up routes,
refresh, logout, `GET /auth/providers` and `GET /profile`. On the customer
routes Apex calls, the refusal is decided in `requireAuth`, which lets platform
staff through. The let-through list is visible during maintenance: a route on
it reaches its router while an unknown path gets the 503, which is accepted,
since the list names only routes the frontends already call.

- In `full`, a sign-in refuses a user with no platform role
  (`503 MAINTENANCE_MODE`) before anything is written (`assertSignInAllowed`).
  A link verify runs the check on a read-only peek of the link, so a refused
  link still works after the mode ends, and a link request for an address that
  is not staff mails nothing. In `read_only` a link click that would create an
  account answers `503 READ_ONLY_MODE` on the same peek. An invitation verify
  is a maintenance `write`, so both modes refuse it.
- A web Google callback that starts in `full` runs the same check on a
  read-only account lookup before `resolveGoogleUser`, so a non-staff Google
  sign-in that starts in `full` creates, links and claims nothing
  (`completeGoogleSignIn`, `src/services/google-auth.service.ts`). The lookup
  matches an email only when Google verified it, as `resolveGoogleUser` does.
  A profile that reaches no account cannot be staff, so it is refused too:
  every refused web Google caller gets the same 503 after the same role read,
  whether the address is unknown, a customer's or staff's, ahead of the 400
  (no email), 403 (unverified email) or 401 (a link to a deleted account, or
  an inactive account) it would otherwise get. The check runs again on the
  resolved account: a switch to `full`, or a platform role revoked, while a
  callback is between the two checks is refused there, after
  `resolveGoogleUser` has written. On Apex a profile that is not staff gets
  `google_auth_failed` in every mode.
- In `read_only` a web Google sign-in creates no account, as a link click
  does not: a profile that reaches no account answers `503 READ_ONLY_MODE` on
  the same read-only lookup, before `resolveGoogleUser`, and the creation
  re-checks the mode just before its insert. An existing account signs in
  without its Google link being written; a never-verified one is still
  claimed, as a link click claims it.
- Auth mail keeps flowing. `full` pauses every queue but `auth-email`, which
  carries the sign-in, step-up, welcome and invitation mail
  (`AUTH_EMAIL_TEMPLATE_KEYS`, `src/jobs/email.job.ts`), so staff can still
  sign in to switch the mode off.
- Changing the mode needs a platform owner, a recent sign-in, JSON, its own
  limiter (10 a minute), and, to switch on or escalate, a `confirm` equal to
  `APP_ENV`. A stale `expectedVersion` answers 409. The change and its audit
  entry commit together.
- The public `GET /status/maintenance` returns the mode, the customer message
  and when it began, never the internal reason or who changed it.

[ARCHITECTURE.md](ARCHITECTURE.md#maintenance-mode) describes the store, the
reload and the queue pause.

## What this boilerplate does not implement

| Control                                               | Status              | What it means for you                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MFA                                                   | **Not implemented** | No TOTP, no recovery codes. The one step-up is a fresh emailed link or a fresh Google login before staff actions.                                                                       |
| CSRF tokens                                           | **Not implemented** | By design; see [CSRF](#csrf). A deployment that splits the frontend and the API across registrable domains needs them.                                                                  |
| Global rate limiting                                  | **Partial**         | 24 limiters, and every write route has one. Most authenticated reads have none.                                                                                                         |
| Audit of sign-in and credential events                | **Partial**         | `audit_logs` records no sign-in or sign-out. It records a staff-sent sign-in link (`user.sign_in_link_sent`) and each staff step-up (`auth.step_up_confirmed`, `auth.step_up_refused`). |
| Session list                                          | **Not implemented** | A user can end every other session, and staff can end all of a user's, but no endpoint lists sessions.                                                                                  |
| Email change and self-service account deletion        | **Not implemented** | `PATCH /profile` sets only the names and the analytics opt-out. Staff delete accounts.                                                                                                  |
| Impersonation, break-glass access, row-level security | **Not implemented** | Staff act only through their platform role; tenant isolation is enforced in the application.                                                                                            |
| HSTS                                                  | **Not in the API**  | The TLS-terminating edge sends it.                                                                                                                                                      |
| Uniform logout timing                                 | **Not implemented** | A logout whose cookie matches a row takes longer than one that does not. Every logout answers the same body.                                                                            |
| OpenAPI documentation and seed data                   | **Not implemented** | No spec is generated or served. No seed script; `pnpm platform:grant` grants a platform role, creating a verified account when needed.                                                  |

## Reporting a vulnerability

Report a security problem privately through GitHub's private vulnerability
reporting on this repository: open the **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for a security problem.
