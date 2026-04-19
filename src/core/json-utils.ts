export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneJsonIfObject<T>(value: T): T | undefined {
  return value && typeof value === "object" ? cloneJson(value) : undefined;
}

export function isJsonRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
