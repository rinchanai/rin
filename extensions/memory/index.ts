import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  appendTaskAnchorArchiveEntry,
  appendTranscriptArchiveEntry,
  loadRecentTranscriptSessions,
  loadTranscriptSessionEntries,
  searchTranscriptArchive,
} from "./transcripts.js";
import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { loadAuxiliaryModelConfig } from "../../src/core/rin-lib/auxiliary-model.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

const searchMemoryParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Optional search query for past sessions. Leave it empty to browse recent sessions directly. For broad recall, prefer a few distinctive keywords joined by OR; use quoted phrases for exact wording when needed.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      description:
        "Maximum number of transcript matches or session summaries to return.",
    }),
  ),
  fidelity: Type.Optional(
    Type.Union([Type.Literal("exact"), Type.Literal("fuzzy")], {
      description:
        "Optional match mode: `exact` for strict substring matching, `fuzzy` for broader recall. Omit it if you are unsure.",
    }),
  ),
});

async function archiveMessageTranscript(message: any, ctx: any) {
  if (!message || typeof message !== "object") return;
  const entry = {
    id: String(message?.id || "").trim(),
    timestamp:
      String(message?.timestamp || "").trim() || new Date().toISOString(),
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
    sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
    role: String(message?.role || "").trim(),
    content: message?.content,
    toolName: String(message?.toolName || "").trim(),
    toolCallId: String(message?.toolCallId || "").trim(),
    customType: String(message?.customType || "").trim(),
    stopReason: String(message?.stopReason || "").trim(),
    errorMessage: String(message?.errorMessage || "").trim(),
    provider: String(message?.provider || "").trim(),
    model: String(message?.model || "").trim(),
    display:
      typeof message?.display === "boolean" ? message.display : undefined,
    command: message?.command,
    output: message?.output,
    summary: message?.summary,
    text: String(message?.content || "").trim(),
  };
  const root = String(ctx?.agentDir || "").trim();
  await appendTranscriptArchiveEntry(entry, root);
  await appendTaskAnchorArchiveEntry(entry, root);
}

