// eslint-disable-next-line unicorn/name-replacements -- lint-docs.d.mts mirrors lint-docs.mjs, named for the pnpm lint:docs script; do not rename
export declare function slugify(heading: string): string
export declare function anchors(markdown: string): Set<string>
export declare function historyProblems(
  file: string,
  text: string,
  options: { hashComments: boolean }
): string[]
export declare function linkProblems(
  file: string,
  text: string,
  // eslint-disable-next-line unicorn/consistent-boolean-name -- exists is the interface name lint-docs.mjs and lint-docs.test.ts share; do not rename
  exists: (p: string) => boolean,
  readAnchors: (p: string) => Set<string>
): string[]
// eslint-disable-next-line unicorn/name-replacements -- docRefProblems is the interface name lint-docs.mjs exports and lint-docs.test.ts imports; do not rename
export declare function docRefProblems(
  file: string,
  text: string,
  // eslint-disable-next-line unicorn/consistent-boolean-name -- exists is the interface name lint-docs.mjs and lint-docs.test.ts share; do not rename
  exists: (p: string) => boolean
): string[]
