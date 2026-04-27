import fs from "node:fs";
import path from "node:path";

import { safeString } from "../text-utils.js";

export const SESSION_TURN_STATE_ENTRY_TYPE = "rin-turn-state";

export type SessionTurnStateStatus = "active" | "completed" | "aborted";
export type TerminalSessionTurnStateStatus = "completed" | "aborted";

export type SessionTurnState = {
  status: SessionTurnStateStatus;
  timestamp: string;
  reason?: string;
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
  const reason = safeString(data?.reason).trim();
  return {
    status,
    timestamp: safeString(data?.timestamp).trim(),
    ...(reason ? { reason } : {}),
  };
}

function isTurnStartEntry(entry: any) {
  if (entry?.type === "custom_message") return true;
  if (entry?.type === "branch_summary") return true;
  if (entry?.type !== "message") return false;
  const role = entry?.message?.role;
  return role === "user" || role === "bashExecution";
}

function forEachSessionFileEntry(
  sessionFile: string,
  visitor: (entry: any) => void,
): boolean {
  try {
    const text = fs.readFileSync(sessionFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        visitor(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function readSessionTurnStateDetails(sessionFile: string):
  | {
      latest?: SessionTurnState;
      hasTurnStartAfterLatestState: boolean;
    }
  | undefined {
  let latest: SessionTurnState | undefined;
  let hasTurnStartAfterLatestState = false;
  if (
    !forEachSessionFileEntry(sessionFile, (entry) => {
      if (
        entry?.type === "custom" &&
        entry?.customType === SESSION_TURN_STATE_ENTRY_TYPE
      ) {
        latest = normalizeTurnState(entry) ?? latest;
        hasTurnStartAfterLatestState = false;
        return;
      }
      if (isTurnStartEntry(entry)) hasTurnStartAfterLatestState = true;
    })
  ) {
    return undefined;
  }
  return { latest, hasTurnStartAfterLatestState };
}

export function readSessionTurnState(
  sessionFile: string,
): SessionTurnState | undefined {
  return readSessionTurnStateDetails(sessionFile)?.latest;
}

export function shouldResumeInterruptedTurn(
  sessionFile: string,
  options?: { terminalBaselineTimestamp?: string },
) {
  const details = readSessionTurnStateDetails(sessionFile);
  const latest = details?.latest;
  if (!latest || isTerminalBaselineState(latest)) {
    if (latest && !details.hasTurnStartAfterLatestState) {
      return !isTerminalLegacyTailSessionFile(sessionFile, {
        ignoreTerminalBaseline: true,
      });
    }
    const baselineTimestamp = safeString(
      options?.terminalBaselineTimestamp,
    ).trim();
    if (!baselineTimestamp) return true;
    return !isTerminalLegacyTailSessionFile(sessionFile);
  }
  if (details.hasTurnStartAfterLatestState) return true;
  return !TERMINAL_TURN_STATES.has(latest.status);
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

export function listInterruptedTurnSessionFiles(
  sessionDir: string,
  options?: { terminalBaselineTimestamp?: string },
): string[] {
  return listSessionFiles(sessionDir).filter((sessionFile) =>
    shouldResumeInterruptedTurn(sessionFile, options),
  );
}

function hasToolCallContent(content: unknown) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    return (
      safeString((part as any).type)
        .trim()
        .toLowerCase() === "toolcall"
    );
  });
}

function isTerminalLegacyTailEntry(entry: any) {
  if (entry?.type !== "message") return false;
  const message = entry?.message;
  const role = safeString(message?.role).trim();
  if (role !== "assistant") return false;
  return !hasToolCallContent(message?.content);
}

function isTerminalBaselineState(state: SessionTurnState | undefined) {
  return state?.reason === "terminal-state-baseline";
}

function isTerminalBaselineEntry(entry: any) {
  return (
    entry?.type === "custom" &&
    entry?.customType === SESSION_TURN_STATE_ENTRY_TYPE &&
    safeString(entry?.data?.reason).trim() === "terminal-state-baseline"
  );
}

function readLastSessionFileEntry(
  sessionFile: string,
  options?: { ignoreTerminalBaseline?: boolean },
) {
  let lastEntry: any;
  if (
    !forEachSessionFileEntry(sessionFile, (entry) => {
      if (options?.ignoreTerminalBaseline && isTerminalBaselineEntry(entry)) {
        return;
      }
      lastEntry = entry;
    })
  ) {
    return undefined;
  }
  return lastEntry;
}

function isTerminalLegacyTailSessionFile(
  sessionFile: string,
  options?: { ignoreTerminalBaseline?: boolean },
) {
  return isTerminalLegacyTailEntry(
    readLastSessionFileEntry(sessionFile, options),
  );
}

function readTerminalBaselineTimestamp(baselineFile: string) {
  try {
    const line = fs.readFileSync(baselineFile, "utf8").split(/\r?\n/, 1)[0];
    const timestamp = safeString(JSON.parse(line)?.timestamp).trim();
    return timestamp || undefined;
  } catch {
    return undefined;
  }
}

export function initializeTerminalTurnStateBaseline(
  sessionDir: string,
  baselineFile: string,
) {
  const existingTimestamp = readTerminalBaselineTimestamp(baselineFile);
  if (existingTimestamp) return existingTimestamp;
  const timestamp = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(
      baselineFile,
      `${JSON.stringify({ version: 1, timestamp, sessionDir })}\n`,
    );
  } catch {}
  return timestamp;
}
