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
  searchTranscriptArchive,
} from "./transcripts.js";
import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { MEMORY_TASK_THINKING_LEVEL } from "../../src/core/rin-lib/memory-task-config.js";
import { resolveRuntimeProfile } from "../../src/core/rin-lib/runtime.js";

const MEMORY_RESULT_PREVIEW_LINES = 10;

type MemoryToolDetails = {
  truncation?: TruncationResult;
  emptyMessage?: string;
  hiddenCount?: number;
  totalResults?: number;
  userText?: string;
  phase?: "search" | "recent" | "summarize";
};

type MemoryRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

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
  return trimSnippet(String(item?.summary || "").trim());
}

function resultLocation(item: any): string {
  return String(item?.path || item?.sessionId || "").trim() || "Session";
}

function resultMessages(item: any): Array<any> {
  return Array.isArray(item?.messages) ? item.messages : [];
}

function formatMessageLine(message: any): string {
  const line = Math.max(1, Number(message?.line || 0) || 1);
  const role = String(message?.role || "message").trim() || "message";
  const toolName = String(message?.toolName || "").trim();
  const label = toolName ? `${role}/${toolName}` : role;
  const text = trimSnippet(String(message?.text || "").trim(), 240);
  return `L${line} ${label}: ${text}`;
}

function searchResultHeader(response: any): string {
  const query = String(response?.query || "").trim();
  if (!query) return "search_memory recent";
  return `search_memory ${query}`;
}

