import path from "node:path";

import { readJsonFile, writeJsonFile } from "../platform/fs.js";
import {
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "./support.js";
import { safeString } from "../text-utils.js";

const CHAT_STATE_SESSION_FILE_MIGRATION_ID = "chat-state-session-file-v1";

export type ChatStateSessionFileMigrationResult = {
  scanned: number;
  migrated: number;
  migratedFiles: string[];
};

export type ChatStateSessionFileUpgradeMigrationResult =
  ChatStateSessionFileMigrationResult & {
    id: string;
    markerPath: string;
    alreadyApplied: boolean;
    skipped: boolean;
  };

function uniqueStatePaths(paths: unknown[]) {
  return Array.from(
    new Set(
      (Array.isArray(paths) ? paths : [])
        .map((value) => safeString(value).trim())
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  );
}

function migratePreviousStateFile(statePath: string) {
  const state = readJsonFile<Record<string, unknown> | null>(statePath, null);
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  if (!Object.prototype.hasOwnProperty.call(state, "piSessionFile"))
    return false;

  const nextState: Record<string, unknown> = { ...state };
  const sessionFile = safeString(nextState.sessionFile).trim();
  const previousSessionFile = safeString(nextState.piSessionFile).trim();
  if (!sessionFile && previousSessionFile) {
    nextState.sessionFile = previousSessionFile;
  }
  delete nextState.piSessionFile;
  writeJsonFile(statePath, nextState);
  return true;
}

export function migratePreviousChatStateSessionFiles(
  agentDir: string,
): ChatStateSessionFileMigrationResult {
  const root = path.resolve(String(agentDir || "").trim() || ".");
  const statePaths = uniqueStatePaths([
    ...listChatStateFiles(path.join(root, "data", "chats")).map(
      (item) => item.statePath,
    ),
    ...listDetachedControllerStateFiles(
      path.join(root, "data", "cron-turns"),
    ).map((item) => item.statePath),
  ]);

  const migratedFiles: string[] = [];
  for (const statePath of statePaths) {
    if (!migratePreviousStateFile(statePath)) continue;
    migratedFiles.push(statePath);
  }

  return {
    scanned: statePaths.length,
    migrated: migratedFiles.length,
    migratedFiles,
  };
}

export function chatStateSessionFileMigrationMarkerPath(agentDir: string) {
  return path.join(
    path.resolve(String(agentDir || "").trim() || "."),
    "data",
    "migrations",
    `${CHAT_STATE_SESSION_FILE_MIGRATION_ID}.json`,
  );
}

export function runChatStateSessionFileUpgradeMigration(
  agentDir: string,
): ChatStateSessionFileUpgradeMigrationResult {
  const markerPath = chatStateSessionFileMigrationMarkerPath(agentDir);
  const marker = readJsonFile<Record<string, unknown> | null>(markerPath, null);
  if (
    marker &&
    safeString(marker.id || marker.migrationId).trim() ===
      CHAT_STATE_SESSION_FILE_MIGRATION_ID
  ) {
    return {
      id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: true,
      skipped: true,
      scanned: 0,
      migrated: 0,
      migratedFiles: [],
    };
  }

  const result = migratePreviousChatStateSessionFiles(agentDir);
  if (result.migrated === 0) {
    return {
      id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: false,
      skipped: true,
      ...result,
    };
  }

  writeJsonFile(markerPath, {
    id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
    appliedAt: new Date().toISOString(),
    scanned: result.scanned,
    migrated: result.migrated,
  });
  return {
    id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
    markerPath,
    alreadyApplied: false,
    skipped: false,
    ...result,
  };
}
