import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import type { MemoryEvent } from "./core/types.js";
import {
  normalizeList,
  nowIso,
  safeString,
  sha,
  slugify,
  trimText,
} from "./core/utils.js";

export function eventLogPath(
  rootDir: string,
  date = nowIso().slice(0, 10),
): string {
  return path.join(rootDir, "events", `${date}.jsonl`);
}

export function sessionKey(meta: Partial<MemoryEvent>): string {
  const sessionFile = safeString(meta.session_file).trim();
  const sessionId = safeString(meta.session_id).trim();
  if (sessionFile)
    return slugify(
      path.basename(sessionFile, path.extname(sessionFile)),
      "session",
    );
  if (sessionId) return slugify(sessionId, "session");
  return "session";
}

export function eventSummary(
  kind: MemoryEvent["kind"],
  text: string,
  toolName = "",
  isError = false,
): string {
  if (kind === "tool_result")
    return `${toolName || "tool"}${isError ? " (error)" : ""}: ${trimText(text, 180)}`;
  if (kind === "assistant_message") return `assistant: ${trimText(text, 180)}`;
  if (kind === "user_input") return `user: ${trimText(text, 180)}`;
  return trimText(text, 180);
}

export function normalizeMessageText(text: string): string {
  return safeString(text).replace(/\r/g, "").trim();
}

export function eventChronicleLine(event: MemoryEvent): string {
  const timestamp = safeString(event.created_at).slice(11, 16) || "??:??";
  return `- [${timestamp}] ${event.summary}`;
}

export function serializeEvent(record: MemoryEvent): string {
  return JSON.stringify(record);
}

export function parseEventLine(line: string): MemoryEvent | null {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      id: safeString((parsed as any).id || ""),
      created_at: safeString((parsed as any).created_at || nowIso()),
      kind: ((parsed as any).kind || "system_note") as any,
      session_id: safeString((parsed as any).session_id || ""),
      session_file: safeString((parsed as any).session_file || ""),
      cwd: safeString((parsed as any).cwd || ""),
      chat_key: safeString((parsed as any).chat_key || ""),
      source: safeString((parsed as any).source || ""),
      tool_name: safeString((parsed as any).tool_name || ""),
      is_error: Boolean((parsed as any).is_error),
      summary: safeString((parsed as any).summary || ""),
      text: safeString((parsed as any).text || ""),
      tags: normalizeList((parsed as any).tags || []),
    };
  } catch {
    return null;
  }
}

export async function loadEvents(
  rootDir: string,
  options: { since?: string; limit?: number } = {},
): Promise<MemoryEvent[]> {
  const eventsDir = path.join(rootDir, "events");
  if (!fssync.existsSync(eventsDir)) return [];
  const files = (await fs.readdir(eventsDir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const out: MemoryEvent[] = [];
  for (const name of files) {
    const text = await fs
      .readFile(path.join(eventsDir, name), "utf8")
      .catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = parseEventLine(line);
      if (!event) continue;
      if (
        options.since &&
        safeString(event.created_at) <= safeString(options.since)
      )
        continue;
      out.push(event);
    }
  }
  out.sort((a, b) =>
    safeString(a.created_at).localeCompare(safeString(b.created_at)),
  );
  if (options.limit && out.length > options.limit)
    return out.slice(-options.limit);
  return out;
}

export async function logMemoryEventRecord(
  root: string,
  params: Record<string, any> = {},
) {
  const text = normalizeMessageText(
    safeString(params.text || params.summary || ""),
  );
  const record: MemoryEvent = {
    id: safeString(
      params.id ||
        `evt_${Date.now().toString(36)}_${sha(`${nowIso()}\n${text}\n${Math.random()}`).slice(0, 8)}`,
    ),
    created_at: safeString(params.created_at || nowIso()),
    kind: (safeString(params.kind || "system_note") || "system_note") as any,
    session_id: safeString(params.sessionId || params.session_id || "").trim(),
    session_file: safeString(
      params.sessionFile || params.session_file || "",
    ).trim(),
    cwd: safeString(params.cwd || "").trim(),
    chat_key: safeString(params.chatKey || params.chat_key || "").trim(),
    source: safeString(params.source || "").trim(),
    tool_name: safeString(params.toolName || params.tool_name || "").trim(),
    is_error: Boolean(params.isError || params.is_error),
    summary: trimText(
      params.summary ||
        eventSummary(
          (safeString(params.kind || "system_note") || "system_note") as any,
          text,
          safeString(params.toolName || params.tool_name || ""),
          Boolean(params.isError || params.is_error),
        ),
      220,
    ),
    text: trimText(text, 4000),
    tags: normalizeList(params.tags || []),
  };
  const filePath = eventLogPath(root, record.created_at.slice(0, 10));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${serializeEvent(record)}\n`, "utf8");
  return record;
}
