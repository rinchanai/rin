export function isNonArrayObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadFirstValidCandidate<T>(
  filePaths: string[],
  readCandidate: (filePath: string) => unknown,
  normalizeCandidate: (value: unknown, filePath: string) => T | null,
) {
  for (const filePath of filePaths) {
    try {
      const candidate = normalizeCandidate(readCandidate(filePath), filePath);
      if (candidate != null) return candidate;
    } catch {}
  }
  return null;
}
