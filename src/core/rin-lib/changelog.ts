import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "./runtime.js";

const CHANGELOG_RELATIVE_PATH = ["docs", "pi", "CHANGELOG.md"] as const;

export function getChangelogPath() {
  const { agentDir } = resolveRuntimeProfile();
  const candidates = Array.from(
    new Set([
      path.join(agentDir, ...CHANGELOG_RELATIVE_PATH),
      path.join(os.homedir(), ".rin", ...CHANGELOG_RELATIVE_PATH),
    ]),
  );
  return candidates.find((filePath) => fs.existsSync(filePath)) || candidates[0];
}

function normalizeChangelogText(text: string) {
  return String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function parseChangelog(changelogPath: string) {
  if (!fs.existsSync(changelogPath)) return [];
  const lines = normalizeChangelogText(fs.readFileSync(changelogPath, "utf8")).split(
    "\n",
  );
  const entries: Array<{ heading: string; content: string }> = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  const flushCurrentEntry = () => {
    const heading = String(currentHeading || "").trim();
    const body = currentBody.join("\n").trim();
    if (heading && body) {
      entries.push({
        heading,
        content: `## ${heading}\n${body}`,
      });
    }
    currentBody = [];
  };

  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      flushCurrentEntry();
      currentHeading = line.replace(/^##\s+/, "").trim();
      continue;
    }
    if (!currentHeading) continue;
    currentBody.push(line);
  }

  flushCurrentEntry();
  return entries;
}