function formatSearchResult(response: any): string {
  const query = String(response?.query || "").trim();
  const mode = String(response?.mode || "search").trim();
  const summaries = Array.isArray(response?.summaries)
    ? response.summaries
    : [];
  if (summaries.length) {
    return [
      mode === "recent"
        ? "Recent session recall"
        : `Session recall for: ${query}`,
      ...summaries.map((item: any, index: number) => {
        const meta = [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          String(item?.sessionId || "").trim(),
          String(item?.timestamp || "").trim(),
        ]
          .filter(Boolean)
          .join(" • ");
        return [
          `${index + 1}. Session — ${meta}`,
          String(item?.path || "").trim(),
          String(item?.summary || "").trim(),
        ]
          .filter(Boolean)
          .join("\n");
      }),
    ].join("\n\n");
  }

  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) {
    return mode === "recent"
      ? "No recent sessions found"
      : `No transcript matches for: ${query}`;
  }
  return [
    mode === "recent" ? "Recent sessions" : `Transcript matches for: ${query}`,
    ...rows.map((item: any, index: number) => {
      const kind = item?.sourceType === "session" ? "Session" : "Transcript";
      const meta = [
        `score=${Number(item?.score || 0).toFixed(2)}`,
        String(item?.role || "").trim(),
        String(item?.timestamp || "").trim(),
      ]
        .filter(Boolean)
        .join(" • ");
      return [
        `${index + 1}. ${kind} — ${meta}`,
        String(item?.path || "").trim(),
        String(item?.preview || item?.description || "").trim(),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function formatAgentSearchResult(response: any): string {
  const query = String(response?.query || "").trim();
  const mode = String(response?.mode || "search").trim();
  const head =
    mode === "recent"
      ? `memory recent (${Number(response?.count || 0)})`
      : `memory search ${query} (${Number(response?.count || 0)})`;
  const summaries = Array.isArray(response?.summaries)
    ? response.summaries
    : [];
  if (summaries.length) {
    return [
      head,
      ...summaries.map((item: any, index: number) =>
        [
          `${index + 1}. session`,
          `score=${Number(item?.score || 0).toFixed(2)}`,
          String(item?.timestamp || "").trim(),
          `path=${String(item?.path || "")}`,
        ]
          .filter(Boolean)
          .join(" | "),
      ),
    ].join("\n");
  }

  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return head;
  return [
    head,
    ...rows.map((item: any, index: number) =>
      [
        `${index + 1}. ${item?.sourceType === "session" ? "session" : "transcript"}`,
        `score=${Number(item?.score || 0).toFixed(2)}`,
        String(item?.role || "").trim(),
        String(item?.timestamp || "").trim(),
        `path=${String(item?.path || "")}`,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  ].join("\n");
}

function buildRecallPrompt(query: string, transcript: string): string {
  const focus = query
    ? `Search focus: ${query}`
    : "Search focus: none provided — produce a compact recall summary for recent-session browsing.";
  return [
    "Review the archived session transcript below and write a factual recall summary.",
    focus,
    "Prioritize the details that help another agent quickly recover the real work state.",
    "If task-anchor rows are present, treat them as high-signal state markers for done steps, blockers, and next actions.",
    "Include, when present and relevant: the user's goal, key decisions, important tool calls, commands, file paths, URLs, browser/account steps, concrete outcomes, and anything still unresolved.",
    "Prefer exact details from the transcript over abstraction. Keep chronology only where it helps explain state changes.",
    "Do not add speculation or generic filler.",
    "Return plain text only in this shape:",
    "Goal: ...\nKey steps: ...\nOutcome: ...\nOpen threads: ...",
    "TRANSCRIPT:",
    transcript,
  ].join("\n\n");
}

async function maybeSummarizeTranscriptMatches(
  results: any[],
  params: any,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return [];
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!agentDir) return [];
  const config = await loadAuxiliaryModelConfig(agentDir);
  const fallbackModel = ctx?.model
    ? `${String(ctx.model.provider || "")}/${String(ctx.model.id || "")}`
    : "";
  const modelRef = String(config.modelRef || fallbackModel).trim();
  if (!modelRef) return [];

  const grouped = new Map<string, any>();
  for (const row of rows) {
    const key = String(
      row?.sessionFile || row?.sessionId || row?.path || "",
    ).trim();
    if (!key || grouped.has(key)) continue;
    grouped.set(key, row);
    if (grouped.size >= Math.min(3, rows.length)) break;
  }

  const tasks = [] as any[];
  const taskRows = [] as any[];
  const sessionRows = [...grouped.values()];
  for (const row of sessionRows) {
    const entries = await loadTranscriptSessionEntries(
      {
        sessionId: String(row?.sessionId || "").trim(),
        sessionFile: String(row?.sessionFile || "").trim(),
      },
      agentDir,
    );
    if (!entries.length) continue;
    const transcript = entries
      .map(
        (entry) =>
          `${String(entry.role || "").toUpperCase()}: ${String(entry.text || "").trim()}`,
      )
      .join("\n\n")
      .slice(0, 12000);
    tasks.push({
      prompt: buildRecallPrompt(String(params?.query || "").trim(), transcript),
      model: modelRef,
      thinkingLevel:
        (config.thinkingLevel as ThinkingLevel | undefined) ||
        currentThinkingLevel,
    });
    taskRows.push(row);
  }

  if (!tasks.length) return [];
  const run = await executeSubagentRun({
    params: { tasks },
    ctx,
    currentThinkingLevel,
  });
  if (!run.ok || !Array.isArray(run.results)) return [];
  return run.results.map((result: any, index: number) => ({
    sessionId: taskRows[index]?.sessionId,
    sessionFile: taskRows[index]?.sessionFile,
    score: taskRows[index]?.score,
    summary: String(result?.output || result?.errorMessage || "").trim(),
    model: result?.model,
    path: String(taskRows[index]?.path || "").trim(),
  }));
}

async function executeSearchMemory(
  params: any,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
) {
  try {
    const query = String(params?.query || "").trim();
    const mode = query ? "search" : "recent";
    const results = query
      ? await searchTranscriptArchive(query, params)
      : await loadRecentTranscriptSessions(params);
    const summaries = await maybeSummarizeTranscriptMatches(
      results,
      params,
      ctx,
      currentThinkingLevel,
    );
    const response = {
      mode,
      query,
      count: Array.isArray(results) ? results.length : 0,
      results,
      summaries,
    };
    const prepared = await prepareToolTextOutput({
      agentText: formatAgentSearchResult(response),
      userText: formatSearchResult(response),
      tempPrefix: "rin-memory-",
      filename: "memory-search.txt",
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: { ...response, ...prepared },
    };
  } catch (error: any) {
    const message = String(error?.message || error || "memory_search_failed");
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        agentText: message,
        userText: `Memory search failed: ${message}`,
      },
      isError: true,
    };
  }
}

function renderMemoryResult(result: any) {
  const details = result.details as any;
  const fallback =
    result.content?.[0]?.type === "text"
      ? result.content[0].text
      : "(no output)";
  return new Text(String(details?.userText || fallback), 0, 0);
}

export default function memoryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search_memory",
    label: "Search Memory",
    description:
      "Search past sessions for long-term recall, or browse recent sessions directly when no query is provided. Matched sessions are summarized for quick recall, and broad queries work best with a few distinctive keywords joined by OR.",
    promptSnippet: "Search archived session history.",
    promptGuidelines: [
      "Use search_memory proactively for past-conversation recall when the user references earlier work or relevant cross-session context may matter; better to search and confirm than to guess or ask them to repeat themselves.",
      "If you do not have a good search phrase yet, call search_memory without a query to browse recent sessions first.",
      "For broad recall, start with a few distinctive keywords joined by OR, retry with narrower queries if needed, and do not use this tool for self_improve prompts or skills.",
    ],
    parameters: searchMemoryParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      (await executeSearchMemory(
        params,
        ctx,
        pi.getThinkingLevel() as ThinkingLevel,
      )) as any,
    renderResult: renderMemoryResult,
  });

  pi.on("message_end", async (event, ctx) => {
    await archiveMessageTranscript(event?.message, ctx);
  });
}
