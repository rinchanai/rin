import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import MiniSearch from "minisearch";

import { normalizeNeedle, safeString, sha, trimText } from "./core/utils.js";

export type TranscriptArchiveEntry = {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionFile: string;
  role: "user" | "assistant";
  text: string;
};

type IndexedTranscriptEntry = TranscriptArchiveEntry & { _search_id: string };

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

function createTranscriptMiniSearch(entries: IndexedTranscriptEntry[]) {
  const miniSearch = new MiniSearch<IndexedTranscriptEntry>({
    idField: "_search_id",
    fields: ["text", "role", "sessionId", "sessionFile"],
    storeFields: ["timestamp", "sessionId", "sessionFile", "role", "text"],
    searchOptions: {
      boost: {
        text: 5,
        role: 1,
        sessionId: 1,
        sessionFile: 1,
      },
      prefix: true,
      combineWith: "AND",
    },
  });
  miniSearch.addAll(entries);
  return miniSearch;
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
        [entry.text, entry.role, entry.sessionId, entry.sessionFile].join(" "),
      );
      return haystack.includes(normalizedQuery);
    })
    .slice(-limit)
    .reverse()
    .map((entry, index) =>
      presentTranscriptResult(entry, Math.max(1, limit - index), rootOverride),
    );
  if (fidelity === "exact") return substringMatches;

  const indexedEntries = entries.map((entry) => ({
    ...entry,
    _search_id: entry.id,
  }));
  const rows = createTranscriptMiniSearch(indexedEntries)
    .search(rawQuery)
    .slice(0, limit);
  if (!rows.length) return substringMatches;
  const entryById = new Map(
    indexedEntries.map((entry) => [entry._search_id, entry]),
  );
  return rows
    .map((row) => {
      const entry = entryById.get(String(row.id || ""));
      if (!entry) return null;
      return presentTranscriptResult(
        entry,
        Number(row.score || 0) * 0.85,
        rootOverride,
      );
    })
    .filter(Boolean);
}