export function formatSearchResult(response: any): string {
  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return `${searchResultHeader(response)}\n\nNo memory results found.`;
  return [
    searchResultHeader(response),
    ...rows.map((item: any) => {
      return [
        resultLocation(item),
        resultSnippet(item),
        ...resultMessages(item).map((message: any) => formatMessageLine(message)),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

export function formatAgentSearchResult(response: any): string {
  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return `${searchResultHeader(response)}\n\n0 results`;
  return [
    `${searchResultHeader(response)} (${rows.length})`,
    ...rows.map((item: any, index: number) => {
      return [
        `${index + 1}. ${resultLocation(item)}`,
        resultSnippet(item),
        ...resultMessages(item).map((message: any) => formatMessageLine(message)),
      ]
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

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildSearchMemorySearchStatusText(mode: "search" | "recent", query: string): string {
  if (mode === "recent") return "Loading recent archived sessions...";
  return `Searching archived sessions for ${JSON.stringify(query)}...`;
}

function buildSearchMemorySummarizationStatusText(
  mode: "search" | "recent",
  total: number,
  results?: any[],
): string {
  const sessionLabel = total === 1 ? "session" : "sessions";
  if (!Array.isArray(results) || !results.length) {
    if (mode === "recent") return `Loaded ${total} recent ${sessionLabel}. Summarizing...`;
    return `Found ${total} matching ${sessionLabel}. Summarizing...`;
  }

  const done = results.filter((result) => result?.status === "done").length;
  const failed = results.filter((result) => result?.status === "error").length;
  const running = results.filter((result) => result?.status === "running").length;
  const pending = results.filter((result) => result?.status === "pending").length;
  return `Summarizing ${total} ${sessionLabel}: ${done} done, ${failed} failed, ${running} running, ${pending} pending`;
}

function emitSearchMemoryUpdate(
  onUpdate: ((value: { content: Array<{ type: "text"; text: string }>; details: MemoryToolDetails }) => void) | undefined,
  userText: string,
  details: Partial<MemoryToolDetails> = {},
) {
  onUpdate?.({
    content: [{ type: "text", text: userText }],
    details: {
      ...details,
      userText,
    },
  });
}

function formatMemoryResult(
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: MemoryToolDetails;
  },
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  const output = getTextOutput(result, showImages);
  const lines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
  const maxLines = options.expanded ? lines.length : MEMORY_RESULT_PREVIEW_LINES;
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

function buildRecallPrompt(_query: string, row: any): string {
  const sessionPath = String(row?.sessionFile || row?.path || "").trim();
  return [
    "Read the session file and summarize the session in no more than three sentences.",
    `Include the absolute session path: ${sessionPath || "(unknown)"}`,
    "Do not output anything other than that summary.",
  ].join("\n\n");
}

function resolveSearchMemoryAgentDir(ctx: any): string {
  const explicit = String(ctx?.agentDir || "").trim();
  if (explicit) return explicit;
  return String(resolveRuntimeProfile().agentDir || "").trim();
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new Error("search_memory_aborted");
}

export async function maybeSummarizeTranscriptMatches(
  results: any[],
  _query: string,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
  runSubagent = executeSubagentRun,
  signal?: AbortSignal,
  onProgress?: (results: any[]) => void,
) {
  throwIfAborted(signal);
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return rows;
  const agentDir = resolveSearchMemoryAgentDir(ctx);
  if (!agentDir) {
    throw new Error("search_memory requires an available agent directory for transcript summarization.");
  }

  const modelRef = ctx?.model
    ? `${String(ctx.model.provider || "")}/${String(ctx.model.id || "")}`
    : "";
  if (!modelRef) {
    throw new Error("search_memory summarization requires an active model.");
  }

  const tasks: any[] = [];
  const taskRows: any[] = [];
  for (const row of rows) {
    const sessionPath = String(row?.sessionFile || row?.path || "").trim();
    throwIfAborted(signal);
    if (!sessionPath) continue;
    tasks.push({
      prompt: buildRecallPrompt(_query, row),
      model: modelRef,
      thinkingLevel: MEMORY_TASK_THINKING_LEVEL,
      disabledExtensions: ["memory"],
    });
    taskRows.push(row);
  }

  if (!tasks.length) return rows;

  throwIfAborted(signal);
  const run = await runSubagent({
    params: { tasks },
    ctx: {
      ...ctx,
      agentDir,
    },
    currentThinkingLevel,
    signal,
    onProgress(results: any[]) {
      onProgress?.(results);
    },
  });
  throwIfAborted(signal);
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

export async function executeSearchMemory(
  params: any,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
  signal?: AbortSignal,
  onUpdate?: (value: { content: Array<{ type: "text"; text: string }>; details: MemoryToolDetails }) => void,
) {
  try {
    const query = String(params?.query || "").trim();
    const mode = (query ? "search" : "recent") as "search" | "recent";
    const normalizedParams = {
      ...(params || {}),
      limit: Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 8,
    };
    const rootOverride = resolveSearchMemoryAgentDir(ctx);

    emitSearchMemoryUpdate(onUpdate, buildSearchMemorySearchStatusText(mode, query), {
      phase: mode,
    });

    const rawResults = query
      ? await searchTranscriptArchive(query, normalizedParams, rootOverride)
      : await loadRecentTranscriptSessions(normalizedParams, rootOverride);

    if (rawResults.length > 0) {
      emitSearchMemoryUpdate(onUpdate, buildSearchMemorySummarizationStatusText(mode, rawResults.length), {
        phase: "summarize",
        totalResults: rawResults.length,
      });
    }

    const results = await maybeSummarizeTranscriptMatches(
      rawResults,
      query,
      ctx,
      currentThinkingLevel,
      executeSubagentRun,
      signal,
      (progressResults) => {
        emitSearchMemoryUpdate(
          onUpdate,
          buildSearchMemorySummarizationStatusText(mode, rawResults.length, progressResults),
          {
            phase: "summarize",
            totalResults: rawResults.length,
          },
        );
      },
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
    const details: MemoryToolDetails = {
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

export function formatRenderedMemoryResult(
  result: any,
  options: any,
  theme: any,
  showImages: boolean,
  startedAt?: number,
  endedAt?: number,
) {
  const details = (result.details as MemoryToolDetails | undefined) || {};
  const userResult = {
    content: [{ type: "text", text: String(details.userText || getTextOutput(result, showImages) || "") }],
    details: {
      truncation: details.truncation,
      emptyMessage: details.emptyMessage,
      hiddenCount: details.hiddenCount,
      totalResults: details.totalResults,
    },
  };
  let text = formatMemoryResult(userResult, options, theme, showImages);
  if (startedAt !== undefined) {
    const label = endedAt === undefined ? "Elapsed" : "Took";
    const duration = theme.fg("muted", `${label} ${formatDuration((endedAt ?? Date.now()) - startedAt)}`);
    text = text ? `${text}\n${duration}` : `\n${duration}`;
  }
  return text;
}

function renderMemoryResult(result: any, options: any, theme: any, context: any) {
  const state = context.state as MemoryRenderState;
  if (state.startedAt !== undefined && options.isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
  }
  if (!options.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(
    formatRenderedMemoryResult(
      result,
      options,
      theme,
      context.showImages,
      state.startedAt,
      state.endedAt,
    ),
  );
  return text;
}

export function formatSearchMemoryCall(args: any, theme: any) {
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
    execute: async (_toolCallId, params, signal, onUpdate, ctx) =>
      (await executeSearchMemory(
        params,
        ctx,
        pi.getThinkingLevel() as ThinkingLevel,
        signal,
        onUpdate as any,
      )) as any,
    renderCall: (args, theme, context) => {
      const state = context.state as MemoryRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatSearchMemoryCall(args, theme));
      return text;
    },
    renderResult: renderMemoryResult,
  });

  pi.on("message_end", async (event, ctx) => {
    await archiveMessageTranscript(event?.message, ctx);
  });
}
