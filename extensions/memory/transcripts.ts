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
  role: string;
  text: string;
  content?: any;
  toolName?: string;
  toolCallId?: string;
  customType?: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  display?: boolean;
};

const TASK_ANCHOR_STATUS_PATTERNS = {
  blocked:
    /\b(blocked|stuck|captcha|verify|verification|try again|failed|failure|error|risk)\b|卡在|验证码|验证|失败|风控|报错|重试/u,
  done: /\b(done|completed|complete|success|succeeded|verified|created|finished)\b|完成|成功|已完成|已创建|绑定成功|已验证/u,
  next: /\b(next|todo|pending|need to|should|follow-up)\b|下一步|待继续|待处理|还要|需要/u,
  browser:
    /\b(browser|page|signup|login|account|oauth|captcha|mail|github|google|outlook)\b|浏览器|页面|注册|登录|账号|邮箱|验证码/u,
};

export type TranscriptTaskState = {
  status: "blocked" | "next" | "done" | "state" | "unknown";
  blockers: string[];
  next: string[];
  completed: string[];
  anchors: string[];
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
  taskState?: TranscriptTaskState;
};

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

export function resolveTaskStateRoot(rootOverride = ""): string {
  return path.join(resolveMemoryRoot(rootOverride), "task-state");
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

export function getTaskStatePath(
  input: Record<string, any> | string = "",
  rootOverride = "",
): string {
  const root = resolveTaskStateRoot(rootOverride);
  if (typeof input === "string") {
    const key = safeString(input).trim();
    if (!key) return path.join(root, "unknown", "unknown-session.json");
    if (
      key.endsWith(".json") &&
      (key.includes("/") || key.includes(path.sep))
    ) {
      return path.join(root, key);
    }
    if (key.includes(path.sep) || key.includes("/")) {
      return path.join(root, "unknown", `${sha(key).slice(0, 16)}.json`);
    }
    return path.join(root, "unknown", `${key}.json`);
  }
  const { year, month } = transcriptDateParts(input);
  const basename = transcriptSessionBasename(input).replace(
    /\.jsonl$/,
    ".json",
  );
  return path.join(root, year, month, basename);
}

async function ensureTranscriptParent(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function normalizeInlineValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizePart(part: any): string {
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return safeString(part.text || "");
  if (part.type === "thinking") return safeString(part.thinking || "");
  if (part.type === "toolCall") {
    const name =
      safeString(part.name || part.toolName || "tool").trim() || "tool";
    const args = normalizeInlineValue(part.args || part.arguments || "");
    return args ? `[tool:${name}] ${args}` : `[tool:${name}]`;
  }
  if (part.type === "image") {
    const mimeType = safeString(part.mimeType || "image").trim() || "image";
    return `[image:${mimeType}]`;
  }
  if (part.type === "file") {
    const name =
      safeString(part.name || part.path || part.url || "file").trim() || "file";
    return `[file:${name}]`;
  }
  return "";
}

function extractTranscriptText(input: Record<string, any>): string {
  const role = safeString(input.role || "").trim();
  const content = input.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => summarizePart(part))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (role === "bashExecution") {
    const command = safeString(input.command || "").trim();
    const output = safeString(input.output || "").trim();
    return [command ? `[bash] ${command}` : "", output]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return safeString(input.summary || "").trim();
  }
  return safeString(input.text || "").trim();
}

export async function appendTranscriptArchiveEntry(
  input: Record<string, any>,
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
  await ensureTranscriptParent(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
}

export function deriveTaskAnchorEntry(input: Record<string, any>) {
  const role = safeString(input.role || "").trim();
  const customType = safeString(input.customType || "").trim();
  if (!role) return null;
  if (customType === "task_anchor") return null;
  if (customType === "self_improve_session_transcript") return null;
  const text = extractTranscriptText(input);
  if (!text) return null;

  let score = 0;
  if (role === "assistant") score += 2;
  if (role === "user") score += 1;
  if (role === "toolResult" || role === "bashExecution") score += 2;
  if (safeString(input.toolName || "").trim()) score += 2;
  if (safeString(input.toolCallId || "").trim()) score += 1;
  if (text.length >= 48) score += 1;
  if (text.includes("[tool:")) score += 2;
  if (text.includes("[bash]")) score += 2;
  if (text.includes("http://") || text.includes("https://")) score += 1;
  if (text.includes("/") || text.includes("\\")) score += 1;
  const hasBlockedSignal = TASK_ANCHOR_STATUS_PATTERNS.blocked.test(text);
  const hasDoneSignal = TASK_ANCHOR_STATUS_PATTERNS.done.test(text);
  const hasNextSignal = TASK_ANCHOR_STATUS_PATTERNS.next.test(text);
  const hasBrowserSignal = TASK_ANCHOR_STATUS_PATTERNS.browser.test(text);
  if (hasBlockedSignal) score += 3;
  if (hasDoneSignal) score += 2;
  if (hasNextSignal) score += 2;
  if (hasBrowserSignal) score += 1;
  if (
    role === "toolResult" &&
    !hasBlockedSignal &&
    !hasDoneSignal &&
    !hasBrowserSignal &&
    !text.includes("[bash]") &&
    !text.includes("http://") &&
    !text.includes("https://") &&
    !text.includes("/") &&
    !text.includes("\\")
  ) {
    return null;
  }
  if (score < 4) return null;

  const status = hasBlockedSignal
    ? "blocked"
    : hasDoneSignal
      ? "done"
      : hasNextSignal
        ? "next"
        : "state";
  const label = [
    status,
    role,
    safeString(input.toolName || "").trim() || undefined,
  ]
    .filter(Boolean)
    .join(" | ");
  return {
    id: `${
      safeString(input.id || "").trim() ||
      sha(
        [role, text, safeString(input.timestamp || "").trim()].join("\n"),
      ).slice(0, 16)
    }::task-anchor`,
    timestamp: safeString(input.timestamp || new Date().toISOString()).trim(),
    sessionId: safeString(input.sessionId || "").trim(),
    sessionFile: safeString(input.sessionFile || "").trim(),
    role: "custom",
    customType: "task_anchor",
    toolName: safeString(input.toolName || "").trim() || undefined,
    toolCallId: safeString(input.toolCallId || "").trim() || undefined,
    text: trimText(`${label} | ${safeString(text).trim()}`, 320),
  } satisfies Record<string, any>;
}

export async function appendTaskAnchorArchiveEntry(
  input: Record<string, any>,
  rootOverride = "",
) {
  const entry = deriveTaskAnchorEntry(input);
  if (!entry) return;
  await appendTranscriptArchiveEntry(entry, rootOverride);
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
        const parsed = JSON.parse(line) as TranscriptArchiveEntry;
        if (!parsed?.text)
          parsed.text = extractTranscriptText(parsed as Record<string, any>);
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

function transcriptPreviewText(entry: TranscriptArchiveEntry) {
  const label = entry.customType
    ? entry.toolName
      ? `[${entry.role}:${entry.customType}:${entry.toolName}]`
      : `[${entry.role}:${entry.customType}]`
    : entry.toolName
      ? `[${entry.role}:${entry.toolName}]`
      : `[${entry.role}]`;
  return `${label} ${safeString(entry.text || "").trim()}`.trim();
}

function parseTaskAnchorStatus(entry: TranscriptArchiveEntry) {
  if (safeString(entry.customType || "").trim() !== "task_anchor") return "";
  const text = safeString(entry.text || "").trim();
  const prefix = text.split("|")[0]?.trim().toLowerCase() || "";
  if (["blocked", "done", "next", "state"].includes(prefix)) return prefix;
  return "state";
}

function taskAnchorSignals(text: string) {
  const value = safeString(text).trim();
  return {
    blocked: TASK_ANCHOR_STATUS_PATTERNS.blocked.test(value),
    done: TASK_ANCHOR_STATUS_PATTERNS.done.test(value),
    next: TASK_ANCHOR_STATUS_PATTERNS.next.test(value),
  };
}

function dedupeTexts(values: string[], limit = 3) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = safeString(value).trim();
    if (!text) continue;
    const key = normalizeNeedle(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function taskStateLine(label: string, values: string[]) {
  const rows = dedupeTexts(values);
  if (!rows.length) return "";
  return `${label}: ${rows.join(" ; ")}`;
}

export function deriveSessionTaskState(
  entries: TranscriptArchiveEntry[],
): TranscriptTaskState {
  const ranked = [...entries].sort(
    (a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp),
  );
  const rawAnchors = ranked.filter(
    (entry) => safeString(entry.customType || "").trim() === "task_anchor",
  );
  const anchors = rawAnchors.length
    ? rawAnchors
    : ranked
        .map((entry) => deriveTaskAnchorEntry(entry))
        .filter(Boolean)
        .map((entry) => entry as TranscriptArchiveEntry);
  const blockers = anchors
    .filter((entry) => {
      const text = safeString(entry.text || "").trim();
      const signals = taskAnchorSignals(text);
      return parseTaskAnchorStatus(entry) === "blocked" || signals.blocked;
    })
    .map((entry) => safeString(entry.text || "").trim());
  const next = anchors
    .filter((entry) => {
      const text = safeString(entry.text || "").trim();
      const signals = taskAnchorSignals(text);
      return parseTaskAnchorStatus(entry) === "next" || signals.next;
    })
    .map((entry) => safeString(entry.text || "").trim());
  const completed = anchors
    .filter((entry) => {
      const text = safeString(entry.text || "").trim();
      const signals = taskAnchorSignals(text);
      return parseTaskAnchorStatus(entry) === "done" || signals.done;
    })
    .map((entry) => safeString(entry.text || "").trim());
  const anchorTexts = anchors.map((entry) =>
    safeString(entry.text || "").trim(),
  );
  const status = blockers.length
    ? "blocked"
    : next.length
      ? "next"
      : completed.length
        ? "done"
        : anchorTexts.length
          ? "state"
          : "unknown";
  return {
    status,
    blockers: dedupeTexts(blockers),
    next: dedupeTexts(next),
    completed: dedupeTexts(completed),
    anchors: dedupeTexts(anchorTexts, 4),
  };
}

export type TranscriptTaskStateSnapshot = TranscriptTaskState & {
  sessionId: string;
  sessionFile: string;
  updatedAt: string;
  entryCount: number;
  path?: string;
};

export function buildSessionTaskStateSnapshot(
  entries: TranscriptArchiveEntry[],
): TranscriptTaskStateSnapshot | null {
  if (!entries.length) return null;
  const ranked = [...entries].sort(
    (a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp),
  );
  const latest = ranked[0];
  const taskState = deriveSessionTaskState(entries);
  return {
    ...taskState,
    sessionId: safeString(latest.sessionId || "").trim(),
    sessionFile: safeString(latest.sessionFile || "").trim(),
    updatedAt: safeString(latest.timestamp || "").trim(),
    entryCount: entries.length,
    path: getTaskStatePath(latest),
  };
}

export async function persistTranscriptTaskState(
  params: { sessionId?: string; sessionFile?: string } = {},
  rootOverride = "",
) {
  const entries = await loadTranscriptSessionEntries(params, rootOverride);
  const snapshot = buildSessionTaskStateSnapshot(entries);
  if (!snapshot) return null;
  const filePath = getTaskStatePath(snapshot, rootOverride);
  await ensureTranscriptParent(filePath);
  await fs.writeFile(
    filePath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  return { ...snapshot, path: filePath };
}

function buildTaskStatePreview(taskState: TranscriptTaskState) {
  return [
    taskStateLine("Blocked", taskState.blockers),
    taskStateLine("Next", taskState.next),
    taskStateLine("Done", taskState.completed),
  ]
    .filter(Boolean)
    .join("\n");
}

function presentTranscriptResult(
  entry: TranscriptArchiveEntry,
  score: number,
  rootOverride = "",
) {
  const previewText = transcriptPreviewText(entry);
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
    description: trimText(previewText, 160),
    preview: trimText(previewText, 240),
  };
}

function sessionPreviewPriority(entry: TranscriptArchiveEntry) {
  const text = safeString(entry.text || "").trim();
  let score = 0;
  if (entry.role === "assistant") score += 30;
  if (entry.role === "user") score += 20;
  if (entry.role === "toolResult") score += 12;
  if (entry.role === "bashExecution") score += 10;
  if (entry.role === "custom") score += 8;
  if (entry.customType === "task_anchor") score += 45;
  if (entry.toolName) score += 18;
  if (entry.toolCallId) score += 8;
  if (entry.customType === "self_improve_session_transcript") score -= 25;
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
    .filter(
      (entry, index) =>
        index === 0 || sessionPreviewPriority(entry) >= topScore - 8,
    )
    .slice(0, 2)
    .map((entry) => transcriptPreviewText(entry));
  const taskStatePreview = buildTaskStatePreview(
    deriveSessionTaskState(entries),
  );
  return trimText(
    [taskStatePreview, ...chosen].filter(Boolean).join("\n"),
    240,
  );
}

function presentSessionResult(
  entry: TranscriptArchiveEntry,
  entries: TranscriptArchiveEntry[],
  score: number,
  rootOverride = "",
): TranscriptSessionResult {
  const taskState = deriveSessionTaskState(entries);
  const preview = buildSessionPreview(entries);
  return {
    sourceType: "session",
    id:
      safeString(entry.sessionId || entry.sessionFile || entry.id).trim() ||
      entry.id,
    name: "recent session",
    role: entry.role,
    score,
    path: getTranscriptArchivePath(entry, rootOverride),
    sessionId: entry.sessionId,
    sessionFile: entry.sessionFile,
    timestamp: entry.timestamp,
    description: trimText(preview, 160),
    preview,
    taskState,
  };
}

function dedupeTranscriptArchiveEntries(entries: TranscriptArchiveEntry[]) {
  const byId = new Map<string, TranscriptArchiveEntry>();
  for (const entry of entries) {
    const id = safeString(entry.id || "").trim();
    if (!id) continue;
    byId.set(id, entry);
  }
  return [...byId.values()].sort((a, b) => {
    const byTime = timestampValue(a.timestamp) - timestampValue(b.timestamp);
    if (byTime) return byTime;
    return safeString(a.id).localeCompare(safeString(b.id));
  });
}

function buildTranscriptSearchDb(entries: TranscriptArchiveEntry[]) {
  const rows = dedupeTranscriptArchiveEntries(entries);
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
    for (const entry of rows) {
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

  const grouped = new Map<string, TranscriptArchiveEntry[]>();
  for (const entry of entries) {
    const key =
      safeString(entry.sessionFile || "").trim() ||
      safeString(entry.sessionId || "").trim() ||
      safeString(entry.id || "").trim();
    if (!key) continue;
    const bucket = grouped.get(key) || [];
    bucket.push(entry);
    grouped.set(key, bucket);
  }

  return [...grouped.values()]
    .map((bucket) => ({
      bucket,
      entry: chooseSessionPreviewEntry(bucket),
    }))
    .sort(
      (a, b) =>
        timestampValue(b.entry.timestamp) - timestampValue(a.entry.timestamp),
    )
    .slice(0, limit)
    .map(({ entry, bucket }, index) =>
      presentSessionResult(
        entry,
        bucket,
        Math.max(1, limit - index),
        rootOverride,
      ),
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
        return presentTranscriptResult(
          entry,
          score + sessionPreviewPriority(entry),
          rootOverride,
        );
      })
      .filter(Boolean)
      .sort((a, b) => {
        const byScore = Number(b?.score || 0) - Number(a?.score || 0);
        if (byScore) return byScore;
        return (
          timestampValue(String(b?.timestamp || "")) -
          timestampValue(String(a?.timestamp || ""))
        );
      })
      .slice(0, limit);
  } finally {
    db.close();
  }
}
