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
        "Maximum number of session-level memory results to return. Defaults to 8.",
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

function resultSnippet(item: any): string {
  return trimSnippet(
    String(item?.summary || item?.preview || item?.description || "").trim(),
  );
}

function resultTitle(item: any): string {
  return String(item?.timestamp || item?.sessionId || "Session").trim() || "Session";
}

function formatSearchResult(response: any): string {
  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return "No memory results found.";
  return rows
    .map((item: any) => [resultTitle(item), resultSnippet(item)].filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatAgentSearchResult(response: any): string {
  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return "search_memory 0";
  return [
    `search_memory ${rows.length}`,
    ...rows.map((item: any, index: number) => {
      return [`${index + 1}. ${resultTitle(item)}`, resultSnippet(item)]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
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

function buildTranscriptExcerpt(entries: any[]): string {
  return entries
    .map((entry) => `${String(entry.role || "").toUpperCase()}: ${String(entry.text || "").trim()}`)
    .join("\n\n")
    .slice(0, 12000);
}

function buildMatchedHitsBlock(row: any): string {
  const hits = Array.isArray(row?.matchedEntries) ? row.matchedEntries : [];
  if (!hits.length) return "none";
  return hits
    .map((hit: any, index: number) => {
      return `${index + 1}. ${String(hit?.timestamp || "").trim()} | ${String(hit?.role || "").trim()} | ${String(hit?.preview || "").trim()}`;
    })
    .join("\n");
}

function buildRecallPrompt(query: string, row: any, transcript: string): string {
  const sessionOverview = String(row?.preview || row?.description || "").trim();
  const matchedHits = buildMatchedHitsBlock(row);
  const focus = query
    ? `Search focus: ${query}`
    : "Search focus: none provided — produce a compact one-sentence recall for recent-session browsing.";
  return [
    "Review the archived session transcript below and write exactly one factual sentence.",
    focus,
    `Session overview candidate: ${sessionOverview || "(none)"}`,
    `Matched search hits within the session:\n${matchedHits}`,
    "The sentence must fuse the session's overall work with why it matched the current search focus.",
    "Prefer concrete modules, files, commands, URLs, and outcomes when they matter.",
    "Do not quote or enumerate the matched hits. Do not use bullets. Do not add filler.",
    "TRANSCRIPT:",
    transcript,
  ].join("\n\n");
}

export async function maybeSummarizeTranscriptMatches(
  results: any[],
  query: string,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
  runSubagent = executeSubagentRun,
) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return rows;
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!agentDir) {
    throw new Error("search_memory requires agentDir for transcript summarization.");
  }

  const config = await loadAuxiliaryModelConfig(agentDir);
  const fallbackModel = ctx?.model
    ? `${String(ctx.model.provider || "")}/${String(ctx.model.id || "")}`
    : "";
  const modelRef = String(config.modelRef || fallbackModel).trim();
  if (!modelRef) {
    throw new Error("search_memory summarization requires an available model.");
  }

  const tasks: any[] = [];
  const taskRows: any[] = [];
  for (const row of rows) {
    const entries = await loadTranscriptSessionEntries(
      {
        sessionId: String(row?.sessionId || "").trim(),
        sessionFile: String(row?.sessionFile || "").trim(),
      },
      agentDir,
    );
    if (!entries.length) continue;
    tasks.push({
      prompt: buildRecallPrompt(query, row, buildTranscriptExcerpt(entries)),
      model: modelRef,
      thinkingLevel: config.thinkingLevel || currentThinkingLevel,
      disabledExtensions: ["memory"],
    });
    taskRows.push(row);
  }

  if (!tasks.length) return rows;

  const run = await runSubagent({
    params: { tasks },
    ctx,
    currentThinkingLevel,
  });
  if (!run.ok) {
    throw new Error(
      String(("error" in run && run.error) || "search_memory summarization failed."),
    );
  }
  if (!Array.isArray(run.results)) {
    throw new Error("search_memory summarization returned no results.");
  }

  const summaryBySession = new Map();
  run.results.forEach((result: any, index: number) => {
    const row = taskRows[index];
    if (!row) return;
    if (Number(result?.exitCode || 0) !== 0) {
      throw new Error(
        String(result?.errorMessage || `search_memory summarization failed for result ${index + 1}.`),
      );
    }
    const summary = String(result?.output || "").trim();
    if (!summary) {
      throw new Error(`search_memory summarization returned empty output for result ${index + 1}.`);
    }
    const key = String(row?.sessionFile || row?.sessionId || row?.path || "").trim();
    if (!key) return;
    summaryBySession.set(key, summary);
  });

  return rows.map((row) => {
    const key = String(row?.sessionFile || row?.sessionId || row?.path || "").trim();
    const summary = summaryBySession.get(key);
    if (!summary) {
      throw new Error("search_memory summarization did not produce a summary for every result.");
    }
    return {
      ...row,
      summary,
    };
  });
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
    const rawResults = query
      ? await searchTranscriptArchive(query, normalizedParams)
      : await loadRecentTranscriptSessions(normalizedParams);
    const results = await maybeSummarizeTranscriptMatches(
      rawResults,
      query,
      ctx,
      currentThinkingLevel,
    );
    const response = {
      mode,
      query,
      count: Array.isArray(results) ? results.length : 0,
      results,
    };
    const agentText = formatAgentSearchResult(response);
    const userText = formatSearchResult(response);
    const truncation = truncateHead(agentText);
    let outputText = truncation.content;
    const visibleRows = Array.isArray(response?.results) ? response.results : [];
    const details: {
      truncation?: TruncationResult;
      emptyMessage?: string;
      hiddenCount?: number;
      totalResults?: number;
      userText?: string;
    } = {
      hiddenCount: 0,
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
