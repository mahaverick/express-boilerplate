#!/usr/bin/env node
/**
 * @file lint:docs — history phrasing in markdown and in # comments of config
 * files, broken relative links and anchors in markdown, and code that cites a
 * doc file that does not exist.
 */
// eslint-disable-next-line unicorn/name-replacements -- lint-docs.mjs matches this checker's pnpm script name, lint:docs; do not rename
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { findHistory } from './history-patterns.mjs'

const HASH_COMMENT_FILE =
  /(?:^|\/)(?:Dockerfile|nginx\.conf|\.env\.example)$|\.(?:ya?ml|sh|conf)$|^\.husky\/[^/]+$/
const CODE_FILE = /\.(?:[cm]?[jt]s|tsx)$/
const LINK =
  // eslint-disable-next-line sonarjs/regex-complexity, sonarjs/super-linear-regex -- the two link forms (inline and reference-style) are the contract; see lint-docs.test.ts
  /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gm
const DOC_REF = /\b([A-Z][A-Z0-9_-]*\.md)\b/g

/**
 * GitHub's anchor for a heading.
 * @param heading - Heading text without the leading #s.
 * @returns The anchor, without #.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- this script is also imported as a module by lint-docs.test.ts
export function slugify(heading) {
  return (
    heading
      .trim()
      .toLowerCase()
      // eslint-disable-next-line unicorn/prefer-string-replace-all, sonarjs/super-linear-regex -- a single run of non-">" characters; not superlinear in practice, see lint-docs.test.ts
      .replace(/<[^>]+>/g, '')
      .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
      .replaceAll(/\s/g, '-')
  )
}

/**
 * Every anchor a markdown file defines, duplicates numbered the way GitHub does.
 * @param markdown - File contents.
 * @returns Anchors without #.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- this script is also imported as a module by lint-docs.test.ts
export function anchors(markdown) {
  const seen = new Map()
  const found = new Set()
  let isInFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      isInFence = !isInFence
      continue
    }
    // eslint-disable-next-line unicorn/no-null, sonarjs/super-linear-regex -- exec()'s own no-match return is null; the heading pattern is a single bounded run per anchor, see lint-docs.test.ts
    const heading = isInFence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) continue
    const base = slugify(heading[1])
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    found.add(count === 0 ? base : `${base}-${count}`)
  }
  return found
}

/**
 * @param line - One line of a config file.
 * @returns The text of its # comment, or null when it has none.
 */
function hashComment(line) {
  const match = /(?:^|\s)#(?!!)(.*)$/.exec(line)
  // eslint-disable-next-line unicorn/no-null -- null is the documented return type for "no comment"; see lint-docs.d.mts
  return match ? match[1] : null
}

/**
 * History phrasing, line by line.
 * @param file - Path for the report.
 * @param text - File contents.
 * @param root0 - Options.
 * @param root0.hashComments - When true, only # comments are read.
 * @returns One problem per offending line.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- this script is also imported as a module by lint-docs.test.ts
export function historyProblems(file, text, { hashComments }) {
  const problems = []
  for (const [index, line] of text.split('\n').entries()) {
    const prose = hashComments ? hashComment(line) : line
    // eslint-disable-next-line unicorn/no-null -- a hash-comment-free line has no prose to check, not a match
    const match = prose === null ? null : findHistory(prose)
    if (match) problems.push(`${file}:${index + 1}: history phrasing "${match}"`)
  }
  return problems
}

/**
 * Relative links and anchors that do not resolve.
 * @param file - Repo-relative path of the markdown file.
 * @param text - Its contents.
 * @param exists - Whether a repo-relative path exists.
 * @param readAnchors - Anchors of a repo-relative markdown file.
 * @returns One problem per broken link.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- this script is also imported as a module by lint-docs.test.ts
export function linkProblems(file, text, exists, readAnchors) {
  const prose = text.replaceAll(/```[\s\S]*?```/g, '').replaceAll(/`[^`\n]*`/g, '')
  const problems = []
  for (const match of prose.matchAll(LINK)) {
    const target = match[1] ?? match[2]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const [rawPath, anchor] = target.split('#', 2)
    const resolved = rawPath
      ? path.posix.normalize(
          path.posix.join(path.posix.dirname(file), decodeURIComponent(rawPath).replace(/^\//, ''))
        )
      : file
    if (!exists(resolved)) {
      problems.push(`${file}: links to ${target}, and ${resolved} does not exist`)
    } else if (
      anchor &&
      resolved.endsWith('.md') &&
      !readAnchors(resolved).has(anchor.toLowerCase())
    ) {
      problems.push(`${file}: links to ${target}, and ${resolved} has no #${anchor}`)
    }
  }
  return problems
}

/**
 * Doc files cited in code that do not exist at the repo root.
 * @param file - Path for the report.
 * @param text - File contents.
 * @param exists - Whether a repo-relative path exists.
 * @returns One problem per missing doc.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts, unicorn/name-replacements -- docRefProblems is the interface name lint-docs.test.ts imports; this script is also imported as a module
export function docRefProblems(file, text, exists) {
  const missing = new Set()
  for (const match of text.matchAll(DOC_REF)) if (!exists(match[1])) missing.add(match[1])
  return [...missing].map((documentPath) => `${file}: cites ${documentPath}, which does not exist`)
}

/**
 * Whether a repo-relative path exists on disk.
 * @param repoRelativePath - Path relative to the repo root.
 * @returns Whether it exists.
 */
function pathExists(repoRelativePath) {
  return fs.existsSync(repoRelativePath)
}

/**
 * Check every tracked and untracked, non-ignored file in the current repo.
 */
function main() {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a required project dependency (husky, CI) resolved the same way as every other pnpm script's tooling
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && fs.existsSync(file))
  const cache = new Map()
  const readAnchors = (repoRelativePath) => {
    if (!cache.has(repoRelativePath)) {
      cache.set(repoRelativePath, anchors(fs.readFileSync(repoRelativePath, 'utf8')))
    }
    return cache.get(repoRelativePath)
  }
  const problems = []
  for (const file of files) {
    if (file.endsWith('.md')) {
      const text = fs.readFileSync(file, 'utf8')
      if (path.basename(file) !== 'CHANGELOG.md') {
        problems.push(...historyProblems(file, text, { hashComments: false }))
      }
      problems.push(...linkProblems(file, text, pathExists, readAnchors))
    } else if (HASH_COMMENT_FILE.test(file)) {
      problems.push(...historyProblems(file, fs.readFileSync(file, 'utf8'), { hashComments: true }))
    } else if (CODE_FILE.test(file)) {
      problems.push(...docRefProblems(file, fs.readFileSync(file, 'utf8'), pathExists))
    }
  }
  if (problems.length > 0) {
    // eslint-disable-next-line no-restricted-properties -- lint:docs is a CLI script, not application code; its report is meant for a terminal, not the pino logger
    console.error(problems.join('\n'))
    // eslint-disable-next-line no-restricted-properties -- see above
    console.error(`lint:docs: ${problems.length} problem(s)`)
    process.exit(1)
  }
  // eslint-disable-next-line no-restricted-properties -- see above
  console.log('lint:docs: OK')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
