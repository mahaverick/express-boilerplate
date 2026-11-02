# Skills

This directory holds project-specific agent skills: written procedures that
a coding agent such as Claude Code loads and follows. It is for anyone who
adds a skill to a project built from this boilerplate.

Each skill is one directory with one `SKILL.md`, and the directory name
matches the skill's `name` field. This boilerplate ships 0 skills on purpose.
It has no product-specific workflow for a skill to encode: no design system,
no deploy target and no domain-specific tooling. Add a skill once the project
has a repeated, multi-step procedure worth teaching an agent. Don't add one
just to have one.

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
skill's own frontmatter.

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

- **`description` is the routing key.** It is the only field the agent reads
  when it decides whether to invoke a skill. Put in it the trigger phrases
  someone would type, plus an explicit boundary ("do NOT use this for X;
  that's `<other-skill>`"). A vague description hides a skill even when it is
  the right one.
- **Add a short Fast path section** for the common case when the full
  procedure has more than a few steps. Most invocations should not need to read
  past it.
- **Prefer a shared template when one exists.** If the project maintains a
  shared skills repository with a fuller `TEMPLATE.md` and house conventions,
  start from that. This skeleton keeps this directory self-sufficient when no
  such repository is configured.

## What doesn't belong here

A one-off script, a personal alias, or anything that runs on one person's
machine only is not a skill. Put it in the relevant doc
([CONTRIBUTING.md](../../CONTRIBUTING.md) for workflow,
[CLAUDE.md](../../CLAUDE.md) for a gotcha) instead.
