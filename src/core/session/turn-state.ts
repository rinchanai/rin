import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { safeString } from "../text-utils.js";

export const SESSION_TURN_STATE_ENTRY_TYPE = "rin-turn-state";

export type SessionTurnStateStatus = "active" | "completed" | "aborted";
export type TerminalSessionTurnStateStatus = "completed" | "aborted";

export type SessionTurnState = {
  status: SessionTurnStateStatus;
  timestamp: string;
};

const VALID_TURN_STATES = new Set<SessionTurnStateStatus>([
  "active",
  "completed",
  "aborted",
]);

const TERMINAL_TURN_STATES = new Set<SessionTurnStateStatus>([
  "completed",
  "aborted",
]);

export function appendSessionTurnState(
  session: any,
  status: TerminalSessionTurnStateStatus,
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
  const latest = readSessionTurnState(sessionFile);
  return !latest || !TERMINAL_TURN_STATES.has(latest.status);
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

function appendTerminalTurnStateEntry(
  sessionFile: string,
  status: TerminalSessionTurnStateStatus,
  reason: string,
  timestamp: string,
) {
  const ids = new Set<string>();
  let parentId: string | null = null;
  try {
    const text = fs.readFileSync(sessionFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const id = safeString(entry?.id).trim();
      if (!id) continue;
      ids.add(id);
      parentId = id;
    }
  } catch {
    return;
  }

  let id = crypto.randomBytes(4).toString("hex");
  while (ids.has(id)) id = crypto.randomBytes(4).toString("hex");
  const entry = {
    type: "custom",
    customType: SESSION_TURN_STATE_ENTRY_TYPE,
    data: { status, timestamp, reason },
    id,
    parentId,
    timestamp,
  };
  fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

export function initializeTerminalTurnStateBaseline(
  sessionDir: string,
  baselineFile: string,
) {
  if (fs.existsSync(baselineFile)) return;
  const timestamp = new Date().toISOString();
  for (const sessionFile of listSessionFiles(sessionDir)) {
    if (readSessionTurnState(sessionFile)) continue;
    appendTerminalTurnStateEntry(
      sessionFile,
      "completed",
      "terminal-state-baseline",
      timestamp,
    );
  }
  try {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(
      baselineFile,
      `${JSON.stringify({ version: 1, timestamp })}\n`,
    );
  } catch {}
}
