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
    existingPath(agentDir, "docs", "pi", "CHANGELOG.md") ||
    existingPath(os.homedir(), ".rin", "docs", "pi", "CHANGELOG.md") ||
    path.join(agentDir, "docs", "pi", "CHANGELOG.md")
  );
}

export function parseChangelog(changelogPath: string) {
  if (!fs.existsSync(changelogPath)) return [];
  const text = fs.readFileSync(changelogPath, "utf8");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries: Array<{ heading: string; content: string }> = [];
  let currentHeading = "";
  let current: string[] = [];
  const flush = () => {
    const content = current.join("\n").trim();
    if (content) entries.push({ heading: currentHeading, content });
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
