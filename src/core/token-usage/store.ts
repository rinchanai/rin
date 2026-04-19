import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import BetterSqlite3 from "better-sqlite3";
import { safeString } from "../text-utils.js";

export type TokenTelemetryEvent = {
  id?: string;
  timestamp?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  sessionPersisted?: boolean;
  cwd?: string;
  eventType: string;
  source?: string;
  trigger?: string;
  turnIndex?: number | null;
  phase?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  messageId?: string;
  messageRole?: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  toolCallCount?: number;
  toolNames?: string[];
  capabilityKind?: string;
  capabilityKey?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  costTotal?: number;
  contextTokens?: number;
  isError?: boolean;
  metadata?: Record<string, unknown> | null;
};

export type TokenUsageQueryOptions = {
  agentDir?: string;
  from?: string;
  to?: string;
  groupBy?: string[];
  filters?: Array<{ key: string; value: string }>;
  limit?: number;
  orderBy?: string;
  direction?: "asc" | "desc";
  includeZero?: boolean;
};

const dbCache = new Map<string, BetterSqlite3.Database>();
const statementCache = new WeakMap<BetterSqlite3.Database, Map<string, any>>();

const DEFAULT_AGGREGATE_LIMIT = 20;
const DEFAULT_EVENTS_LIMIT = 40;
const MAX_QUERY_LIMIT = 500;

const AGGREGATE_METRICS = [
  { key: "rows", select: `COUNT(*)` },
  { key: "token_events", select: `SUM(CASE WHEN total_tokens > 0 THEN 1 ELSE 0 END)` },
  { key: "input_tokens", select: `SUM(input_tokens)` },
  { key: "output_tokens", select: `SUM(output_tokens)` },
  { key: "cache_read_tokens", select: `SUM(cache_read_tokens)` },
  { key: "cache_write_tokens", select: `SUM(cache_write_tokens)` },
  { key: "total_tokens", select: `SUM(total_tokens)` },
  { key: "cost_total", select: `SUM(cost_total)` },
  { key: "context_tokens", select: `MAX(context_tokens)` },
] as const;

const AGGREGATE_ORDER_FIELDS = new Set(
  AGGREGATE_METRICS.map((metric) => metric.key),
);
const OVERVIEW_INT_FIELDS = [
  "total_events",
  "token_events",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "session_count",
  "model_count",
] as const;
const OVERVIEW_FLOAT_FIELDS = ["cost_total"] as const;

export type NormalizedTokenTelemetryEvent = {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionFile: string;
  sessionName: string;
  sessionPersisted: boolean;
  cwd: string;
  eventType: string;
  source: string;
  trigger: string;
  turnIndex: number | null;
  phase: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  messageId: string;
  messageRole: string;
  stopReason: string;
  toolCallId: string;
  toolName: string;
  toolCallCount: number;
  toolNames: string[];
  capabilityKind: string;
  capabilityKey: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  contextTokens: number;
  isError: boolean;
  metadata: Record<string, unknown> | null;
};

function normalizeText(value: unknown): string {
  return safeString(value).trim();
}

