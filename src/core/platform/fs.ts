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

export function stringifyJson(value: unknown, trailingNewline = true) {
  const text = JSON.stringify(value, null, 2);
  return trailingNewline ? `${text}\n` : text;
}

export function stringifyJsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function ensureParentDir(filePath: string, privateDir = false) {
  const dir = path.dirname(filePath);
  (privateDir ? ensurePrivateDir : ensureDir)(dir);
}

export function writeJsonFile(filePath: string, value: unknown) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, stringifyJson(value), "utf8");
}

export function appendJsonLineSync(filePath: string, value: unknown) {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, stringifyJsonLine(value), "utf8");
}

export async function appendJsonLine(filePath: string, value: unknown) {
  ensureParentDir(filePath);
  await fs.promises.appendFile(filePath, stringifyJsonLine(value), "utf8");
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode = 0o600,
  privateDir = false,
) {
  ensureParentDir(filePath, privateDir);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, stringifyJson(value), { mode });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

export function listJsonFiles(dir: string) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [] as string[];
  }
}

function moveFile(sourcePath: string, targetPath: string) {
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
  }

  fs.copyFileSync(sourcePath, targetPath);
  try {
    fs.unlinkSync(sourcePath);
  } catch (error) {
    removeFileIfExists(targetPath);
    throw error;
  }
}

export function claimFileToDir(filePath: string, dir: string) {
  try {
    ensureDir(dir);
    const claimedPath = path.join(dir, path.basename(filePath));
    moveFile(filePath, claimedPath);
    return claimedPath;
  } catch {
    return "";
  }
}

export function moveFileToDir(
  filePath: string,
  dir: string,
  fileName = path.basename(filePath),
) {
  ensureDir(dir);
  const targetPath = path.join(dir, fileName);
  moveFile(filePath, targetPath);
  return targetPath;
}

export function removeFileIfExists(filePath: string) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}
