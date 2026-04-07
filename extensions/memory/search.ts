import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import type { MemoryDoc } from "./core/types.js";
import { loadMemoryDocsSync } from "./docs.js";
import {
  latinTokens,
  normalizeNeedle,
  safeString,
  uniqueStrings,
} from "./core/utils.js";

type SearchOptions = { limit?: number; exposure?: string };
type SearchResultRow = { doc: MemoryDoc; score: number; query: string };
type CandidateMeta = {
  ftsIndex?: number;
  likeIndex?: number;
};

type IndexedRow = {
  path: string;
  id: string;
  name: string;
  description: string;
  content: string;
  exposure: string;
  scope: string;
  kind: string;
  memory_prompt_slot: string;
  updated_at: string;
  status: string;
  tags_text: string;
  aliases_text: string;
};

export function buildSearchQuery(value: string): string {
  return safeString(value).trim();
}

function memoryDocsDbPath(rootDir: string): string {
  return path.join(rootDir, "state", "memory-docs.sqlite");
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

function createSearchTerms(value: string): string[] {
  const raw = buildSearchQuery(value);
  if (!raw) return [];
  return uniqueStrings([
    ...latinTokens(raw),
    ...createCjkTrigrams(raw),
    ...(raw.replace(/\s+/g, "").length >= 3 ? [raw] : []),
  ]);
}

function escapeFtsTerm(value: string): string {
  return `"${safeString(value).replace(/"/g, '""')}"`;
}

function buildFtsQuery(value: string): string {
  const terms = createSearchTerms(value);
  return terms.length ? terms.map(escapeFtsTerm).join(" OR ") : "";
}

function escapeLike(value: string): string {
  return safeString(value).replace(/([%_\\])/g, "\\$1");
}

type SqliteDatabase = BetterSqlite3.Database;

function createDatabase(filename = ":memory:") {
  const db = new BetterSqlite3(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      exposure TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      memory_prompt_slot TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      tags_text TEXT NOT NULL,
      aliases_text TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      path UNINDEXED,
      id,
      name,
      description,
      content,
      tags,
      aliases,
      scope,
      kind,
      tokenize='trigram'
    );
  `);
  return db;
}

function rebuildIndex(db: SqliteDatabase, docs: MemoryDoc[]) {
  const rows = docs.filter(
    (doc) => doc.exposure === "memory_docs" && doc.status === "active",
  );
  const insertDoc = db.prepare(`
    INSERT INTO docs (
      path,
      id,
      name,
      description,
      content,
      exposure,
      scope,
      kind,
      memory_prompt_slot,
      updated_at,
      status,
      tags_text,
      aliases_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO docs_fts (
      path,
      id,
      name,
      description,
      content,
      tags,
      aliases,
      scope,
      kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN;");
  try {
    db.exec("DELETE FROM docs;");
    db.exec("DELETE FROM docs_fts;");
    for (const doc of rows) {
      const tagsText = Array.isArray(doc.tags) ? doc.tags.join(" ") : "";
      const aliasesText = Array.isArray(doc.aliases)
        ? doc.aliases.join(" ")
        : "";
      const docPath = safeString(doc.path || "");
      const docId = safeString(doc.id || "");
      const docName = safeString((doc as any).name || (doc as any).title || "");
      const description = safeString(doc.description || "");
      const content = safeString(doc.content || "");
      const scope = safeString(doc.scope || "");
      const kind = safeString(doc.kind || "");
      const updatedAt = safeString(doc.updated_at || "");
      const status = safeString(doc.status || "active");
      const slot = safeString(doc.memory_prompt_slot || "");
      insertDoc.run(
        docPath,
        docId,
        docName,
        description,
        content,
        "memory_docs",
        scope,
        kind,
        slot,
        updatedAt,
        status,
        tagsText,
        aliasesText,
      );
      insertFts.run(
        docPath,
        docId,
        docName,
        description,
        content,
        tagsText,
        aliasesText,
        scope,
        kind,
      );
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function collectCandidates(
  db: SqliteDatabase,
  query: string,
  limit: number,
): Map<string, CandidateMeta> {
  const candidates = new Map<string, CandidateMeta>();
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    const ftsRows = db
      .prepare(
        `
        SELECT path
        FROM docs_fts
        WHERE docs_fts MATCH ?
        LIMIT ?
      `,
      )
      .all(ftsQuery, Math.max(limit * 8, 24)) as Array<{ path: string }>;
    ftsRows.forEach((row, index) => {
      const current = candidates.get(row.path) || {};
      current.ftsIndex = current.ftsIndex ?? index;
      candidates.set(row.path, current);
    });
  }

  const like = `%${escapeLike(query)}%`;
  const likeRows = db
    .prepare(
      `
      SELECT path
      FROM docs
      WHERE name LIKE ? ESCAPE '\\'
         OR description LIKE ? ESCAPE '\\'
         OR content LIKE ? ESCAPE '\\'
         OR tags_text LIKE ? ESCAPE '\\'
         OR aliases_text LIKE ? ESCAPE '\\'
      LIMIT ?
    `,
    )
    .all(like, like, like, like, like, Math.max(limit * 8, 24)) as Array<{
    path: string;
  }>;
  likeRows.forEach((row, index) => {
    const current = candidates.get(row.path) || {};
    current.likeIndex = current.likeIndex ?? index;
    candidates.set(row.path, current);
  });

  return candidates;
}

function scoreCandidate(
  doc: IndexedRow,
  query: string,
  meta: CandidateMeta,
): number {
  const needle = normalizeNeedle(query);
  if (!needle) return 0;
  const name = normalizeNeedle(doc.name);
  const description = normalizeNeedle(doc.description);
  const content = normalizeNeedle(doc.content);
  const id = normalizeNeedle(doc.id);
  const fileBase = normalizeNeedle(path.basename(doc.path, ".md"));
  const tags = normalizeNeedle(doc.tags_text);
  const aliases = normalizeNeedle(doc.aliases_text);
  let score = 0;

  if (meta.ftsIndex != null) score += Math.max(0, 80 - meta.ftsIndex * 4);
  if (meta.likeIndex != null) score += Math.max(0, 36 - meta.likeIndex * 2);
  if (id === needle) score += 120;
  if (fileBase === needle) score += 100;
  if (name === needle) score += 90;
  if (tags.includes(needle)) score += 34;
  if (aliases.includes(needle)) score += 28;
  if (name.includes(needle)) score += 24;
  if (description.includes(needle)) score += 14;
  if (content.includes(needle)) score += 8;
  return score;
}

function fetchIndexedRows(
  db: SqliteDatabase,
  candidatePaths: string[],
): Map<string, IndexedRow> {
  if (!candidatePaths.length) return new Map();
  const placeholders = candidatePaths.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      SELECT
        path,
        id,
        name,
        description,
        content,
        exposure,
        scope,
        kind,
        memory_prompt_slot,
        updated_at,
        status,
        tags_text,
        aliases_text
      FROM docs
      WHERE path IN (${placeholders})
    `,
    )
    .all(...candidatePaths) as IndexedRow[];
  return new Map(rows.map((row) => [row.path, row]));
}

function searchWithDatabase(
  db: SqliteDatabase,
  query: string,
  limit: number,
): SearchResultRow[] {
  const candidates = collectCandidates(db, query, limit);
  if (!candidates.size) return [];
  const rowsByPath = fetchIndexedRows(db, [...candidates.keys()]);
  return [...candidates.entries()]
    .map(([candidatePath, meta]) => {
      const row = rowsByPath.get(candidatePath);
      if (!row) return null;
      const doc: MemoryDoc = {
        id: row.id,
        name: row.name,
        description: row.description,
        content: row.content,
        exposure: "memory_docs",
        fidelity: "fuzzy",
        memory_prompt_slot: row.memory_prompt_slot,
        tags: row.tags_text.split(/\s+/).filter(Boolean),
        aliases: row.aliases_text.split(/\s+/).filter(Boolean),
        scope: row.scope as MemoryDoc["scope"],
        kind: row.kind as MemoryDoc["kind"],
        sensitivity: "normal",
        source: "",
        updated_at: row.updated_at,
        last_observed_at: row.updated_at,
        observation_count: 1,
        status: row.status as MemoryDoc["status"],
        supersedes: [],
        canonical: false,
        path: row.path,
      };
      return {
        doc,
        score: scoreCandidate(row, query, meta),
        query,
      };
    })
    .filter((row): row is SearchResultRow => Boolean(row))
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(b.doc.updated_at || "").localeCompare(
          String(a.doc.updated_at || ""),
        ),
    )
    .slice(0, limit);
}

export function searchMemoryDocs(
  docs: MemoryDoc[],
  rawQuery: string,
  options: SearchOptions = {},
): SearchResultRow[] {
  const query = buildSearchQuery(rawQuery);
  if (!query) return [];
  const limit = Math.max(1, Number(options.limit || 8) || 8);
  const exposure = safeString(options.exposure || "").trim();
  const filteredDocs = docs.filter(
    (doc) =>
      doc.status === "active" &&
      doc.exposure === "memory_docs" &&
      (!exposure || doc.exposure === exposure),
  );
  if (!filteredDocs.length) return [];
  const db = createDatabase();
  try {
    rebuildIndex(db, filteredDocs);
    return searchWithDatabase(db, query, limit);
  } finally {
    db.close();
  }
}

export function searchIndexedMemoryDocs(
  rootDir: string,
  rawQuery: string,
  options: SearchOptions = {},
): SearchResultRow[] {
  const query = buildSearchQuery(rawQuery);
  if (!query) return [];
  const limit = Math.max(1, Number(options.limit || 8) || 8);
  const exposure = safeString(options.exposure || "").trim();
  const docs = loadMemoryDocsSync(rootDir).filter(
    (doc) =>
      doc.status === "active" &&
      doc.exposure === "memory_docs" &&
      (!exposure || doc.exposure === exposure),
  );
  if (!docs.length) return [];
  const db = createDatabase(memoryDocsDbPath(rootDir));
  try {
    rebuildIndex(db, docs);
    return searchWithDatabase(db, query, limit);
  } finally {
    db.close();
  }
}
