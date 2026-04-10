import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import {
  latinTokens,
  normalizeNeedle,
  safeString,
  sha,
  trimText,
  uniqueStrings,
} from "./utils.js";

export type TranscriptArchiveEntry = {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionFile: string;
  role: "user" | "assistant";
  text: string;
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
  role: "user" | "assistant";
};

export function resolveTranscriptRoot(rootOverride = ""): string {
  const base = safeString(rootOverride).trim()
    ? path.join(path.resolve(rootOverride), "memory")
    : path.join(
        process.env.PI_CODING_AGENT_DIR ||
          process.env.RIN_DIR ||
          path.join(process.env.HOME || "", ".rin"),
        "memory",
      );
  return path.join(base, "transcripts");
}

function transcriptSessionBasename(input: Record<string, any>): string {
  const sessionId = safeString(input.sessionId || "").trim();
  if (sessionId) return `${sessionId}.jsonl`;
  const sessionFile = safeString(input.sessionFile || "").trim();
  if (sessionFile) return `${sha(sessionFile).slice(0, 16)}.jsonl`;
  return "unknown-session.jsonl";
}

function transcriptDateParts(input: Record<string, any>): {
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
  input: Record<string, any> | string = "",
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

async function ensureTranscriptParent(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function extractTextParts(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return safeString(part.text || "");
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export async function appendTranscriptArchiveEntry(
  input: Record<string, any>,
  rootOverride = "",
) {
  const role = safeString(input.role || "").trim();
  if (role !== "user" && role !== "assistant") return;
  const text = extractTextParts(input.content);
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
        ].join("\n"),
      ).slice(0, 16),
    timestamp: safeString(input.timestamp || new Date().toISOString()).trim(),
    sessionId: safeString(input.sessionId || "").trim(),
    sessionFile: safeString(input.sessionFile || "").trim(),
    role,
    text,
  };
  const filePath = getTranscriptArchivePath(entry, rootOverride);
  await ensureTranscriptParent(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
}

async function loadTranscriptArchiveFile(filePath: string) {
  if (!fssync.existsSync(filePath)) return [];
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptArchiveEntry;
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

export async function loadTranscriptSessionEntries(
  params: { sessionId?: string; sessionFile?: string } = {},
  rootOverride = "",
): Promise<TranscriptArchiveEntry[]> {
  const sessionId = safeString(params.sessionId || "").trim();
  const sessionFile = safeString(params.sessionFile || "").trim();
  const entries = await loadTranscriptArchiveEntries(rootOverride);
  return entries.filter(
    (entry) =>
      (sessionId && safeString(entry.sessionId).trim() === sessionId) ||
      (sessionFile && safeString(entry.sessionFile).trim() === sessionFile),
  );
}

function createCjkTrigrams(value: string): string[] {
  const chars = [...safeString(value).replace(/\s+/g, "")].filter((char) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
  );
  const out: string[] = [];
  for (let index = 0; index < chars.length - 2; index += 1)
    out.push(`${chars[index]}${chars[index + 1]}${chars[index + 2]}`);
  return uniqueStrings(out);
}

function buildFtsQuery(value: string): string {
  const raw = safeString(value).trim();
  if (!raw) return "";
  const terms = uniqueStrings([
    ...latinTokens(raw),
    ...createCjkTrigrams(raw),
    ...(raw.replace(/\s+/g, "").length >= 3 ? [raw] : []),
  ]);
  return terms.length
    ? terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
    : "";
}

function escapeLike(value: string): string {
  return safeString(value).replace(/([%_\\])/g, "\\$1");
}

function timestampValue(value: string): number {
  const parsed = Date.parse(safeString(value).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function presentTranscriptResult(
  entry: TranscriptArchiveEntry,
  score: number,
  rootOverride = "",
) {
  return {
    sourceType: "transcript",
    id: entry.id,
    name: `${entry.role} transcript`,
    role: entry.role,
    score,
    path: getTranscriptArchivePath(entry, rootOverride),
    sessionId: entry.sessionId,
    sessionFile: entry.sessionFile,
    timestamp: entry.timestamp,
    description: trimText(entry.text, 160),
    preview: trimText(entry.text, 240),
  };
}

function presentSessionResult(
  entry: TranscriptArchiveEntry,
  score: number,
  rootOverride = "",
): TranscriptSessionResult {
  return {
    sourceType: "session",
    id: safeString(entry.sessionId || entry.sessionFile || entry.id).trim() ||
      entry.id,
    name: "recent session",
    role: entry.role,
    score,
    path: getTranscriptArchivePath(entry, rootOverride),
    sessionId: entry.sessionId,
    sessionFile: entry.sessionFile,
    timestamp: entry.timestamp,
    description: trimText(entry.text, 160),
    preview: trimText(entry.text, 240),
  };
}

function buildTranscriptSearchDb(entries: TranscriptArchiveEntry[]) {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_file TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE entries_fts USING fts5(
      id UNINDEXED,
      timestamp,
      session_id,
      role,
      text,
      tokenize='trigram'
    );
  `);
  const insertEntry = db.prepare(`
    INSERT INTO entries (id, timestamp, session_id, session_file, role, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO entries_fts (id, timestamp, session_id, role, text)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN;");
  try {
    for (const entry of entries) {
      insertEntry.run(
        entry.id,
        entry.timestamp,
        entry.sessionId,
        entry.sessionFile,
        entry.role,
        entry.text,
      );
      insertFts.run(
        entry.id,
        entry.timestamp,
        entry.sessionId,
        entry.role,
        entry.text,
      );
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  return db;
}

export async function loadRecentTranscriptSessions(
  params: Record<string, any> = {},
  rootOverride = "",
): Promise<TranscriptSessionResult[]> {
  const limit = Math.max(1, Number(params.limit || 8) || 8);
  const entries = await loadTranscriptArchiveEntries(rootOverride);
  if (!entries.length) return [];

  const grouped = new Map<string, TranscriptArchiveEntry>();
  for (const entry of entries) {
    const key =
      safeString(entry.sessionFile || "").trim() ||
      safeString(entry.sessionId || "").trim() ||
      safeString(entry.id || "").trim();
    if (!key) continue;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, entry);
      continue;
    }
    if (timestampValue(entry.timestamp) >= timestampValue(existing.timestamp)) {
      grouped.set(key, entry);
    }
  }

  return [...grouped.values()]
    .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp))
    .slice(0, limit)
    .map((entry, index) =>
      presentSessionResult(entry, Math.max(1, limit - index), rootOverride),
    );
}

export async function searchTranscriptArchive(
  query: string,
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const rawQuery = safeString(query).trim();
  if (!rawQuery) return [];
  const limit = Math.max(1, Number(params.limit || 8) || 8);
  const fidelity = safeString(params.fidelity || "").trim();
  const entries = await loadTranscriptArchiveEntries(rootOverride);
  if (!entries.length) return [];

  const normalizedQuery = normalizeNeedle(rawQuery);
  const substringMatches = entries
    .filter((entry) => {
      const haystack = normalizeNeedle(
        [entry.text, entry.role, entry.sessionId].join(" "),
      );
      return haystack.includes(normalizedQuery);
    })
    .slice(-limit)
    .reverse()
    .map((entry, index) =>
      presentTranscriptResult(entry, Math.max(1, limit - index), rootOverride),
    );
  if (fidelity === "exact") return substringMatches;

  const db = buildTranscriptSearchDb(entries);
  try {
    const ftsQuery = buildFtsQuery(rawQuery);
    const candidates = new Map<string, number>();
    if (ftsQuery) {
      const rows = db
        .prepare(
          `
          SELECT id
          FROM entries_fts
          WHERE entries_fts MATCH ?
          LIMIT ?
        `,
        )
        .all(ftsQuery, Math.max(limit * 8, 24)) as Array<{ id: string }>;
      rows.forEach((row, index) => {
        candidates.set(row.id, Math.max(0, 80 - index * 4));
      });
    }
    const like = `%${escapeLike(rawQuery)}%`;
    const likeRows = db
      .prepare(
        `
        SELECT id
        FROM entries
        WHERE text LIKE ? ESCAPE '\\'
           OR role LIKE ? ESCAPE '\\'
           OR session_id LIKE ? ESCAPE '\\'
        LIMIT ?
      `,
      )
      .all(like, like, like, Math.max(limit * 8, 24)) as Array<{
      id: string;
    }>;
    likeRows.forEach((row, index) => {
      candidates.set(
        row.id,
        Math.max(candidates.get(row.id) || 0, 36 - index * 2),
      );
    });
    if (!candidates.size) return substringMatches;
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    return [...candidates.entries()]
      .map(([id, score]) => {
        const entry = entryById.get(id);
        if (!entry) return null;
        return presentTranscriptResult(entry, score, rootOverride);
      })
      .filter(Boolean)
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
      .slice(0, limit);
  } finally {
    db.close();
  }
}
