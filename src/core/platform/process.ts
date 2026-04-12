export function safeString(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

export function isPidAlive(pid: unknown): boolean {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
