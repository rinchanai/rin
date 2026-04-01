import { complete, type Model } from "@mariozechner/pi-ai";

import { executeMemoryTool } from "./lib.js";

type MemoryCandidate = {
  exposure?: "resident" | "progressive" | "recall";
  residentSlot?: string;
  title?: string;
  summary?: string;
  content?: string;
  scope?: "global" | "domain" | "project" | "session";
  kind?:
    | "identity"
    | "style"
    | "method"
    | "value"
    | "preference"
    | "rule"
    | "knowledge"
    | "history";
  replace?: boolean;
  tags?: string[];
  triggers?: string[];
};

type ExtensionCtxLike = {
  model?: Model<any> | null;
  modelRegistry?: {
    getApiKeyAndHeaders?: (model: Model<any>) => Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      error?: string;
    }>;
  };
  signal?: AbortSignal;
  cwd?: string;
};

const EXTRACTION_SYSTEM_PROMPT = `You extract long-term memory candidates for an assistant.

Return JSON only. No markdown. No prose.

Schema:
{
  "candidates": [
    {
      "exposure": "resident" | "progressive" | "recall",
      "residentSlot": "agent_identity" | "owner_identity" | "core_voice_style" | "core_methodology" | "core_values",
      "title": string,
      "summary": string,
      "content": string,
      "scope": "global" | "domain" | "project" | "session",
      "kind": "identity" | "style" | "method" | "value" | "preference" | "rule" | "knowledge" | "history",
      "replace": boolean,
      "tags": string[],
      "triggers": string[]
    }
  ]
}

Rules:
- Prefer an empty candidates array over weak guesses.
- Only capture stable, reusable memory.
- Do not capture transient planning chatter, one-off tasks, or implementation noise.
- Use resident only for durable global baselines like identity, voice style, methodology, or values.
- Use progressive for long-form cross-task working guidance.
- Use recall for project- or session-specific knowledge that may matter later.
- If the user corrected or replaced an older preference, set replace=true.
- If information is already fully implied by an existing resident memory snapshot, omit it unless this turn clearly updates it.
- Keep summaries concise. Keep content explicit and self-contained.
- For resident candidates, residentSlot is required.
- For progressive and recall candidates, title is required.
- Output valid JSON only.`;

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function slugify(value: string, fallback = "memory"): string {
  const raw = safeString(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return raw || fallback;
}

function extractJson(text: string): any {
  const raw = safeString(text).trim();
  if (!raw) return { candidates: [] };
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return { candidates: [] };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => safeString(part?.text))
    .join("\n")
    .trim();
}

function turnTranscript(messages: any[]): string {
  return messages
    .map((message) => {
      const role =
        safeString(
          message?.role || message?.message?.role || "unknown",
        ).trim() || "unknown";
      const content = stringifyContent(
        message?.content ?? message?.message?.content,
      );
      if (!content) return "";
      return `${role.toUpperCase()}: ${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function normalizeCandidate(raw: any): MemoryCandidate | null {
  const exposure = safeString(
    raw?.exposure,
  ).trim() as MemoryCandidate["exposure"];
  if (!["resident", "progressive", "recall"].includes(exposure || ""))
    return null;
  const candidate: MemoryCandidate = {
    exposure,
    residentSlot: safeString(raw?.residentSlot).trim(),
    title: safeString(raw?.title).trim(),
    summary: safeString(raw?.summary).trim(),
    content: safeString(raw?.content).trim(),
    scope: safeString(raw?.scope).trim() as MemoryCandidate["scope"],
    kind: safeString(raw?.kind).trim() as MemoryCandidate["kind"],
    replace: Boolean(raw?.replace),
    tags: Array.isArray(raw?.tags)
      ? raw.tags.map((item: any) => safeString(item).trim()).filter(Boolean)
      : [],
    triggers: Array.isArray(raw?.triggers)
      ? raw.triggers.map((item: any) => safeString(item).trim()).filter(Boolean)
      : [],
  };
  if (!candidate.content) return null;
  if (candidate.exposure === "resident" && !candidate.residentSlot) return null;
  if (candidate.exposure !== "resident" && !candidate.title) return null;
  return candidate;
}

async function saveCandidate(candidate: MemoryCandidate, source: string) {
  if (candidate.exposure === "resident") {
    return await executeMemoryTool({
      action: "save",
      title: candidate.residentSlot?.replace(/_/g, " ") || "resident memory",
      content: candidate.content,
      summary: candidate.summary,
      exposure: "resident",
      residentSlot: candidate.residentSlot,
      scope: "global",
      kind: candidate.kind || "preference",
      tags: candidate.tags || [],
      triggers: candidate.triggers || [],
      source,
    });
  }

  return await executeMemoryTool({
    action: "save",
    id: `${candidate.exposure}-${slugify(candidate.title || "")}`,
    title: candidate.title,
    content: candidate.content,
    summary: candidate.summary,
    exposure: candidate.exposure,
    scope:
      candidate.scope ||
      (candidate.exposure === "progressive" ? "domain" : "project"),
    kind:
      candidate.kind ||
      (candidate.exposure === "progressive" ? "preference" : "knowledge"),
    tags: candidate.tags || [],
    triggers: candidate.triggers || [],
    source,
  });
}

export async function extractAndPersistTurnMemory(
  ctx: ExtensionCtxLike,
  messages: any[],
  opts: { sessionFile?: string; trigger?: string } = {},
) {
  const model = ctx.model;
  if (!model || !ctx.modelRegistry?.getApiKeyAndHeaders)
    return { skipped: "no-model" };
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey)
    return {
      skipped: auth.ok ? "no-api-key" : safeString(auth.error || "auth-failed"),
    };

  const transcript = turnTranscript(messages);
  if (!transcript) return { skipped: "empty-transcript" };

  const compiled = await executeMemoryTool({
    action: "compile",
    query: transcript,
  });
  const resident = safeString(compiled?.resident || "").trim();
  const progressive = safeString(compiled?.progressive_index || "").trim();

  const prompt = [
    "Current memory snapshot:",
    resident || "(no resident memory)",
    "",
    "Progressive memory index:",
    progressive || "(no progressive memory)",
    "",
    "Conversation turn to evaluate:",
    transcript,
  ].join("\n");

  const response = await complete(
    model,
    {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      reasoningEffort: "medium",
    },
  );

  const text = response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  const parsed = extractJson(text);
  const candidates = (
    Array.isArray(parsed?.candidates) ? parsed.candidates : []
  )
    .map(normalizeCandidate)
    .filter((item): item is MemoryCandidate => Boolean(item));

  const saved = [] as any[];
  for (const candidate of candidates) {
    saved.push(
      await saveCandidate(candidate, opts.trigger || "extension:llm-extractor"),
    );
  }

  return {
    skipped: "",
    candidateCount: candidates.length,
    savedCount: saved.length,
    saved,
  };
}
