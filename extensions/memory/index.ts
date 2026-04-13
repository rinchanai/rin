import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { keyHint } from "../../third_party/pi-coding-agent/src/modes/interactive/components/keybinding-hints.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "../../third_party/pi-coding-agent/src/core/tools/truncate.js";
import {
  getTextOutput,
  replaceTabs,
} from "../../third_party/pi-coding-agent/src/core/tools/render-utils.js";

import {
  appendTranscriptArchiveEntry,
  loadRecentTranscriptSessions,
  loadTranscriptSessionEntries,
  searchTranscriptArchive,
} from "./transcripts.js";
import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { loadAuxiliaryModelConfig } from "../../src/core/rin-lib/auxiliary-model.js";

const searchMemoryParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Optional search query for past sessions. Leave it empty to browse recent sessions directly. For broad recall, prefer a few distinctive keywords joined by OR; use quoted phrases for exact wording when needed. If you do not have a good search phrase yet, call search_memory without a query first.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 8,
      description:
        "Maximum number of transcript matches or session summaries to return.",
    }),
  ),
});

async function archiveMessageTranscript(message: any, ctx: any) {
  if (!message || typeof message !== "object") return;
  await appendTranscriptArchiveEntry(
    {
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
    },
    String(ctx?.agentDir || "").trim(),
  );
}

function trimSnippet(value: string, max = 220): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatSearchResult(response: any): string {
  const summaries = Array.isArray(response?.summaries) ? response.summaries : [];
  const rows = summaries.length
    ? summaries.map((item: any) => ({
        title: String(item?.timestamp || item?.sessionId || "Session").trim() || "Session",
        snippet: String(item?.summary || "").trim(),
      }))
    : Array.isArray(response?.results)
      ? response.results.map((item: any) => ({
          title:
            String(item?.timestamp || "").trim() ||
            String(item?.sourceType === "session" ? "Session" : "Transcript"),
          snippet: String(item?.preview || item?.description || "").trim(),
        }))
      : [];
  if (!rows.length) return "No memory results found.";
  return rows
    .slice(0, 3)
    .map((item: any) => [item.title, trimSnippet(item.snippet)].filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatAgentSearchResult(response: any): string {
  const summaries = Array.isArray(response?.summaries) ? response.summaries : [];
  if (summaries.length) {
    return [
      `search_memory ${summaries.length}`,
      ...summaries.map((item: any, index: number) => {
        const title = String(item?.timestamp || item?.sessionId || "Session").trim() || "Session";
        const snippet = trimSnippet(String(item?.summary || "").trim());
        return [`${index + 1}. ${title}`, snippet].filter(Boolean).join("\n");
      }),
    ].join("\n\n");
  }

  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return "search_memory 0";
  return [
    `search_memory ${rows.length}`,
    ...rows.map((item: any, index: number) => {
      const title =
        String(item?.timestamp || "").trim() ||
        String(item?.sourceType === "session" ? "Session" : "Transcript");
      const snippet = trimSnippet(
        String(item?.preview || item?.description || "").trim(),
      );
      return [`${index + 1}. ${title}`, snippet].filter(Boolean).join("\n");
    }),
  ].join("\n\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function formatMemoryResult(
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: {
      truncation?: TruncationResult;
      emptyMessage?: string;
      hiddenCount?: number;
      totalResults?: number;
    };
  },
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  const output = getTextOutput(result, showImages);
  const lines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  let text = "";
  if (displayLines.length > 0) {
    text = `\n${displayLines
      .map((line) => theme.fg("toolOutput", replaceTabs(line)))
      .join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand" as any, "to expand")})`;
    }
  } else if (result.details?.emptyMessage) {
    text = `\n${theme.fg("muted", result.details.emptyMessage)}`;
  }

  if ((result.details?.hiddenCount ?? 0) > 0) {
    text += `\n${theme.fg("muted", `[Showing top ${Math.max((result.details?.totalResults ?? 0) - (result.details?.hiddenCount ?? 0), 0)} of ${result.details?.totalResults} results.]`)}`;
  }

  const truncation = result.details?.truncation;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
    } else {
      text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
    }
  }

  return text;
}

function buildRecallPrompt(query: string, transcript: string): string {
  const focus = query
    ? `Search focus: ${query}`
    : "Search focus: none provided — produce a compact recall summary for recent-session browsing.";
  return [
    "Review the archived session transcript below and write a factual recall summary.",
    focus,
    "Prioritize the details that help another agent quickly recover the real work state.",
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
    const normalizedParams = {
      ...(params || {}),
      limit: Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 8,
    };
    const results = query
      ? await searchTranscriptArchive(query, normalizedParams)
      : await loadRecentTranscriptSessions(normalizedParams);
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
    const agentText = formatAgentSearchResult(response);
    const userText = formatSearchResult(response);
    const truncation = truncateHead(agentText);
    let outputText = truncation.content;
    const visibleRows = Array.isArray(response?.summaries) && response.summaries.length
      ? response.summaries
      : Array.isArray(response?.results)
        ? response.results
        : [];
    const hiddenCount = visibleRows.length > 3 ? visibleRows.length - 3 : 0;
    const details: {
      truncation?: TruncationResult;
      emptyMessage?: string;
      hiddenCount?: number;
      totalResults?: number;
      userText?: string;
    } = {
      hiddenCount,
      totalResults: visibleRows.length,
      userText,
    };

    if (!visibleRows.length) {
      details.emptyMessage = "No memory results found.";
    }

    if (truncation.truncated) {
      details.truncation = truncation;
      if (truncation.truncatedBy === "lines") {
        outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
      } else {
        outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit).]`;
      }
    }
    return {
      content: [{ type: "text" as const, text: outputText }],
      details,
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

function renderMemoryResult(result: any, options: any, theme: any, context: any) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const details = (result.details as any) || {};
  const userResult = {
    content: [{ type: "text", text: String(details.userText || "") }],
    details: {
      truncation: details.truncation,
      emptyMessage: details.emptyMessage,
      hiddenCount: details.hiddenCount,
      totalResults: details.totalResults,
    },
  };
  text.setText(formatMemoryResult(userResult, options, theme, context.showImages));
  return text;
}

function formatSearchMemoryCall(args: any, theme: any) {
  const query = String(args?.query || "").trim();
  if (!query) {
    return `${theme.fg("toolTitle", theme.bold("search_memory"))} ${theme.fg("muted", "recent")}`;
  }
  return `${theme.fg("toolTitle", theme.bold("search_memory"))} ${theme.fg("accent", query)}`;
}

export default function memoryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search_memory",
    label: "Search Memory",
    description:
      "Search past sessions for long-term recall, or browse recent sessions directly when no query is provided.",
    promptSnippet: "Search archived session history.",
    promptGuidelines: [
      "Use search_memory proactively for past-conversation recall when the user references earlier work or relevant cross-session context may matter; better to search and confirm than to guess or ask them to repeat themselves.",
      "If you do not have a good search phrase yet, call search_memory without a query to browse recent sessions first.",
    ],
    parameters: searchMemoryParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      (await executeSearchMemory(
        params,
        ctx,
        pi.getThinkingLevel() as ThinkingLevel,
      )) as any,
    renderCall: (args, theme) => new Text(formatSearchMemoryCall(args, theme), 0, 0),
    renderResult: renderMemoryResult,
  });

  pi.on("message_end", async (event, ctx) => {
    await archiveMessageTranscript(event?.message, ctx);
  });
}
