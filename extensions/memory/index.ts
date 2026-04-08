import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  appendTranscriptArchiveEntry,
  loadTranscriptSessionEntries,
  searchTranscriptArchive,
} from "./transcripts.js";
import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { loadAuxiliaryModelConfig } from "../../src/core/rin-lib/auxiliary-model.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

const MEMORY_SYSTEM_GUIDANCE = [
  "# Memory guidance",
  "This memory module is reserved for session history recall.",
  "Use search_memory when the user references a past conversation, says we did this before, mentions last time, or when you suspect relevant cross-session context exists.",
  "Better to search and confirm than to guess or ask the user to repeat themselves.",
  "For broad recall, search with a few distinctive keywords joined by OR instead of one long natural-language sentence.",
  "Do not use search_memory for self_improve prompts or skills; it is only for archived session history.",
].join("\n");

const searchMemoryParams = Type.Object({
  query: Type.String({ description: "Search query." }),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Maximum number of matches to return.",
    }),
  ),
  fidelity: Type.Optional(
    Type.Union([Type.Literal("exact"), Type.Literal("fuzzy")], {
      description:
        "Optional match mode. Allowed values: `exact` or `fuzzy` only. Omit this field if you are unsure.",
    }),
  ),
});

function extractTranscriptText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return part.type === "text" ? String(part.text || "") : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

async function archiveMessageTranscript(message: any, ctx: any) {
  const role = String(message?.role || "").trim();
  if (role !== "user" && role !== "assistant") return;
  const text = extractTranscriptText(message?.content);
  if (!text) return;
  await appendTranscriptArchiveEntry(
    {
      timestamp:
        String(message?.timestamp || "").trim() || new Date().toISOString(),
      sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
      sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
      role,
      content: message?.content,
    },
    String(ctx?.agentDir || "").trim(),
  );
}

function formatSearchResult(response: any): string {
  const summaries = Array.isArray(response?.summaries)
    ? response.summaries
    : [];
  if (summaries.length) {
    return [
      `Session recall for: ${String(response?.query || "")}`,
      ...summaries.map((item: any, index: number) => {
        const meta = [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          String(item?.sessionId || "").trim(),
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
  if (!rows.length)
    return `No transcript matches for: ${String(response?.query || "")}`;
  return [
    `Transcript matches for: ${String(response?.query || "")}`,
    ...rows.map((item: any, index: number) => {
      const meta = [
        `score=${Number(item?.score || 0).toFixed(2)}`,
        String(item?.role || "").trim(),
        String(item?.timestamp || "").trim(),
      ]
        .filter(Boolean)
        .join(" • ");
      return [
        `${index + 1}. Transcript — ${meta}`,
        String(item?.path || "").trim(),
        String(item?.preview || item?.description || "").trim(),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function formatAgentSearchResult(response: any): string {
  const summaries = Array.isArray(response?.summaries)
    ? response.summaries
    : [];
  if (summaries.length) {
    return [
      `memory search ${String(response?.query || "")} (${summaries.length} sessions)`,
      ...summaries.map((item: any, index: number) =>
        [
          `${index + 1}. session`,
          `score=${Number(item?.score || 0).toFixed(2)}`,
          `path=${String(item?.path || "")}`,
        ]
          .filter(Boolean)
          .join(" | "),
      ),
    ].join("\n");
  }

  const rows = Array.isArray(response?.results) ? response.results : [];
  if (!rows.length) return `memory search ${String(response?.query || "")} (0)`;
  return [
    `memory search ${String(response?.query || "")} (${rows.length})`,
    ...rows.map((item: any, index: number) =>
      [
        `${index + 1}. transcript`,
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
  return [
    "Review the past session transcript below and summarize only what is useful for recall.",
    `Focus on this search query: ${query}`,
    "Include concrete decisions, fixes, commands, file paths, and unresolved follow-ups if they matter.",
    "Be concise and factual. Do not add speculation.",
    "Return plain text only.",
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
      cwd: String(ctx?.cwd || ctx?.sessionManager?.getCwd?.() || process.cwd()),
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
    const results = await searchTranscriptArchive(
      String(params?.query || ""),
      params,
    );
    const summaries = await maybeSummarizeTranscriptMatches(
      results,
      params,
      ctx,
      currentThinkingLevel,
    );
    const response = {
      query: String(params?.query || ""),
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
      "Search archived session history. Use it proactively when the user references a past conversation or when relevant cross-session context may exist. Prefer a few distinctive keywords joined with OR for broad recall.",
    promptSnippet: "Search archived session history.",
    promptGuidelines: [
      "Use search_memory when the user references a past conversation or when relevant cross-session context may exist.",
      "Better to search and confirm than to guess or ask the user to repeat themselves.",
      "For broad recall, search with a few distinctive keywords joined by OR instead of one long sentence.",
      "If a broad OR query returns nothing, retry with one or two narrower keyword searches.",
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

  pi.on("before_agent_start", async (event) => {
    if (String(event.systemPrompt || "").includes(MEMORY_SYSTEM_GUIDANCE)) {
      return;
    }
    return {
      systemPrompt:
        `${String(event.systemPrompt || "").trimEnd()}\n\n${MEMORY_SYSTEM_GUIDANCE}`.trimEnd(),
    };
  });
}
