import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "./runtime.js";

function existingPath(...parts: string[]) {
  const filePath = path.join(...parts);
  return fs.existsSync(filePath) ? filePath : undefined;
}

export function getChangelogPath() {
  const { agentDir } = resolveRuntimeProfile();
  return (
    existingPath(agentDir, "docs", "rin", "CHANGELOG.md") ||
    existingPath(os.homedir(), ".rin", "docs", "rin", "CHANGELOG.md") ||
    path.join(agentDir, "docs", "rin", "CHANGELOG.md")
  );
}

export function parseVersionText(value: unknown) {
  const match = String(value || "")
    .trim()
    .match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: String(match[4] || "").trim(),
  };
}

export function compareParsedVersions(
  left?: ReturnType<typeof parseVersionText>,
  right?: ReturnType<typeof parseVersionText>,
) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function compareVersionText(left: string, right: string) {
  return compareParsedVersions(parseVersionText(left), parseVersionText(right));
}

export function parseChangelog(changelogPath: string) {
  if (!fs.existsSync(changelogPath)) return [];
  const text = fs.readFileSync(changelogPath, "utf8");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries: Array<{ heading: string; content: string; version?: string }> = [];
  let currentHeading = "";
  let current: string[] = [];
  const flush = () => {
    const content = current.join("\n").trim();
    if (content) {
      const heading = currentHeading;
      const versionMatch = heading.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      entries.push({
        heading,
        content,
        version: versionMatch?.[1],
      });
    }
    current = [];
  };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      currentHeading = line.replace(/^##\s+/, "").trim();
      current.push(line);
      continue;
    }
    if (!currentHeading) continue;
    current.push(line);
  }
  flush();
  return entries;
}

export function getNewerChangelogEntries(
  entries: Array<{ heading: string; content: string; version?: string }>,
  lastVersion: string,
  currentVersion?: string,
) {
  const before = parseVersionText(lastVersion);
  const after = parseVersionText(currentVersion || "");
  return entries.filter((entry) => {
    const entryVersion = parseVersionText(entry.version || entry.heading);
    if (!entryVersion) return false;
    if (compareParsedVersions(entryVersion, before) <= 0) return false;
    if (after && compareParsedVersions(entryVersion, after) > 0) return false;
    return true;
  });
}
