import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { searchWeb } from "../../dist/core/rin-web-search/service.js";

function trimSnippet(value: string, max = 220): string {
	const text = String(value || "").replace(/\s+/g, " ").trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatResults(response: any): string {
	if (!response?.ok) return `Web search failed: ${String(response?.error || "unknown_error")}`;
	const rows = Array.isArray(response.results) ? response.results : [];
	if (!rows.length) return `No web results found for: ${String(response.query || "")}`;
	return [
		`Fresh web results for: ${String(response.query || "")}`,
		...rows.map((item: any, index: number) => {
			const title = String(item?.title || "").trim() || "(untitled)";
			const domain = String(item?.domain || "").trim();
			const url = String(item?.url || "").trim();
			const snippet = trimSnippet(String(item?.snippet || ""));
			const meta = [domain, String(item?.publishedDate || "").trim()].filter(Boolean).join(" • ");
			return [
				`${index + 1}. ${title}${meta ? ` — ${meta}` : ""}`,
				url,
				snippet,
			].filter(Boolean).join("\n");
		}),
	].join("\n\n");
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the live web for fresh facts, current documentation, recent releases, and other information that may have changed after pretraining.",
		promptSnippet: "Search the live web for up-to-date facts and current sources when stale memory would be risky.",
		promptGuidelines: [
			"Use `web_search` proactively for current, recent, official, version-sensitive, or otherwise drift-prone facts. Do not rely on memory when fresh external information is likely to matter.",
			"When the user asks for the latest or up-to-date answer, search first and treat the returned results as the working factual baseline unless they clearly conflict.",
		],
		parameters: Type.Object({
			q: Type.String({ description: "Focused search query." }),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
			domains: Type.Optional(Type.Array(Type.String({ description: "Optional domain filter like developers.openai.com" }))),
			freshness: Type.Optional(Type.Union([
				Type.Literal("day"),
				Type.Literal("week"),
				Type.Literal("month"),
				Type.Literal("year"),
			])),
			language: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params) => {
			const response = await searchWeb(params as any).catch((error: any) => ({
				ok: false,
				query: String((params as any)?.q || ""),
				results: [],
				error: String(error?.message || error || "web_search_failed"),
			}));
			return {
				content: [{ type: "text", text: formatResults(response) }],
				details: response,
				isError: response?.ok !== true,
			};
		},
	});
}
