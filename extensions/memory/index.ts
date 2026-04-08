import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  appendTranscriptArchiveEntry,
  searchTranscriptArchive,
} from "./transcripts.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

const MEMORY_SYSTEM_GUIDANCE = [
  "# Memory guidance",
  "This memory module is reserved for session history recall.",
  "Use search_memory when you need to recall archived transcript history across sessions.",
  "Do not use search_memory for always-on preferences or resident facts; those belong to self-improve prompts and skills.",
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
        String(item?.sessionFile || "").trim(),
        String(item?.preview || item?.description || "").trim(),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function formatAgentSearchResult(response: any): string {
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
        `session=${String(item?.sessionFile || "")}`,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  ].join("\n");
}

async function executeSearchMemory(params: any) {
  try {
    const response = await searchTranscriptArchive(
      String(params?.query || ""),
      params,
    );
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
      "Search archived session history. Returns matching transcript paths and metadata first.",
    promptSnippet: "Search archived session history.",
    promptGuidelines: [
      "Use search_memory when you need cross-session transcript recall.",
    ],
    parameters: searchMemoryParams,
    execute: async (_toolCallId, params) =>
      (await executeSearchMemory(params)) as any,
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
