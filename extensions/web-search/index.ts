import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "@sinclair/typebox";
import { keyHint, truncateToVisualLines, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import {
  getTextOutput,
  replaceTabs,
} from "../../src/core/pi/render-utils.js";

function trimSnippet(value: string, max = 220): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatResults(response: any): string {
  if (!response?.ok)
    return `Web search failed: ${String(response?.error || "unknown_error")}`;
  const rows = Array.isArray(response.results) ? response.results : [];
  if (!rows.length) return "No web results found.";
  return rows
    .slice(0, 3)
    .map((item: any) => {
      const title = String(item?.title || "").trim() || "(untitled)";
      const url = String(item?.url || "").trim();
      const snippet = trimSnippet(String(item?.snippet || ""));
      return [title, url, snippet].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function formatAgentResults(response: any): string {
  if (!response?.ok)
    return `web_search error\nerror=${String(response?.error || "unknown_error")}`;
  const rows = Array.isArray(response.results) ? response.results : [];
  if (!rows.length) return "web_search 0";
  return [
    `web_search ${rows.length}`,
    ...rows.map((item: any, index: number) => {
      const title = String(item?.title || "").trim() || "(untitled)";
      const url = String(item?.url || "").trim();
      const snippet = trimSnippet(String(item?.snippet || ""));
      const publishedDate = String(item?.publishedDate || "").trim();
      return [
        `${index + 1}. ${title}${publishedDate ? ` | ${publishedDate}` : ""}`,
        url,
        snippet,
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function formatWebSearchResult(
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

async function loadSearchWeb() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const candidates = [
    path.join(root, "core", "rin-web-search", "service.js"),
    path.join(root, "dist", "core", "rin-web-search", "service.js"),
  ];
  const distPath = candidates.find((filePath) => fs.existsSync(filePath));
  if (!distPath) {
    throw new Error(
      `rin_web_search_service_not_found:${candidates.join(" | ")}`,
    );
  }
  const mod = await import(pathToFileURL(distPath).href);
  return mod.searchWeb as (params: any) => Promise<any>;
}

function formatWebSearchCall(args: any, theme: any) {
  return `${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("accent", String(args?.q || "").trim())}`;
}

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web.",
    promptSnippet: "Search the web.",
    promptGuidelines: [
      "Use web_search proactively whenever web information may be relevant; better to search and confirm than to guess.",
    ],
    parameters: Type.Object({
      q: Type.String({
        description:
          "Focused web search query. Prefer a few distinctive keywords instead of full sentences; use quotes for exact phrases, site:example.com for domain scoping, -term to exclude terms, and OR for alternatives. For different topics, split them into separate web_search calls instead of one overloaded query.",
      }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
      freshness: Type.Optional(
        Type.Union(
          [
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year"),
          ],
          {
            description:
              "Optional recency filter. Allowed values: `day`, `week`, `month`, or `year`.",
          },
        ),
      ),
      language: Type.Optional(
        Type.String({
          description: "Optional language hint such as `zh-CN` or `en`.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const searchWeb = await loadSearchWeb();
      const normalizedParams = {
        ...(params as any),
        limit: Number.isFinite(Number((params as any)?.limit))
          ? Number((params as any).limit)
          : 8,
      };
      const response = await searchWeb(normalizedParams).catch((error: any) => ({
        ok: false,
        results: [],
        error: String(error?.message || error || "web_search_failed"),
      }));

      const agentText = formatAgentResults(response);
      const userText = formatResults(response);
      const truncation = truncateHead(agentText);
      let outputText = truncation.content;
      const rows = Array.isArray(response?.results) ? response.results : [];
      const hiddenCount = rows.length > 3 ? rows.length - 3 : 0;
      const details: {
        truncation?: TruncationResult;
        emptyMessage?: string;
        hiddenCount?: number;
        totalResults?: number;
        userText?: string;
      } = {
        hiddenCount,
        totalResults: rows.length,
        userText,
      };

      if (!rows.length && response?.ok) {
        details.emptyMessage = "No web results found.";
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
        content: [{ type: "text", text: outputText }],
        details,
        isError: response?.ok !== true,
      };
    },
    renderCall(args, theme) {
      return new Text(formatWebSearchCall(args, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
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
      text.setText(formatWebSearchResult(userResult, options, theme, context.showImages));
      return text;
    },
  });
}
