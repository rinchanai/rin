import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensurePrivateDir(dir: string) {
  ensureDir(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode = 0o600,
  privateDir = false,
) {
  (privateDir ? ensurePrivateDir : ensureDir)(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}
