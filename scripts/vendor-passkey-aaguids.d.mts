export declare const MAX_ICON_LENGTH: number
export declare function dedupeAaguids(
  combined: Record<string, { name: string; icon_light?: string; icon_dark?: string }>,
  source: { repo: string; commit: string; fetchedAt: string }
): {
  source: { repo: string; commit: string; fetchedAt: string }
  icons: string[]
  entries: Record<string, { name: string; light: number | null; dark: number | null }>
}
