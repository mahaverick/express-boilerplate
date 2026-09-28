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
  exists: (p: string) => boolean,
  readAnchors: (p: string) => Set<string>
): string[]
export declare function docRefProblems(
  file: string,
  text: string,
  exists: (p: string) => boolean
): string[]