function safeNumber(value: unknown): number {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function normalizeInt(value: unknown): number {
  return Math.max(0, Math.round(safeNumber(value)));
}

function normalizeOptionalInt(value: unknown): number | null {
  if (value == null || normalizeText(value) === "") return null;
  return Math.round(safeNumber(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeJsonStringify(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function clampQueryLimit(value: unknown, fallback: number): number {
  return Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.round(safeNumber(value || fallback))));
}

function normalizeOverviewRow(row: any) {
  const normalized = { ...(row || {}) };
  for (const key of OVERVIEW_INT_FIELDS) {
    normalized[key] = normalizeInt(row?.[key]);
  }
  for (const key of OVERVIEW_FLOAT_FIELDS) {
    normalized[key] = safeNumber(row?.[key]);
  }
  normalized.first_timestamp = normalizeText(row?.first_timestamp);
  normalized.last_timestamp = normalizeText(row?.last_timestamp);
  return normalized;
}

export function resolveAgentDir(agentDir = ""): string {
  const fromEnv = safeString(process.env.PI_CODING_AGENT_DIR || process.env.RIN_DIR).trim();
  if (safeString(agentDir).trim()) return path.resolve(agentDir);
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".rin");
}

export function resolveTokenUsageRoot(agentDir = ""): string {
  return path.join(resolveAgentDir(agentDir), "data", "token-usage");
}

export function resolveTokenUsageDbPath(agentDir = ""): string {
  return path.join(resolveTokenUsageRoot(agentDir), "usage.db");
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function initDb(db: BetterSqlite3.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      session_id TEXT,
      session_file TEXT,
      session_name TEXT,
      session_persisted INTEGER NOT NULL DEFAULT 0,
      cwd TEXT,
      event_type TEXT NOT NULL,
      source TEXT,
      trigger TEXT,
      turn_index INTEGER,
      phase TEXT,
      provider TEXT,
      model TEXT,
      thinking_level TEXT,
      message_id TEXT,
      message_role TEXT,
      stop_reason TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_names_json TEXT,
      capability_kind TEXT,
      capability_key TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0,
      cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      is_error INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS telemetry_events_timestamp_idx
      ON telemetry_events(timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_session_idx
      ON telemetry_events(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_event_type_idx
      ON telemetry_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_model_idx
      ON telemetry_events(provider, model, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_source_idx
      ON telemetry_events(source, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_capability_idx
      ON telemetry_events(capability_key, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_tokens_idx
      ON telemetry_events(total_tokens, timestamp);
  `);
}

function prepareCached(db: BetterSqlite3.Database, sql: string) {
  let statements = statementCache.get(db);
  if (!statements) {
    statements = new Map();
    statementCache.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

export function openTokenUsageDb(agentDir = ""): BetterSqlite3.Database {
  const dbPath = resolveTokenUsageDbPath(agentDir);
  const existing = dbCache.get(dbPath);
  if (existing) return existing;
  ensureParentDir(dbPath);
  const db = new BetterSqlite3(dbPath);
  initDb(db);
  dbCache.set(dbPath, db);
  return db;
}

function normalizeToolNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => safeString(item).trim())
        .filter(Boolean),
    ),
  ).sort();
}

function stableEventId(event: Omit<NormalizedTokenTelemetryEvent, "id">): string {
  const seed = [
    event.timestamp,
    event.sessionId,
    event.sessionFile,
    event.eventType,
    event.messageId,
    event.toolCallId,
    String(event.turnIndex ?? ""),
    event.capabilityKey,
    event.provider,
    event.model,
    event.messageRole,
    event.toolName,
    String(event.totalTokens),
    safeJsonStringify(event.toolNames) || "[]",
  ].join("|");
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `evt_${digest}`;
}

export function normalizeTokenTelemetryEvent(
  event: TokenTelemetryEvent,
): NormalizedTokenTelemetryEvent {
  const normalizedWithoutId = {
    timestamp: normalizeText(event.timestamp) || nowIso(),
    sessionId: normalizeText(event.sessionId),
    sessionFile: normalizeText(event.sessionFile),
    sessionName: normalizeText(event.sessionName),
    sessionPersisted: Boolean(event.sessionPersisted),
    cwd: normalizeText(event.cwd),
    eventType: normalizeText(event.eventType) || "event",
    source: normalizeText(event.source),
    trigger: normalizeText(event.trigger),
    turnIndex: normalizeOptionalInt(event.turnIndex),
    phase: normalizeText(event.phase),
    provider: normalizeText(event.provider),
    model: normalizeText(event.model),
    thinkingLevel: normalizeText(event.thinkingLevel),
    messageId: normalizeText(event.messageId),
    messageRole: normalizeText(event.messageRole),
    stopReason: normalizeText(event.stopReason),
    toolCallId: normalizeText(event.toolCallId),
    toolName: normalizeText(event.toolName),
    toolCallCount: normalizeInt(event.toolCallCount),
    toolNames: normalizeToolNames(event.toolNames),
    capabilityKind: normalizeText(event.capabilityKind),
    capabilityKey: normalizeText(event.capabilityKey),
    inputTokens: normalizeInt(event.inputTokens),
    outputTokens: normalizeInt(event.outputTokens),
    cacheReadTokens: normalizeInt(event.cacheReadTokens),
    cacheWriteTokens: normalizeInt(event.cacheWriteTokens),
    totalTokens: normalizeInt(event.totalTokens),
    costInput: safeNumber(event.costInput),
    costOutput: safeNumber(event.costOutput),
    costCacheRead: safeNumber(event.costCacheRead),
    costCacheWrite: safeNumber(event.costCacheWrite),
    costTotal: safeNumber(event.costTotal),
    contextTokens: normalizeInt(event.contextTokens),
    isError: Boolean(event.isError),
    metadata: normalizeMetadata(event.metadata),
  } satisfies Omit<NormalizedTokenTelemetryEvent, "id">;
  return {
    id: normalizeText(event.id) || stableEventId(normalizedWithoutId),
    ...normalizedWithoutId,
  };
}

export function appendTokenTelemetryEvent(
  event: TokenTelemetryEvent,
  agentDir = "",
): { id: string } {
  const db = openTokenUsageDb(agentDir);
  const normalized = normalizeTokenTelemetryEvent(event);
  const insert = prepareCached(
    db,
    `
    INSERT OR IGNORE INTO telemetry_events (
      id,
      timestamp,
      session_id,
      session_file,
      session_name,
      session_persisted,
      cwd,
      event_type,
      source,
      trigger,
      turn_index,
      phase,
      provider,
      model,
      thinking_level,
      message_id,
      message_role,
      stop_reason,
      tool_call_id,
      tool_name,
      tool_call_count,
      tool_names_json,
      capability_kind,
      capability_key,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      total_tokens,
      cost_input,
      cost_output,
      cost_cache_read,
      cost_cache_write,
      cost_total,
      context_tokens,
      is_error,
      metadata_json
    ) VALUES (
      @id,
      @timestamp,
      @session_id,
      @session_file,
      @session_name,
      @session_persisted,
      @cwd,
      @event_type,
      @source,
      @trigger,
      @turn_index,
      @phase,
      @provider,
      @model,
      @thinking_level,
      @message_id,
      @message_role,
      @stop_reason,
      @tool_call_id,
      @tool_name,
      @tool_call_count,
      @tool_names_json,
      @capability_kind,
      @capability_key,
      @input_tokens,
      @output_tokens,
      @cache_read_tokens,
      @cache_write_tokens,
      @total_tokens,
      @cost_input,
      @cost_output,
      @cost_cache_read,
      @cost_cache_write,
      @cost_total,
      @context_tokens,
      @is_error,
      @metadata_json
    )
  `,
  );
  insert.run({
    id: normalized.id,
    timestamp: normalized.timestamp,
    session_id: normalized.sessionId || null,
    session_file: normalized.sessionFile || null,
    session_name: normalized.sessionName || null,
    session_persisted: normalized.sessionPersisted ? 1 : 0,
    cwd: normalized.cwd || null,
    event_type: normalized.eventType,
    source: normalized.source || null,
    trigger: normalized.trigger || null,
    turn_index: normalized.turnIndex,
    phase: normalized.phase || null,
    provider: normalized.provider || null,
    model: normalized.model || null,
    thinking_level: normalized.thinkingLevel || null,
    message_id: normalized.messageId || null,
    message_role: normalized.messageRole || null,
    stop_reason: normalized.stopReason || null,
    tool_call_id: normalized.toolCallId || null,
    tool_name: normalized.toolName || null,
    tool_call_count: normalized.toolCallCount,
    tool_names_json: safeJsonStringify(normalized.toolNames.length ? normalized.toolNames : null),
    capability_kind: normalized.capabilityKind || null,
    capability_key: normalized.capabilityKey || null,
    input_tokens: normalized.inputTokens,
    output_tokens: normalized.outputTokens,
    cache_read_tokens: normalized.cacheReadTokens,
    cache_write_tokens: normalized.cacheWriteTokens,
    total_tokens: normalized.totalTokens,
    cost_input: normalized.costInput,
    cost_output: normalized.costOutput,
    cost_cache_read: normalized.costCacheRead,
    cost_cache_write: normalized.costCacheWrite,
    cost_total: normalized.costTotal,
    context_tokens: normalized.contextTokens,
    is_error: normalized.isError ? 1 : 0,
    metadata_json: safeJsonStringify(normalized.metadata),
  });
  return { id: normalized.id };
}

export function getTokenUsageOverview(
  options: Omit<TokenUsageQueryOptions, "groupBy" | "orderBy" | "direction"> = {},
) {
  const db = openTokenUsageDb(options.agentDir || "");
  const { whereSql, params } = buildWhereClause(options, false);
  return normalizeOverviewRow(
    prepareCached(
      db,
      `
        SELECT
          COUNT(*) AS total_events,
          SUM(CASE WHEN total_tokens > 0 THEN 1 ELSE 0 END) AS token_events,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(total_tokens) AS total_tokens,
          SUM(cost_total) AS cost_total,
          COUNT(DISTINCT NULLIF(session_id, '')) AS session_count,
          COUNT(DISTINCT CASE
            WHEN COALESCE(provider, '') <> '' AND COALESCE(model, '') <> '' THEN provider || '/' || model
            WHEN COALESCE(model, '') <> '' THEN model
            ELSE NULL
          END) AS model_count,
          MIN(timestamp) AS first_timestamp,
          MAX(timestamp) AS last_timestamp
        FROM telemetry_events
        ${whereSql}
      `,
    ).get(params),
  );
}

type DimensionDef = {
  select: string;
  filter: string;
};

const DIMENSIONS: Record<string, DimensionDef> = {
  day: {
    select: `substr(timestamp, 1, 10)`,
    filter: `substr(timestamp, 1, 10)`,
  },
  hour: {
    select: `substr(timestamp, 1, 13) || ':00'`,
    filter: `substr(timestamp, 1, 13) || ':00'`,
  },
  session_id: {
    select: `COALESCE(NULLIF(session_id, ''), '(none)')`,
    filter: `COALESCE(NULLIF(session_id, ''), '(none)')`,
  },
  session_name: {
    select: `COALESCE(NULLIF(session_name, ''), '(none)')`,
    filter: `COALESCE(NULLIF(session_name, ''), '(none)')`,
  },
  session_file: {
    select: `COALESCE(NULLIF(session_file, ''), '(none)')`,
    filter: `COALESCE(NULLIF(session_file, ''), '(none)')`,
  },
  session_persisted: {
    select: `CASE WHEN session_persisted = 1 THEN 'yes' ELSE 'no' END`,
    filter: `CASE WHEN session_persisted = 1 THEN 'yes' ELSE 'no' END`,
  },
  cwd: {
    select: `COALESCE(NULLIF(cwd, ''), '(none)')`,
    filter: `COALESCE(NULLIF(cwd, ''), '(none)')`,
  },
  event_type: {
    select: `COALESCE(NULLIF(event_type, ''), '(none)')`,
    filter: `COALESCE(NULLIF(event_type, ''), '(none)')`,
  },
  source: {
    select: `COALESCE(NULLIF(source, ''), '(none)')`,
    filter: `COALESCE(NULLIF(source, ''), '(none)')`,
  },
  trigger: {
    select: `COALESCE(NULLIF(trigger, ''), '(none)')`,
    filter: `COALESCE(NULLIF(trigger, ''), '(none)')`,
  },
  provider: {
    select: `COALESCE(NULLIF(provider, ''), '(none)')`,
    filter: `COALESCE(NULLIF(provider, ''), '(none)')`,
  },
  model: {
    select: `COALESCE(NULLIF(model, ''), '(none)')`,
    filter: `COALESCE(NULLIF(model, ''), '(none)')`,
  },
  provider_model: {
    select: `COALESCE(NULLIF(CASE WHEN COALESCE(provider, '') <> '' AND COALESCE(model, '') <> '' THEN provider || '/' || model WHEN COALESCE(model, '') <> '' THEN model ELSE '' END, ''), '(none)')`,
    filter: `COALESCE(NULLIF(CASE WHEN COALESCE(provider, '') <> '' AND COALESCE(model, '') <> '' THEN provider || '/' || model WHEN COALESCE(model, '') <> '' THEN model ELSE '' END, ''), '(none)')`,
  },
  thinking_level: {
    select: `COALESCE(NULLIF(thinking_level, ''), '(none)')`,
    filter: `COALESCE(NULLIF(thinking_level, ''), '(none)')`,
  },
  message_role: {
    select: `COALESCE(NULLIF(message_role, ''), '(none)')`,
    filter: `COALESCE(NULLIF(message_role, ''), '(none)')`,
  },
  stop_reason: {
    select: `COALESCE(NULLIF(stop_reason, ''), '(none)')`,
    filter: `COALESCE(NULLIF(stop_reason, ''), '(none)')`,
  },
  tool_name: {
    select: `COALESCE(NULLIF(tool_name, ''), '(none)')`,
    filter: `COALESCE(NULLIF(tool_name, ''), '(none)')`,
  },
  capability: {
    select: `COALESCE(NULLIF(capability_key, ''), '(none)')`,
    filter: `COALESCE(NULLIF(capability_key, ''), '(none)')`,
  },
  capability_kind: {
    select: `COALESCE(NULLIF(capability_kind, ''), '(none)')`,
    filter: `COALESCE(NULLIF(capability_kind, ''), '(none)')`,
  },
  turn_index: {
    select: `COALESCE(CAST(turn_index AS TEXT), '(none)')`,
    filter: `COALESCE(CAST(turn_index AS TEXT), '(none)')`,
  },
  is_error: {
    select: `CASE WHEN is_error = 1 THEN 'yes' ELSE 'no' END`,
    filter: `CASE WHEN is_error = 1 THEN 'yes' ELSE 'no' END`,
  },
};

export function listTokenUsageDimensions(): string[] {
  return Object.keys(DIMENSIONS).sort();
}

function buildWhereClause(options: TokenUsageQueryOptions, forAggregate: boolean) {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (safeString(options.from).trim()) {
    clauses.push(`timestamp >= @from`);
    params.from = safeString(options.from).trim();
  }
  if (safeString(options.to).trim()) {
    clauses.push(`timestamp <= @to`);
    params.to = safeString(options.to).trim();
  }
  if (forAggregate && !options.includeZero) {
    clauses.push(`total_tokens > 0`);
  }
  for (const [index, filter] of (options.filters || []).entries()) {
    const def = DIMENSIONS[safeString(filter.key).trim()];
    if (!def) throw new Error(`unsupported_filter:${filter.key}`);
    const paramKey = `filter_${index}`;
    clauses.push(`${def.filter} = @${paramKey}`);
    params[paramKey] = safeString(filter.value).trim();
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function queryTokenUsageAggregate(options: TokenUsageQueryOptions = {}) {
  const db = openTokenUsageDb(options.agentDir || "");
  const groupBy = Array.isArray(options.groupBy) ? options.groupBy : [];
  const dims = groupBy.map((key) => {
    const def = DIMENSIONS[key];
    if (!def) throw new Error(`unsupported_group_by:${key}`);
    return { key, ...def };
  });
  const { whereSql, params } = buildWhereClause(options, true);
  const selectDims = dims.map((dim) => `${dim.select} AS "${dim.key}"`);
  const groupSql = dims.length
    ? `GROUP BY ${dims.map((dim) => dim.select).join(", ")}`
    : "";
  const orderBy = safeString(options.orderBy).trim() || "total_tokens";
  const direction = safeString(options.direction).trim().toLowerCase() === "asc"
    ? "ASC"
    : "DESC";
  const supportedOrder = new Set([...dims.map((dim) => dim.key), ...AGGREGATE_ORDER_FIELDS]);
  const orderExpr = supportedOrder.has(orderBy)
    ? `"${orderBy}"`
    : `"total_tokens"`;
  const limit = clampQueryLimit(options.limit, DEFAULT_AGGREGATE_LIMIT);
  const sql = `
    SELECT
      ${selectDims.length ? `${selectDims.join(",\n      ")},` : ""}
      ${AGGREGATE_METRICS.map((metric) => `${metric.select} AS ${metric.key}`).join(",\n      ")}
    FROM telemetry_events
    ${whereSql}
    ${groupSql}
    ORDER BY ${orderExpr} ${direction}
    LIMIT @limit
  `;
  return prepareCached(db, sql).all({ ...params, limit }) as any[];
}

export function queryTokenUsageEvents(options: TokenUsageQueryOptions = {}) {
  const db = openTokenUsageDb(options.agentDir || "");
  const { whereSql, params } = buildWhereClause(options, false);
  const limit = clampQueryLimit(options.limit, DEFAULT_EVENTS_LIMIT);
  return prepareCached(
    db,
    `
      SELECT
        timestamp,
        session_id,
        session_name,
        session_file,
        source,
        event_type,
        provider,
        model,
        thinking_level,
        message_role,
        stop_reason,
        tool_name,
        capability_kind,
        capability_key,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_total,
        turn_index,
        is_error
      FROM telemetry_events
      ${whereSql}
      ORDER BY timestamp DESC
      LIMIT @limit
    `,
  ).all({ ...params, limit }) as any[];
}
