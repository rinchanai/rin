import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "./runtime.js";

function existingPath(...parts: string[]) {
  const filePath = path.join(...parts);
  return fs.existsSync(filePath) ? filePath : undefined;
}

function changelogPathCandidates(agentDir: string) {
  const homeAgentDir = path.join(os.homedir(), ".rin");
  return [
    path.join(agentDir, "docs", "pi", "CHANGELOG.md"),
    path.join(homeAgentDir, "docs", "pi", "CHANGELOG.md"),
  ].filter((item, index, list) => list.indexOf(item) === index);
}

export function getChangelogPath() {
  const { agentDir } = resolveRuntimeProfile();
  const candidates = changelogPathCandidates(agentDir);
  return candidates.find((filePath) => fs.existsSync(filePath)) || candidates[0];
}

function normalizeChangelogText(text: string) {
  return String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function formatChangelogEntry(heading: string, lines: string[]) {
  const normalizedHeading = String(heading || "").trim();
  const body = lines.join("\n").trim();
  if (!normalizedHeading || !body) return null;
  return {
    heading: normalizedHeading,
    content: `## ${normalizedHeading}\n${body}`,
  };
}

export function parseChangelog(changelogPath: string) {
  if (!fs.existsSync(changelogPath)) return [];
  const lines = normalizeChangelogText(fs.readFileSync(changelogPath, "utf8")).split(
    "\n",
  );
  const entries: Array<{ heading: string; content: string }> = [];
  let currentHeading = "";
  let currentBody: string[] = [];
  const flush = () => {
    const entry = formatChangelogEntry(currentHeading, currentBody);
    if (entry) entries.push(entry);
    currentBody = [];
  };
  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      flush();
      currentHeading = line.replace(/^##\s+/, "").trim();
      continue;
    }
    if (!currentHeading) continue;
    currentBody.push(line);
  }
  flush();
  return entries;
}
