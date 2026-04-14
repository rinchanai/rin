import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import {
  normalizeNeedle,
  safeString,
  sha,
  trimText,
  uniqueStrings,
} from "./utils.js";

type Database = BetterSqlite3.Database;

type IndexedTranscriptEntry = {
  rowKey: string;
  archivePath: string;
  sessionKey: string;
  entry: TranscriptArchiveEntry;
  timestampMs: number;
  preview: string;
  lineNumber: number;
};

type IndexedSessionBucket = {
  sessionKey: string;
  sessionId: string;
  sessionFile: string;
  bestScore: number;
  totalScore: number;
  hitCount: number;
  latestHitTimestampMs: number;
  messages: TranscriptResultMessage[];
};

type TranscriptFileState = {
  archivePath: string;
  mtimeMs: number;
  size: number;
};

export type TranscriptArchiveEntry = {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionFile: string;
  role: string;
  text: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  customType?: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  display?: boolean;
  archiveLine?: number;
  archivePath?: string;
};

export type TranscriptResultMessage = {
  id: string;
  role: string;
  timestamp: string;
  line: number;
  text: string;
  toolName?: string;
};

export type TranscriptSessionResult = {
  sourceType: "session";
  id: string;
  name: string;
  score: number;
  path: string;
  sessionId: string;
  sessionFile: string;
  timestamp: string;
  description: string;
  preview: string;
  role: string;
  summary?: string;
  hitCount?: number;
  messages?: TranscriptResultMessage[];
};

const SEARCH_DB_SCHEMA_VERSION = 2;
const DEFAULT_RESULT_LIMIT = 8;
const RAW_SEARCH_LIMIT = 50;
const MAX_MATCHED_ENTRIES_PER_SESSION = 3;

function resolveMemoryRoot(rootOverride = ""): string {
  return safeString(rootOverride).trim()
    ? path.join(path.resolve(rootOverride), "memory")
    : path.join(
        process.env.PI_CODING_AGENT_DIR ||
          process.env.RIN_DIR ||
          path.join(process.env.HOME || "", ".rin"),
        "memory",
      );
}

export function resolveTranscriptRoot(rootOverride = ""): string {
  return path.join(resolveMemoryRoot(rootOverride), "transcripts");
}

function resolveTranscriptSearchDbPath(rootOverride = ""): string {
  return path.join(resolveMemoryRoot(rootOverride), "search.db");
}

function transcriptSessionBasename(input: Record<string, unknown>): string {
  const sessionId = safeString(input.sessionId || "").trim();
  if (sessionId) return `${sessionId}.jsonl`;
  const sessionFile = safeString(input.sessionFile || "").trim();
  if (sessionFile) return `${sha(sessionFile).slice(0, 16)}.jsonl`;
  return "unknown-session.jsonl";
}

function transcriptDateParts(input: Record<string, unknown>): {
  year: string;
  month: string;
} {
  const raw = safeString(input.timestamp || "").trim();
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return {
      year: String(now.getUTCFullYear()),
      month: String(now.getUTCMonth() + 1).padStart(2, "0"),
    };
  }
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
  };
}

export function getTranscriptArchivePath(
  input: Record<string, unknown> | string = "",
  rootOverride = "",
): string {
  const root = resolveTranscriptRoot(rootOverride);
  if (typeof input === "string") {
    const key = safeString(input).trim();
    if (!key) return path.join(root, "unknown", "unknown-session.jsonl");
    if (
      key.endsWith(".jsonl") &&
      (key.includes("/") || key.includes(path.sep))
    ) {
      return path.join(root, key);
    }
    if (key.includes(path.sep) || key.includes("/")) {
      return path.join(root, "unknown", `${sha(key).slice(0, 16)}.jsonl`);
    }
    return path.join(root, "unknown", `${key}.jsonl`);
  }
  const { year, month } = transcriptDateParts(input);
  return path.join(root, year, month, transcriptSessionBasename(input));
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function normalizeInlineValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizePart(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  if (value.type === "text") return safeString(value.text || "");
  if (value.type === "thinking") return safeString(value.thinking || "");
  if (value.type === "toolCall") {
    const name = safeString(value.name || value.toolName || "tool").trim() || "tool";
    const args = normalizeInlineValue(value.args || value.arguments || "");
    return args ? `[tool:${name}] ${args}` : `[tool:${name}]`;
  }
  if (value.type === "image") {
    const mimeType = safeString(value.mimeType || "image").trim() || "image";
    return `[image:${mimeType}]`;
  }
  if (value.type === "file") {
    const name =
      safeString(value.name || value.path || value.url || "file").trim() ||
      "file";
    return `[file:${name}]`;
  }
  return "";
}

function extractTranscriptText(input: Record<string, unknown>): string {
  const role = safeString(input.role || "").trim();
  const content = input.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => summarizePart(part)).filter(Boolean).join("\n").trim();
  }
  if (role === "bashExecution") {
    const command = safeString(input.command || "").trim();
    const output = safeString(input.output || "").trim();
    return [command ? `[bash] ${command}` : "", output].filter(Boolean).join("\n\n").trim();
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return safeString(input.summary || "").trim();
  }
  return safeString(input.text || "").trim();
}

