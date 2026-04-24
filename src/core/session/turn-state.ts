import fs from "node:fs";
import path from "node:path";

import { safeString } from "../text-utils.js";

export const SESSION_TURN_STATE_ENTRY_TYPE = "rin-turn-state";

export type SessionTurnStateStatus = "active" | "completed" | "aborted";

export type SessionTurnState = {
  status: SessionTurnStateStatus;
  timestamp: string;
};

const VALID_TURN_STATES = new Set<SessionTurnStateStatus>([
  "active",
  "completed",
  "aborted",
]);

export function appendSessionTurnState(
  session: any,
  status: SessionTurnStateStatus,
) {
  if (!session?.sessionManager?.appendCustomEntry) return;
  session.sessionManager.appendCustomEntry(SESSION_TURN_STATE_ENTRY_TYPE, {
    status,
    timestamp: new Date().toISOString(),
  });
}

function normalizeTurnState(value: unknown): SessionTurnState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as any).data;
  const status = safeString(data?.status).trim() as SessionTurnStateStatus;
  if (!VALID_TURN_STATES.has(status)) return undefined;
  return {
    status,
    timestamp: safeString(data?.timestamp).trim(),
  };
}

export function readSessionTurnState(
  sessionFile: string,
): SessionTurnState | undefined {
  try {
    const text = fs.readFileSync(sessionFile, "utf8");
    let latest: SessionTurnState | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "custom") continue;
      if (entry?.customType !== SESSION_TURN_STATE_ENTRY_TYPE) continue;
      latest = normalizeTurnState(entry) ?? latest;
    }
    return latest;
  } catch {
    return undefined;
  }
}

export function shouldResumeSessionFile(sessionFile: string) {
  return readSessionTurnState(sessionFile)?.status === "active";
}

export function listSessionFiles(sessionDir: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  };
  visit(sessionDir);
  return result.sort();
}

export function listResumableSessionFiles(sessionDir: string): string[] {
  return listSessionFiles(sessionDir).filter((sessionFile) =>
    shouldResumeSessionFile(sessionFile),
  );
}
