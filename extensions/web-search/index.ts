import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { prepareToolTextOutput } from "../shared/tool-text.js";

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
  if (!rows.length)
    return `No web results found for: ${String(response.query || "")}`;
  return [
    `Fresh web results for: ${String(response.query || "")}`,
    ...rows.map((item: any, index: number) => {
      const title = String(item?.title || "").trim() || "(untitled)";
      const domain = String(item?.domain || "").trim();
      const url = String(item?.url || "").trim();
      const snippet = trimSnippet(String(item?.snippet || ""));
      const meta = [domain, String(item?.publishedDate || "").trim()]
        .filter(Boolean)
        .join(" • ");
      return [`${index + 1}. ${title}${meta ? ` — ${meta}` : ""}`, url, snippet]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

function formatAgentResults(response: any): string {
  if (!response?.ok)
    return `web_search error\nquery=${String(response?.query || "")}\nerror=${String(response?.error || "unknown_error")}`;
  const rows = Array.isArray(response.results) ? response.results : [];
  if (!rows.length)
    return `web_search 0\nquery=${String(response?.query || "")}`;
  return [
    `web_search ${rows.length}`,
    `query=${String(response?.query || "")}`,
    ...rows.map((item: any, index: number) => {
      const meta = [
        String(item?.domain || "").trim(),
        String(item?.publishedDate || "").trim(),
      ]
        .filter(Boolean)
        .join(" | ");
      return [
        `${index + 1}. ${String(item?.title || "").trim() || "(untitled)"}${meta ? ` | ${meta}` : ""}`,
        String(item?.url || "").trim(),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
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

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the live web for fresh facts, current documentation, recent releases, and other information that may have changed after pretraining.",
    promptSnippet:
      "Search the live web for up-to-date facts and current sources when stale memory would be risky.",
    promptGuidelines: [
      "Use `web_search` proactively for current, recent, official, version-sensitive, or otherwise drift-prone facts. Do not rely on memory when fresh external information is likely to matter.",
      "When the user asks for the latest or up-to-date answer, search first and treat the returned results as the working factual baseline unless they clearly conflict.",
    ],
    parameters: Type.Object({
      q: Type.String({ description: "Focused search query." }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
      domains: Type.Optional(
        Type.Array(
          Type.String({
            description: "Optional domain filter like developers.openai.com",
          }),
        ),
      ),
      freshness: Type.Optional(
        Type.Union([
          Type.Literal("day"),
          Type.Literal("week"),
          Type.Literal("month"),
          Type.Literal("year"),
        ]),
      ),
      language: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const searchWeb = await loadSearchWeb();
      const response = await searchWeb(params as any).catch((error: any) => ({
        ok: false,
        query: String((params as any)?.q || ""),
        results: [],
        error: String(error?.message || error || "web_search_failed"),
      }));
      const prepared = await prepareToolTextOutput({
        agentText: formatAgentResults(response),
        userText: formatResults(response),
        tempPrefix: "rin-web-search-",
        filename: "web-search.txt",
      });
      return {
        content: [{ type: "text", text: prepared.agentText }],
        details: { ...response, ...prepared },
        isError: response?.ok !== true,
      };
    },
    renderResult(result) {
      const details = result.details as any;
      const fallback =
        result.content?.[0]?.type === "text"
          ? result.content[0].text
          : "(no output)";
      return new Text(String(details?.userText || fallback), 0, 0);
    },
  });
}