export async function appendTranscriptArchiveEntry(
  input: Record<string, unknown>,
  rootOverride = "",
) {
  const role = safeString(input.role || "").trim();
  if (!role) return;
  const text = extractTranscriptText(input);
  if (!text) return;
  const entry: TranscriptArchiveEntry = {
    id:
      safeString(input.id || "").trim() ||
      sha(
        [
          safeString(input.timestamp || "").trim(),
          safeString(input.sessionId || "").trim(),
          role,
          text,
          safeString(input.toolCallId || "").trim(),
          safeString(input.toolName || "").trim(),
        ].join("\n"),
      ).slice(0, 16),
    timestamp: safeString(input.timestamp || new Date().toISOString()).trim(),
    sessionId: safeString(input.sessionId || "").trim(),
    sessionFile: safeString(input.sessionFile || "").trim(),
    role,
    text,
    content: input.content,
    toolName: safeString(input.toolName || "").trim() || undefined,
    toolCallId: safeString(input.toolCallId || "").trim() || undefined,
    customType: safeString(input.customType || "").trim() || undefined,
    stopReason: safeString(input.stopReason || "").trim() || undefined,
    errorMessage: safeString(input.errorMessage || "").trim() || undefined,
    provider: safeString(input.provider || "").trim() || undefined,
    model: safeString(input.model || "").trim() || undefined,
    display: typeof input.display === "boolean" ? input.display : undefined,
  };
  const filePath = getTranscriptArchivePath(entry, rootOverride);
  await ensureParentDir(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
  try {
    const stat = await fs.stat(filePath);
    const db = openTranscriptSearchDb(rootOverride);
    try {
      appendIndexedArchiveEntry(db, {
        archivePath: filePath,
        mtimeMs: Math.trunc(stat.mtimeMs),
        size: stat.size,
      }, entry);
    } finally {
      db.close();
    }
  } catch {}
}

async function loadTranscriptArchiveFile(filePath: string) {
  if (!fssync.existsSync(filePath)) return [] as TranscriptArchiveEntry[];
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/g)
    .map((line, index) => ({ rawLine: line.trim(), lineNumber: index + 1 }))
    .filter((item) => Boolean(item.rawLine))
    .map((item) => {
      try {
        const parsed = JSON.parse(item.rawLine) as TranscriptArchiveEntry;
        if (!parsed?.text) {
          parsed.text = extractTranscriptText(parsed as Record<string, unknown>);
        }
        parsed.archiveLine = item.lineNumber;
        parsed.archivePath = filePath;
        return parsed;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TranscriptArchiveEntry => Boolean(entry?.text));
}

async function collectTranscriptFiles(dir: string): Promise<string[]> {
  if (!fssync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTranscriptFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

export async function loadTranscriptArchiveEntries(
  rootOverride = "",
): Promise<TranscriptArchiveEntry[]> {
  const root = resolveTranscriptRoot(rootOverride);
  const files = await collectTranscriptFiles(root);
  const groups = await Promise.all(
    files.map((filePath) => loadTranscriptArchiveFile(filePath)),
  );
  return groups.flat();
}

function timestampValue(value: string): number {
  const parsed = Date.parse(safeString(value).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function transcriptPreviewText(entry: TranscriptArchiveEntry) {
  const label = entry.toolName
    ? `[${entry.role}:${entry.toolName}]`
    : entry.customType
      ? `[${entry.role}:${entry.customType}]`
      : `[${entry.role}]`;
  return `${label} ${safeString(entry.text || "").trim()}`.trim();
}

function sessionPreviewPriority(entry: TranscriptArchiveEntry) {
  const text = safeString(entry.text || "").trim();
  let score = 0;
  if (entry.role === "assistant") score += 30;
  if (entry.role === "user") score += 20;
  if (entry.role === "toolResult") score += 12;
  if (entry.role === "bashExecution") score += 10;
  if (entry.role === "custom") score += 8;
  if (entry.toolName) score += 18;
  if (entry.toolCallId) score += 8;
  if (text.includes("[tool:")) score += 12;
  if (text.includes("[bash]")) score += 10;
  if (text.includes("http://") || text.includes("https://")) score += 4;
  if (text.includes("/") || text.includes("\\")) score += 3;
  if (text.length >= 24) score += 3;
  if (!text) score -= 100;
  return score;
}

function chooseSessionPreviewEntry(entries: TranscriptArchiveEntry[]) {
  return [...entries].sort((a, b) => {
    const priority = sessionPreviewPriority(b) - sessionPreviewPriority(a);
    if (priority) return priority;
    return timestampValue(b.timestamp) - timestampValue(a.timestamp);
  })[0];
}

function buildSessionPreview(entries: TranscriptArchiveEntry[]) {
  const ranked = [...entries].sort((a, b) => {
    const priority = sessionPreviewPriority(b) - sessionPreviewPriority(a);
    if (priority) return priority;
    return timestampValue(b.timestamp) - timestampValue(a.timestamp);
  });
  const topScore = ranked.length ? sessionPreviewPriority(ranked[0]) : 0;
  const chosen = ranked
    .filter((entry, index) => index === 0 || sessionPreviewPriority(entry) >= topScore - 8)
    .slice(0, 2)
    .map((entry) => transcriptPreviewText(entry));
  return trimText(chosen.join("\n"), 240);
}

function sessionGroupingKey(input: {
  sessionFile?: string;
  sessionId?: string;
  id?: string;
}) {
  return (
    safeString(input.sessionFile || "").trim() ||
    safeString(input.sessionId || "").trim() ||
    safeString(input.id || "").trim()
  );
}

function formatTranscriptMessageText(value: string, max = 240) {
  return trimText(
    safeString(value)
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

function buildResultMessage(entry: TranscriptArchiveEntry): TranscriptResultMessage {
  return {
    id: entry.id,
    role: entry.role,
    timestamp: entry.timestamp,
    line: Math.max(1, Number(entry.archiveLine || 0) || 1),
    text: formatTranscriptMessageText(entry.text),
    toolName: safeString(entry.toolName || "").trim() || undefined,
  };
}

function chooseSessionMessageEntries(entries: TranscriptArchiveEntry[]) {
  return [...entries]
    .sort((a, b) => {
      const priority = sessionPreviewPriority(b) - sessionPreviewPriority(a);
      if (priority) return priority;
      return timestampValue(b.timestamp) - timestampValue(a.timestamp);
    })
    .slice(0, MAX_MATCHED_ENTRIES_PER_SESSION);
}

function presentSessionResult(
  entries: TranscriptArchiveEntry[],
  score: number,
  rootOverride = "",
  extra: {
    hitCount?: number;
    messages?: TranscriptResultMessage[];
  } = {},
): TranscriptSessionResult {
  const previewEntry = chooseSessionPreviewEntry(entries);
  const latestEntry = [...entries].sort(
    (a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp),
  )[0];
  const preview = buildSessionPreview(entries);
  return {
    sourceType: "session",
    id:
      safeString(
        previewEntry?.sessionId || previewEntry?.sessionFile || previewEntry?.id,
      ).trim() || previewEntry.id,
    name: "session",
    role: previewEntry.role,
    score,
    path:
      safeString(previewEntry.archivePath || "").trim() ||
      getTranscriptArchivePath(previewEntry, rootOverride),
    sessionId: previewEntry.sessionId,
    sessionFile: previewEntry.sessionFile,
    timestamp: latestEntry?.timestamp || previewEntry.timestamp,
    description: trimText(preview, 160),
    preview,
    hitCount: extra.hitCount,
    messages:
      extra.messages && extra.messages.length
        ? extra.messages
        : chooseSessionMessageEntries(entries).map((entry) => buildResultMessage(entry)),
  };
}

function buildStructuredTokens(value: string): string[] {
  const raw = safeString(value).toLowerCase().trim();
  if (!raw) return [];
  const primary = raw
    .split(/[^a-z0-9_./:#@-]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  const expanded: string[] = [];
  for (const token of primary) {
    expanded.push(token);
    if (/[./:#@_-]/.test(token)) {
      expanded.push(
        ...token
          .split(/[./:#@_-]+/g)
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }
  }
  return uniqueStrings(
    expanded.filter((token) => token.length >= 2 || /\d/.test(token)),
  );
}

function createCjkTrigrams(value: string): string[] {
  const chars = [...safeString(value).replace(/\s+/g, "")].filter((char) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
  );
  const out: string[] = [];
  for (let index = 0; index < chars.length - 2; index += 1) {
    out.push(`${chars[index]}${chars[index + 1]}${chars[index + 2]}`);
  }
  return uniqueStrings(out);
}

function escapeFtsPhrase(value: string): string {
  return safeString(value).replace(/"/g, '""');
}

function buildTokenFtsQuery(value: string): string {
  const raw = safeString(value).trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  const compact = normalized.replace(/\s+/g, " ").trim();
  const structured = buildStructuredTokens(normalized);
  const terms = uniqueStrings([
    ...structured,
    ...(compact.length >= 2 ? [compact] : []),
    ...(compact.length >= 2 && !compact.includes(" ") ? [compact.replace(/['`]/g, "")] : []),
  ]);
  return terms.length
    ? terms.map((term) => `"${escapeFtsPhrase(term)}"`).join(" OR ")
    : "";
}

function buildTrigramFtsQuery(value: string): string {
  const raw = safeString(value).trim();
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, " ").trim();
  const terms = uniqueStrings([
    ...createCjkTrigrams(compact),
    ...buildStructuredTokens(compact).filter((token) => token.length >= 3),
    ...(compact.replace(/\s+/g, "").length >= 3 ? [compact] : []),
  ]);
  return terms.length
    ? terms.map((term) => `"${escapeFtsPhrase(term)}"`).join(" OR ")
    : "";
}

function escapeLike(value: string): string {
  return safeString(value).replace(/([%_\\])/g, "\\$1");
}

function initializeTranscriptSearchDb(db: Database, busyTimeoutMs = 5000) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_state (
      archive_path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      row_key TEXT PRIMARY KEY,
      archive_path TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_file TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      line_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      custom_type TEXT NOT NULL,
      text TEXT NOT NULL,
      preview TEXT NOT NULL,
      entry_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entries_archive_path ON entries(archive_path);
    CREATE INDEX IF NOT EXISTS idx_entries_session_key_ts ON entries(session_key, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_session_id_ts ON entries(session_id, timestamp_ms DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_token USING fts5(
      row_key UNINDEXED,
      session_id,
      session_file,
      role,
      tool_name,
      custom_type,
      text,
      tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./:#@'"
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_trigram USING fts5(
      row_key UNINDEXED,
      session_id,
      session_file,
      role,
      tool_name,
      custom_type,
      text,
      tokenize = 'trigram'
    );
  `);
  db.prepare(
    "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
  ).run("schema_version", String(SEARCH_DB_SCHEMA_VERSION));
}

function isRebuildableTranscriptSearchDbError(error: unknown): boolean {
  const code = String((error as any)?.code || "").trim();
  const message = String((error as any)?.message || error || "").toLowerCase();
  return code === "SQLITE_NOTADB" || message.includes("file is not a database");
}

function isSqliteBusyError(error: unknown): boolean {
  const code = String((error as any)?.code || "").trim();
  const message = String((error as any)?.message || error || "").toLowerCase();
  return code === "SQLITE_BUSY" || message.includes("database is locked");
}

function openTranscriptSearchDb(
  rootOverride = "",
  allowReset = true,
  busyTimeoutMs = 5000,
): Database {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const parent = path.dirname(dbPath);
  if (!fssync.existsSync(parent)) fssync.mkdirSync(parent, { recursive: true });

  let db: Database | undefined;
  try {
    db = new BetterSqlite3(dbPath);
    const metadataExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
      )
      .get() as { name?: string } | undefined;
    if (metadataExists) {
      const versionRow = db
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get("schema_version") as { value?: string } | undefined;
      const version = Number(versionRow?.value || 0);
      if (version !== SEARCH_DB_SCHEMA_VERSION) {
        db.close();
        if (fssync.existsSync(dbPath)) fssync.unlinkSync(dbPath);
        db = new BetterSqlite3(dbPath);
      }
    }

    initializeTranscriptSearchDb(db, busyTimeoutMs);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {}
    if (allowReset && isRebuildableTranscriptSearchDbError(error)) {
      try {
        if (fssync.existsSync(dbPath)) fssync.unlinkSync(dbPath);
      } catch {}
      return openTranscriptSearchDb(rootOverride, false, busyTimeoutMs);
    }
    throw error;
  }
}

function toIndexedEntry(
  entry: TranscriptArchiveEntry,
  archivePath: string,
  rowIndex: number,
): IndexedTranscriptEntry {
  const lineNumber = Math.max(1, Number(entry.archiveLine || rowIndex + 1) || rowIndex + 1);
  const rowKey = sha(
    [
      archivePath,
      String(lineNumber),
      safeString(entry.id || "").trim(),
      safeString(entry.timestamp || "").trim(),
      safeString(entry.role || "").trim(),
      safeString(entry.toolCallId || "").trim(),
      safeString(entry.toolName || "").trim(),
    ].join("\n"),
  );
  return {
    rowKey,
    archivePath,
    sessionKey: sessionGroupingKey(entry),
    entry,
    timestampMs: timestampValue(entry.timestamp),
    preview: trimText(transcriptPreviewText(entry), 240),
    lineNumber,
  };
}

function removeIndexedArchiveEntries(db: Database, archivePath: string) {
  const existing = db
    .prepare("SELECT row_key FROM entries WHERE archive_path = ?")
    .all(archivePath) as Array<{ row_key: string }>;
  const deleteToken = db.prepare("DELETE FROM entries_fts_token WHERE row_key = ?");
  const deleteTrigram = db.prepare("DELETE FROM entries_fts_trigram WHERE row_key = ?");
  for (const row of existing) {
    deleteToken.run(row.row_key);
    deleteTrigram.run(row.row_key);
  }
  db.prepare("DELETE FROM entries WHERE archive_path = ?").run(archivePath);
  db.prepare("DELETE FROM file_state WHERE archive_path = ?").run(archivePath);
}

function insertIndexedEntry(db: Database, item: IndexedTranscriptEntry) {
  db.prepare(`
    INSERT INTO entries(
      row_key, archive_path, entry_id, session_key, session_id, session_file,
      timestamp, timestamp_ms, line_number, role, tool_name, custom_type, text, preview, entry_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.rowKey,
    item.archivePath,
    item.entry.id,
    item.sessionKey,
    safeString(item.entry.sessionId || "").trim(),
    safeString(item.entry.sessionFile || "").trim(),
    safeString(item.entry.timestamp || "").trim(),
    item.timestampMs,
    item.lineNumber,
    safeString(item.entry.role || "").trim(),
    safeString(item.entry.toolName || "").trim(),
    safeString(item.entry.customType || "").trim(),
    safeString(item.entry.text || "").trim(),
    item.preview,
    JSON.stringify(item.entry),
  );
  db.prepare(`
    INSERT INTO entries_fts_token(
      row_key, session_id, session_file, role, tool_name, custom_type, text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.rowKey,
    safeString(item.entry.sessionId || "").trim(),
    safeString(item.entry.sessionFile || "").trim(),
    safeString(item.entry.role || "").trim(),
    safeString(item.entry.toolName || "").trim(),
    safeString(item.entry.customType || "").trim(),
    safeString(item.entry.text || "").trim(),
  );
  db.prepare(`
    INSERT INTO entries_fts_trigram(
      row_key, session_id, session_file, role, tool_name, custom_type, text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.rowKey,
    safeString(item.entry.sessionId || "").trim(),
    safeString(item.entry.sessionFile || "").trim(),
    safeString(item.entry.role || "").trim(),
    safeString(item.entry.toolName || "").trim(),
    safeString(item.entry.customType || "").trim(),
    safeString(item.entry.text || "").trim(),
  );
}

function replaceIndexedArchiveEntries(
  db: Database,
  state: TranscriptFileState,
  entries: TranscriptArchiveEntry[],
) {
  const indexedEntries = entries.map((entry, index) =>
    toIndexedEntry(entry, state.archivePath, index),
  );
  const tx = db.transaction(() => {
    removeIndexedArchiveEntries(db, state.archivePath);
    for (const item of indexedEntries) insertIndexedEntry(db, item);
    db.prepare(
      "INSERT OR REPLACE INTO file_state(archive_path, mtime_ms, size) VALUES (?, ?, ?)",
    ).run(state.archivePath, state.mtimeMs, state.size);
  });
  tx();
}

function appendIndexedArchiveEntry(
  db: Database,
  state: TranscriptFileState,
  entry: TranscriptArchiveEntry,
) {
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT MAX(line_number) AS max_line_number FROM entries WHERE archive_path = ?")
      .get(state.archivePath) as { max_line_number?: number } | undefined;
    const nextIndex = Math.max(0, Number(row?.max_line_number || 0));
    const item = toIndexedEntry(entry, state.archivePath, nextIndex);
    insertIndexedEntry(db, item);
    db.prepare(
      "INSERT OR REPLACE INTO file_state(archive_path, mtime_ms, size) VALUES (?, ?, ?)",
    ).run(state.archivePath, state.mtimeMs, state.size);
  });
  tx();
}

async function syncTranscriptSearchIndex(db: Database, rootOverride = "") {
  const transcriptRoot = resolveTranscriptRoot(rootOverride);
  const files = await collectTranscriptFiles(transcriptRoot);
  const actualStates = new Map<string, TranscriptFileState>();
  for (const archivePath of files) {
    const stat = await fs.stat(archivePath);
    actualStates.set(archivePath, {
      archivePath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      size: stat.size,
    });
  }

  const indexedStates = new Map(
    (
      db.prepare("SELECT archive_path, mtime_ms, size FROM file_state").all() as Array<{
        archive_path: string;
        mtime_ms: number;
        size: number;
      }>
    ).map((row) => [
      row.archive_path,
      { archivePath: row.archive_path, mtimeMs: row.mtime_ms, size: row.size },
    ]),
  );

  const deleteTx = db.transaction((paths: string[]) => {
    for (const archivePath of paths) removeIndexedArchiveEntries(db, archivePath);
  });
  const deletedPaths = [...indexedStates.keys()].filter(
    (archivePath) => !actualStates.has(archivePath),
  );
  if (deletedPaths.length) deleteTx(deletedPaths);

  const refreshStates = [...actualStates.values()].filter((state) => {
    const indexed = indexedStates.get(state.archivePath);
    return !indexed || indexed.mtimeMs !== state.mtimeMs || indexed.size !== state.size;
  });

  for (const state of refreshStates) {
    const entries = await loadTranscriptArchiveFile(state.archivePath);
    replaceIndexedArchiveEntries(db, state, entries);
  }
}

export async function repairTranscriptSearchIndex(rootOverride = "") {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const transcriptRoot = resolveTranscriptRoot(rootOverride);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      try {
        if (fssync.existsSync(dbPath)) fssync.unlinkSync(dbPath);
      } catch {}
      const db = openTranscriptSearchDb(rootOverride, false, 60_000);
      try {
        await syncTranscriptSearchIndex(db, rootOverride);
        const fileCountRow = db
          .prepare("SELECT COUNT(*) AS count FROM file_state")
          .get() as { count?: number } | undefined;
        const entryCountRow = db
          .prepare("SELECT COUNT(*) AS count FROM entries")
          .get() as { count?: number } | undefined;
        return {
          dbPath,
          transcriptRoot,
          fileCount: Number(fileCountRow?.count || 0),
          entryCount: Number(entryCountRow?.count || 0),
        };
      } finally {
        db.close();
      }
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  return { dbPath, transcriptRoot, fileCount: 0, entryCount: 0 };
}

async function withTranscriptSearchDb<T>(
  rootOverride: string,
  fn: (db: Database) => T | Promise<T>,
): Promise<T> {
  const db = openTranscriptSearchDb(rootOverride);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function rowToEntry(row: {
  entry_json: string;
  line_number?: number;
  archive_path?: string;
}): TranscriptArchiveEntry | null {
  try {
    const entry = JSON.parse(row.entry_json) as TranscriptArchiveEntry;
    if (!entry?.text) return null;
    if (Number.isFinite(Number(row.line_number))) {
      entry.archiveLine = Math.max(1, Number(row.line_number));
    }
    if (row.archive_path) {
      entry.archivePath = safeString(row.archive_path).trim() || undefined;
    }
    return entry;
  } catch {
    return null;
  }
}

function loadSessionEntriesByKey(db: Database, sessionKey: string): TranscriptArchiveEntry[] {
  const rows = db
    .prepare(
      `
      SELECT entry_json, line_number, archive_path
      FROM entries
      WHERE session_key = ?
      ORDER BY timestamp_ms ASC, line_number ASC, row_key ASC
    `,
    )
    .all(sessionKey) as Array<{
      entry_json: string;
      line_number: number;
      archive_path: string;
    }>;
  return rows.map((row) => rowToEntry(row)).filter(Boolean) as TranscriptArchiveEntry[];
}

export async function loadTranscriptSessionEntries(
  params: { sessionId?: string; sessionFile?: string; path?: string } = {},
  rootOverride = "",
): Promise<TranscriptArchiveEntry[]> {
  const sessionId = safeString(params.sessionId || "").trim();
  const sessionFile = safeString(params.sessionFile || "").trim();
  const archivePath = safeString(params.path || "").trim();
  if (archivePath) {
    const resolvedArchivePath = path.isAbsolute(archivePath)
      ? archivePath
      : path.join(resolveTranscriptRoot(rootOverride), archivePath);
    const directEntries = await loadTranscriptArchiveFile(resolvedArchivePath);
    if (directEntries.length) return directEntries;
  }
  if (!sessionId && !sessionFile) return [];
  return withTranscriptSearchDb(rootOverride, (db) => {
    if (sessionFile) {
      const row = db
        .prepare(
          "SELECT session_key FROM entries WHERE session_file = ? ORDER BY timestamp_ms DESC LIMIT 1",
        )
        .get(sessionFile) as { session_key?: string } | undefined;
      if (row?.session_key) return loadSessionEntriesByKey(db, row.session_key);
    }
    if (sessionId) {
      const row = db
        .prepare(
          "SELECT session_key FROM entries WHERE session_id = ? ORDER BY timestamp_ms DESC LIMIT 1",
        )
        .get(sessionId) as { session_key?: string } | undefined;
      if (row?.session_key) return loadSessionEntriesByKey(db, row.session_key);
    }
    return [];
  });
}

export async function loadRecentTranscriptSessions(
  params: Record<string, unknown> = {},
  rootOverride = "",
): Promise<TranscriptSessionResult[]> {
  const limit = Math.max(
    1,
    Number(params.limit || DEFAULT_RESULT_LIMIT) || DEFAULT_RESULT_LIMIT,
  );
  return withTranscriptSearchDb(rootOverride, (db) => {
    const sessionRows = db
      .prepare(
        `
        SELECT session_key, MAX(timestamp_ms) AS latest_timestamp_ms
        FROM entries
        GROUP BY session_key
        ORDER BY latest_timestamp_ms DESC
        LIMIT ?
      `,
      )
      .all(limit) as Array<{ session_key: string; latest_timestamp_ms: number }>;
    return sessionRows.map((row, index) => {
      const entries = loadSessionEntriesByKey(db, row.session_key);
      return presentSessionResult(
        entries,
        Math.max(1, limit - index),
        rootOverride,
      );
    });
  });
}

function addCandidateScore(
  candidates: Map<string, number>,
  rowKey: string,
  score: number,
) {
  if (!rowKey || score <= 0) return;
  candidates.set(rowKey, Math.max(candidates.get(rowKey) || 0, score));
}

function queryExactCandidates(
  db: Database,
  rawQuery: string,
  rawHitLimit: number,
  candidates: Map<string, number>,
) {
  const like = `%${escapeLike(rawQuery)}%`;
  const rows = db
    .prepare(
      `
      SELECT row_key, text, preview, tool_name, session_id, session_file, custom_type
      FROM entries
      WHERE lower(text) LIKE lower(?) ESCAPE '\\'
         OR lower(preview) LIKE lower(?) ESCAPE '\\'
         OR lower(role) LIKE lower(?) ESCAPE '\\'
         OR lower(tool_name) LIKE lower(?) ESCAPE '\\'
         OR lower(custom_type) LIKE lower(?) ESCAPE '\\'
         OR lower(session_id) LIKE lower(?) ESCAPE '\\'
         OR lower(session_file) LIKE lower(?) ESCAPE '\\'
      ORDER BY timestamp_ms DESC
      LIMIT ?
    `,
    )
    .all(like, like, like, like, like, like, like, rawHitLimit) as Array<{
      row_key: string;
      text: string;
      preview: string;
      tool_name: string;
      session_id: string;
      session_file: string;
      custom_type: string;
    }>;
  rows.forEach((row, index) => {
    let score = 180 - index * 4;
    const haystack = normalizeNeedle(
      [
        row.text,
        row.preview,
        row.tool_name,
        row.session_id,
        row.session_file,
        row.custom_type,
      ].join(" "),
    );
    const normalizedQuery = normalizeNeedle(rawQuery);
    if (haystack === normalizedQuery) score += 30;
    if (row.text.toLowerCase().includes(rawQuery.toLowerCase())) score += 18;
    addCandidateScore(candidates, row.row_key, score);
  });
}

function queryFtsCandidates(
  db: Database,
  tableName: "entries_fts_token" | "entries_fts_trigram",
  query: string,
  rawHitLimit: number,
  baseScore: number,
  step: number,
  candidates: Map<string, number>,
) {
  if (!query) return;
  const rows = db
    .prepare(
      `
      SELECT row_key
      FROM ${tableName}
      WHERE ${tableName} MATCH ?
      ORDER BY bm25(${tableName})
      LIMIT ?
    `,
    )
    .all(query, rawHitLimit) as Array<{ row_key: string }>;
  rows.forEach((row, index) => {
    addCandidateScore(candidates, row.row_key, baseScore - index * step);
  });
}

function aggregateSearchResults(
  db: Database,
  candidates: Map<string, number>,
  limit: number,
  rootOverride = "",
): TranscriptSessionResult[] {
  if (!candidates.size) return [];

  const placeholders = [...candidates.keys()].map(() => "?").join(",");
  const rows = db
    .prepare(
      `
      SELECT row_key, archive_path, session_key, session_id, session_file,
             timestamp, timestamp_ms, line_number, role, preview, entry_json
      FROM entries
      WHERE row_key IN (${placeholders})
    `,
    )
    .all(...candidates.keys()) as Array<{
      row_key: string;
      archive_path: string;
      session_key: string;
      session_id: string;
      session_file: string;
      timestamp: string;
      timestamp_ms: number;
      line_number: number;
      role: string;
      preview: string;
      entry_json: string;
    }>;

  const orderedRows = rows
    .map((row) => ({ ...row, score: candidates.get(row.row_key) || 0 }))
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff) return diff;
      return b.timestamp_ms - a.timestamp_ms;
    })
    .slice(0, RAW_SEARCH_LIMIT);

  const grouped = new Map<string, IndexedSessionBucket>();
  for (const row of orderedRows) {
    const bucket = grouped.get(row.session_key) || {
      sessionKey: row.session_key,
      sessionId: row.session_id,
      sessionFile: row.session_file,
      bestScore: row.score,
      totalScore: 0,
      hitCount: 0,
      latestHitTimestampMs: row.timestamp_ms,
      messages: [],
    };
    bucket.bestScore = Math.max(bucket.bestScore, row.score);
    bucket.totalScore += row.score;
    bucket.hitCount += 1;
    bucket.latestHitTimestampMs = Math.max(bucket.latestHitTimestampMs, row.timestamp_ms);
    if (bucket.messages.length < MAX_MATCHED_ENTRIES_PER_SESSION) {
      const entry = rowToEntry({
        entry_json: row.entry_json,
        line_number: row.line_number,
        archive_path: row.archive_path,
      });
      if (entry) {
        bucket.messages.push(buildResultMessage(entry));
      }
    }
    grouped.set(row.session_key, bucket);
  }

  const rankedSessions = [...grouped.values()]
    .map((bucket) => ({
      ...bucket,
      score:
        bucket.bestScore +
        Math.min(bucket.hitCount, 8) * 14 +
        Math.min(bucket.totalScore, 400) / 10,
    }))
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff) return diff;
      return b.latestHitTimestampMs - a.latestHitTimestampMs;
    })
    .slice(0, limit);

  return rankedSessions.map((bucket) => {
    const entries = loadSessionEntriesByKey(db, bucket.sessionKey);
    return presentSessionResult(entries, bucket.score, rootOverride, {
      hitCount: bucket.hitCount,
      messages: bucket.messages,
    });
  });
}

export async function searchTranscriptArchive(
  query: string,
  params: Record<string, unknown> = {},
  rootOverride = "",
): Promise<TranscriptSessionResult[]> {
  const rawQuery = safeString(query).trim();
  if (!rawQuery) return [];
  const limit = Math.max(
    1,
    Number(params.limit || DEFAULT_RESULT_LIMIT) || DEFAULT_RESULT_LIMIT,
  );
  const fidelity = safeString(params.fidelity || "").trim();

  return withTranscriptSearchDb(rootOverride, (db) => {
    const tokenQuery = buildTokenFtsQuery(rawQuery);
    const trigramQuery = buildTrigramFtsQuery(rawQuery);
    const candidates = new Map<string, number>();

    queryExactCandidates(db, rawQuery, RAW_SEARCH_LIMIT, candidates);
    if (fidelity !== "exact") {
      queryFtsCandidates(
        db,
        "entries_fts_token",
        tokenQuery,
        RAW_SEARCH_LIMIT,
        140,
        3,
        candidates,
      );
      queryFtsCandidates(
        db,
        "entries_fts_trigram",
        trigramQuery,
        RAW_SEARCH_LIMIT,
        100,
        2,
        candidates,
      );
    }

    return aggregateSearchResults(db, candidates, limit, rootOverride);
  });
}
