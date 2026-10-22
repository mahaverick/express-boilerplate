export declare function checkTestServices(
  env: Record<string, string | undefined>,
  timeoutMs?: number
): Promise<{ ok: true } | { ok: false; down: string[] }>
