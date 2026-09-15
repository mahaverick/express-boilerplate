// src/validators/profile.validators.ts
//
// This schema is the mass-assignment boundary for `PATCH /api/v1/profile`.
// It is a plain `z.object()` — deliberately NOT `.strict()` — which means an
// unrecognised key (`email`, `id`, `passwordHash`, `active`, or anything
// else) is silently stripped from the parsed result rather than causing the
// whole request to fail. Two things drove that choice over the stricter
// alternative:
//
// 1. At the time this schema was written, `parseBody` (auth.validators.ts,
//    reused as-is here) only forwarded a zod error's per-FIELD messages
//    (`fieldErrors`) into the client-facing `errors` envelope. A `.strict()`
//    violation is a root-level "unrecognized keys" error (`formErrors`),
//    which `parseBody` had no way to surface — a client sending
//    `active: true` here would have gotten back an opaque
//    `400 { message: 'Validation failed', errors: {} }`. `parseBody` now
//    surfaces `formErrors` too (see its own header comment), so that
//    specific gap is closed — but reason 2 below still stands on its own
//    and is why this schema stays a plain allow-list rather than adopting
//    `.strict()` now that the option actually works.
// 2. Stripping is the friendlier contract for the realistic client: one
//    that fetches its own profile with `GET`, edits a name field, and PATCHes
//    the same object back wholesale (`id`, `email`, `createdAt` and all). A
//    `.strict()` schema would bounce that request entirely; this schema
//    just ignores the fields it doesn't recognise and applies the ones it
//    does — which is also the plain reading of this endpoint's contract:
//    those fields are IGNORED, not rejected.
//
// This is the same "explicit allow-list" philosophy as `toPublicUser`
// (auth.controller.ts): the schema names exactly the fields a caller may
// set, and everything else — however it got there — never reaches the
// database. `email` is deliberately not one of them: it is a verified
// identity here (`emailVerifiedAt` exists on the user row), so letting it
// change silently through this endpoint would leave a verified flag
// attached to an address nobody has verified. Re-verification on email
// change is real product work, left to the email plan (B3); until that
// exists, this endpoint simply does not move that field — a sent `email` is
// silently dropped, exactly like every other unrecognised key.
import { z } from 'zod'
import { MAX_NAME_LENGTH } from '@/constants/auth.constants'

// `.nullable().optional()` gives each field three distinguishable states in
// the parsed result, which is exactly the distinction PATCH semantics need:
//   - key absent from the request body -> parsed value is `undefined` ->
//     leave the column unchanged (see profile.controller.ts's `toUpdateValues`,
//     which checks presence with `Object.hasOwn` rather than truthiness).
//   - key present, set to `null` -> parsed value is `null` -> clear the
//     column (both `first_name`/`last_name` are nullable columns; `null` is
//     data here, not "missing").
//   - key present, set to a string -> parsed value is that (trimmed) string
//     -> set the column to it.
// An omitted field and an explicit `null` are NOT the same request, and this
// schema keeps them distinguishable all the way through — collapsing them
// would make "clear my last name" indistinguishable from "leave it alone".
const optionalNameField = z
  .string()
  .trim()
  .min(1, 'Must not be empty.')
  .max(MAX_NAME_LENGTH, `Must be at most ${MAX_NAME_LENGTH} characters.`)
  .nullable()
  .optional()

/**
 * `PATCH /api/v1/profile` request body: the only two fields this endpoint
 * lets a caller change. See this file's header comment for why `email` and
 * every other user-row column are deliberately absent rather than merely
 * unused.
 */
export const updateProfileSchema = z.object({
  firstName: optionalNameField,
  lastName: optionalNameField,
})

/**
 * The validated shape of a `PATCH /api/v1/profile` request body.
 */
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
