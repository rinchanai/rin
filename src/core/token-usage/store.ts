import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import BetterSqlite3 from "better-sqlite3";

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

const AGGREGATE_ORDER_FIELDS = new Set([
  "rows",
  "token_events",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_total",
  "context_tokens",
]);

function safeString(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function safeNumber(value: unknown): number {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function normalizeInt(value: unknown): number {
  return Math.max(0, Math.round(safeNumber(value)));
}

function nowIso() {
  return new Date().toISOString();
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
  );
}

function stableEventId(event: TokenTelemetryEvent): string {
  const seed = [
    safeString(event.sessionId).trim(),
    safeString(event.eventType).trim(),
    safeString(event.messageId).trim(),
    safeString(event.toolCallId).trim(),
    safeString(event.timestamp).trim(),
    safeString(event.turnIndex).trim(),
    safeString(event.capabilityKey).trim(),
    Math.random().toString(36).slice(2, 10),
  ].join("|");
  return seed || `evt_${Date.now().toString(36)}`;
}

export function appendTokenTelemetryEvent(
  event: TokenTelemetryEvent,
  agentDir = "",
): { id: string } {
  const db = openTokenUsageDb(agentDir);
  const normalized: TokenTelemetryEvent = {
    ...event,
    timestamp: safeString(event.timestamp).trim() || nowIso(),
    toolNames: normalizeToolNames(event.toolNames),
  };
  normalized.id = safeString(event.id).trim() || stableEventId(normalized);
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
    session_id: safeString(normalized.sessionId).trim() || null,
    session_file: safeString(normalized.sessionFile).trim() || null,
    session_name: safeString(normalized.sessionName).trim() || null,
    session_persisted: normalized.sessionPersisted ? 1 : 0,
    cwd: safeString(normalized.cwd).trim() || null,
    event_type: safeString(normalized.eventType).trim() || "event",
    source: safeString(normalized.source).trim() || null,
    trigger: safeString(normalized.trigger).trim() || null,
    turn_index:
      normalized.turnIndex == null ? null : Math.round(safeNumber(normalized.turnIndex)),
    phase: safeString(normalized.phase).trim() || null,
    provider: safeString(normalized.provider).trim() || null,
    model: safeString(normalized.model).trim() || null,
    thinking_level: safeString(normalized.thinkingLevel).trim() || null,
    message_id: safeString(normalized.messageId).trim() || null,
    message_role: safeString(normalized.messageRole).trim() || null,
    stop_reason: safeString(normalized.stopReason).trim() || null,
    tool_call_id: safeString(normalized.toolCallId).trim() || null,
    tool_name: safeString(normalized.toolName).trim() || null,
    tool_call_count: normalizeInt(normalized.toolCallCount),
    tool_names_json: normalized.toolNames?.length
      ? JSON.stringify(normalized.toolNames)
      : null,
    capability_kind: safeString(normalized.capabilityKind).trim() || null,
    capability_key: safeString(normalized.capabilityKey).trim() || null,
    input_tokens: normalizeInt(normalized.inputTokens),
    output_tokens: normalizeInt(normalized.outputTokens),
    cache_read_tokens: normalizeInt(normalized.cacheReadTokens),
    cache_write_tokens: normalizeInt(normalized.cacheWriteTokens),
    total_tokens: normalizeInt(normalized.totalTokens),
    cost_input: safeNumber(normalized.costInput),
    cost_output: safeNumber(normalized.costOutput),
    cost_cache_read: safeNumber(normalized.costCacheRead),
    cost_cache_write: safeNumber(normalized.costCacheWrite),
    cost_total: safeNumber(normalized.costTotal),
    context_tokens: normalizeInt(normalized.contextTokens),
    is_error: normalized.isError ? 1 : 0,
    metadata_json: normalized.metadata ? JSON.stringify(normalized.metadata) : null,
  });
  return { id: normalized.id };
}

export function getTokenUsageOverview(
  options: Omit<TokenUsageQueryOptions, "groupBy" | "orderBy" | "direction"> = {},
) {
  const db = openTokenUsageDb(options.agentDir || "");
  const { whereSql, params } = buildWhereClause(options, false);
  return prepareCached(
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
  ).get(params) as any;
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
  const limit = Math.max(1, Math.min(500, Math.round(safeNumber(options.limit || 20))));
  const sql = `
    SELECT
      ${selectDims.length ? `${selectDims.join(",\n      ")},` : ""}
      COUNT(*) AS rows,
      SUM(CASE WHEN total_tokens > 0 THEN 1 ELSE 0 END) AS token_events,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(cost_total) AS cost_total,
      MAX(context_tokens) AS context_tokens
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
  const limit = Math.max(1, Math.min(500, Math.round(safeNumber(options.limit || 40))));
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
