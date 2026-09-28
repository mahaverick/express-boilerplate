// eslint-disable-next-line unicorn/name-replacements -- lint-docs.test.ts matches the module it tests, scripts/lint-docs.mjs; do not rename
import { describe, expect, it } from 'vitest'
import {
  anchors,
  // eslint-disable-next-line unicorn/name-replacements -- docRefProblems is the interface name scripts/lint-docs.mjs exports; do not rename
  docRefProblems,
  historyProblems,
  linkProblems,
  slugify,
} from '../../scripts/lint-docs.mjs'

// eslint-disable-next-line unicorn/no-useless-concat -- built by concatenation on purpose: lint:docs scans this file too, and a joined literal filename would trip its own doc-citation check
const MISSING = 'NOPE' + '.md'

describe('slugify', () => {
  it('matches GitHub anchors', () => {
    expect(slugify('Boot sequence: `index.ts` -> `server.ts` -> `app.ts`')).toBe(
      'boot-sequence-indexts---serverts---appts'
    )
    expect(slugify('No CSRF middleware — reasoning')).toBe('no-csrf-middleware--reasoning')
  })
})

describe('anchors', () => {
  it('numbers duplicates and skips fenced code', () => {
    const md = '# A\n## A\n```\n# not a heading\n```\n## B\n'
    expect([...anchors(md)]).toEqual(['a', 'a-1', 'b'])
  })
})

describe('linkProblems', () => {
  const files = new Set(['README.md', 'CLAUDE.md'])
  // eslint-disable-next-line unicorn/consistent-boolean-name -- exists is the interface name linkProblems' third parameter uses; do not rename
  const exists = (p: string): boolean => files.has(p)
  const readAnchors = (): Set<string> => new Set(['cors'])

  it('passes existing files, known anchors and external links', () => {
    const md = '[s](CLAUDE.md#cors) [w](https://x.test) [m](mailto:a@b.test) [top](#cors)'
    expect(linkProblems('README.md', md, exists, readAnchors)).toEqual([])
  })

  it('reports a missing file and a missing anchor', () => {
    const md = `[x](${MISSING}) [y](CLAUDE.md#nope)`
    expect(linkProblems('README.md', md, exists, readAnchors)).toHaveLength(2)
  })

  it('ignores links inside code', () => {
    const md = `\`[x](${MISSING})\`\n\`\`\`\n[y](${MISSING})\n\`\`\`\n`
    expect(linkProblems('README.md', md, exists, readAnchors)).toEqual([])
  })
})

describe('historyProblems', () => {
  it('flags markdown history lines', () => {
    expect(historyProblems('README.md', 'ok\nFixed in Task 6.\n', { hashComments: false })).toEqual(
      ['README.md:2: history phrasing "Task 6"']
    )
  })

  it('reads only # comments in config files', () => {
    const text = '#!/bin/sh\ncolor: "#fff"\nrun: x # stream 5 hardening\n# fine\n'
    expect(historyProblems('ci.yml', text, { hashComments: true })).toEqual([
      'ci.yml:3: history phrasing "stream 5"',
    ])
  })
})

describe('docRefProblems', () => {
  it('reports a doc file that does not exist', () => {
    expect(
      docRefProblems('a.ts', `// see CLAUDE.md and ${MISSING}`, (p) => p === 'CLAUDE.md')
    ).toEqual([`a.ts: cites ${MISSING}, which does not exist`])
  })
})
