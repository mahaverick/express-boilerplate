# Skills

This directory is where project-specific agent skills go — a `SKILL.md`
per skill, one directory per skill, matching the directory name to the
skill's `name` field. None are shipped here on purpose: this boilerplate
has no product-specific workflow yet (no design system, no deploy target,
no domain-specific tooling) for a skill to encode. Add one here once this
project has a repeated, multi-step procedure worth teaching an agent —
don't add one just to have one.

A skill earns its place by being **executable by someone who wasn't
there.** If it only makes sense to the person who wrote it, it's a note to
self, not a skill.

## Layout

```
.claude/skills/
  <skill-name>/
    SKILL.md
```

`<skill-name>` must be kebab-case and must match the `name` field in the
skill's own frontmatter, or the skill won't resolve.

## `SKILL.md` skeleton

```markdown
---
name: <kebab-case, matches the directory name>
description: "<what it does>. Use when asked '<trigger phrase>', '<trigger phrase>'. <What it is NOT for / which skill to use instead.>"
argument-hint: '<arg> [optional-arg]' # omit if it takes none
---

# <skill-name>

<One paragraph: what it does and when. Lead with the single most important
fact — often a constraint or invariant that makes the rest of the
procedure make sense.>

## Arguments

## Invariants

## Prerequisites

## Procedure

### Step 1 — <first guard>

...

## Safety checklist
```

- **`description` is the routing key** — it's the only field read when
  deciding whether to invoke a skill, so put the trigger phrases someone
  would actually type in it, plus an explicit boundary ("do NOT use this
  for X; that's `<other-skill>`"). A vague description makes a skill
  invisible even when it's exactly the right one.
- Prefer a short **Fast path** section for the common case if the full
  procedure has more than a few steps — most invocations should not need
  to read past it.
- If a project maintains a shared skills repository with a fuller
  `TEMPLATE.md` and house conventions, start from that instead of this
  skeleton — this one exists so this directory is self-sufficient when no
  such repository is configured.

## What doesn't belong here

A one-off script, a personal alias, or anything that only ever runs on one
person's machine isn't a skill — put it in the relevant doc
([CONTRIBUTING.md](../../CONTRIBUTING.md) for workflow,
[CLAUDE.md](../../CLAUDE.md) for a gotcha) instead.
