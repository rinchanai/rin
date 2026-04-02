import { complete, type Model } from "@mariozechner/pi-ai";

import { loadMemoryService } from "./lib.js";

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
};

type MaintenanceOperation = {
  type?: "create" | "rewrite" | "supersede" | "invalidate";
  targetId?: string;
  title?: string;
  exposure?: "resident" | "progressive" | "recall";
  residentSlot?: string;
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
  tags?: string[];
  aliases?: string[];
  triggers?: string[];
  supersedes?: string[];
  reason?: string;
};

const MAINTENANCE_SYSTEM_PROMPT = `You maintain a markdown-backed memory library for an assistant.

You are not just extracting candidates. You are editing the memory library itself.
Your goal is to keep the library small, accurate, proactive, and easy to retrieve from.

Return JSON only.

Schema:
{
  "operations": [
    {
      "type": "create" | "rewrite" | "supersede" | "invalidate",
      "targetId": string,
      "title": string,
      "exposure": "resident" | "progressive" | "recall",
      "residentSlot": "agent_identity" | "owner_identity" | "core_voice_style" | "core_methodology" | "core_values",
      "summary": string,
      "content": string,
      "scope": "global" | "domain" | "project" | "session",
      "kind": "identity" | "style" | "method" | "value" | "preference" | "rule" | "knowledge" | "history",
      "tags": string[],
      "aliases": string[],
      "triggers": string[],
      "supersedes": string[],
      "reason": string
    }
  ]
}

Memory architecture:
- resident: short always-on core baselines only.
- progressive: important long-lived guidance that should be disclosed gradually.
- recall: useful searchable memory that should not be prompt-resident by default.

Resident slots are restricted to:
- agent_identity
- owner_identity
- core_voice_style
- core_methodology
- core_values

Rules:
- Prefer fewer, clearer, higher-quality docs.
- Prefer [] over weak guesses.
- Do not record one-off planning chatter or implementation noise.
- If an existing doc is bloated but still right, use rewrite.
- If a new cleaner doc should replace one or more older docs, use supersede and list replaced ids in supersedes.
- If a doc is stale, duplicate, or low-value, use invalidate.
- Use create only when genuinely new durable memory is warranted.
- Resident docs must stay short and stable.
- Progressive docs should capture durable guidance, not ephemeral task state.
- Recall docs should stay useful and searchable.
- Do not invent facts not supported by the provided conversation or docs.
- Favor updating or superseding existing docs over creating more docs.
- Output valid JSON only.`;

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function normalizeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => safeString(item).trim()).filter(Boolean)
    : [];
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

function trimDocContent(text: string, maxChars = 2200): string {
  const raw = safeString(text).trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function docsPrompt(docs: any[]): string {
  return JSON.stringify(
    docs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      exposure: doc.exposure,
      resident_slot: doc.resident_slot,
      summary: doc.summary,
      scope: doc.scope,
      kind: doc.kind,
      tags: doc.tags,
      aliases: doc.aliases,
      triggers: doc.triggers,
      status: doc.status,
      supersedes: doc.supersedes,
      updated_at: doc.updated_at,
      content: trimDocContent(doc.content),
    })),
    null,
    2,
  );
}

function extractJson(text: string): any {
  const raw = safeString(text).trim();
  if (!raw) return { operations: [] };
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
  return { operations: [] };
}

function normalizeOperation(raw: any): MaintenanceOperation | null {
  const type = safeString(raw?.type).trim() as MaintenanceOperation["type"];
  if (!["create", "rewrite", "supersede", "invalidate"].includes(type || ""))
    return null;
  const operation: MaintenanceOperation = {
    type,
    targetId: safeString(raw?.targetId).trim(),
    title: safeString(raw?.title).trim(),
    exposure: safeString(raw?.exposure).trim() as any,
    residentSlot: safeString(raw?.residentSlot).trim(),
    summary: safeString(raw?.summary).trim(),
    content: safeString(raw?.content).trim(),
    scope: safeString(raw?.scope).trim() as any,
    kind: safeString(raw?.kind).trim() as any,
    tags: normalizeList(raw?.tags),
    aliases: normalizeList(raw?.aliases),
    triggers: normalizeList(raw?.triggers),
    supersedes: normalizeList(raw?.supersedes),
    reason: safeString(raw?.reason).trim(),
  };
  if (operation.type === "create" && !operation.title) return null;
  if (operation.type !== "invalidate" && !operation.content) return null;
  if (operation.type !== "create" && !operation.targetId) return null;
  return operation;
}

async function saveDoc(service: any, params: Record<string, any>) {
  return await service.saveMemory(params);
}

async function applyOperation(
  service: any,
  existingDocs: Map<string, any>,
  operation: MaintenanceOperation,
  source: string,
) {
  if (operation.type === "create") {
    const saved = await saveDoc(service, {
      id: operation.targetId || undefined,
      title: operation.title,
      content: operation.content,
      summary: operation.summary,
      exposure: operation.exposure || "recall",
      residentSlot:
        operation.exposure === "resident" ? operation.residentSlot : "",
      scope:
        operation.scope ||
        (operation.exposure === "progressive" ? "domain" : "project"),
      kind:
        operation.kind ||
        (operation.exposure === "progressive" ? "preference" : "knowledge"),
      tags: operation.tags || [],
      aliases: operation.aliases || [],
      triggers: operation.triggers || [],
      supersedes: operation.supersedes || [],
      source,
    });
    return {
      type: operation.type,
      targetId: saved?.doc?.id || operation.targetId || "",
      path: saved?.doc?.path || "",
      reason: operation.reason || "",
    };
  }

  const existing = existingDocs.get(operation.targetId || "");
  if (!existing) return null;

  const exposure = operation.exposure || existing.exposure;
  const saved = await saveDoc(service, {
    id: existing.id,
    title: operation.title || existing.title,
    content:
      operation.type === "invalidate"
        ? existing.content
        : operation.content || existing.content,
    summary: operation.summary || existing.summary,
    exposure,
    residentSlot:
      exposure === "resident"
        ? operation.residentSlot || existing.resident_slot
        : "",
    scope: operation.scope || existing.scope,
    kind: operation.kind || existing.kind,
    tags: operation.tags || existing.tags,
    aliases: operation.aliases || existing.aliases,
    triggers: operation.triggers || existing.triggers,
    supersedes:
      operation.type === "supersede"
        ? operation.supersedes || existing.supersedes
        : existing.supersedes,
    source,
    status: operation.type === "invalidate" ? "invalidated" : existing.status,
    observationCount: Math.max(1, Number(existing.observation_count || 1)),
    sensitivity: existing.sensitivity,
    fidelity: existing.fidelity,
  });

  if (operation.type === "supersede") {
    for (const oldId of operation.supersedes || []) {
      const oldDoc = existingDocs.get(oldId);
      if (!oldDoc || oldDoc.id === existing.id) continue;
      await saveDoc(service, {
        id: oldDoc.id,
        title: oldDoc.title,
        content: oldDoc.content,
        summary: oldDoc.summary,
        exposure: oldDoc.exposure,
        residentSlot: oldDoc.resident_slot,
        scope: oldDoc.scope,
        kind: oldDoc.kind,
        tags: oldDoc.tags,
        aliases: oldDoc.aliases,
        triggers: oldDoc.triggers,
        supersedes: oldDoc.supersedes,
        source,
        status: "invalidated",
        observationCount: Math.max(1, Number(oldDoc.observation_count || 1)),
        sensitivity: oldDoc.sensitivity,
        fidelity: oldDoc.fidelity,
      });
    }
  }

  return {
    type: operation.type,
    targetId: existing.id,
    path: saved?.doc?.path || existing.path,
    reason: operation.reason || "",
    supersedes: operation.supersedes || [],
  };
}

export async function maintainMemory(
  ctx: ExtensionCtxLike,
  opts: {
    messages?: any[];
    trigger?: string;
    mode?: "session" | "consolidate";
    limit?: number;
  } = {},
) {
  const model = ctx.model;
  if (!model || !ctx.modelRegistry?.getApiKeyAndHeaders)
    return { skipped: "no-model" };
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey)
    return {
      skipped: auth.ok ? "no-api-key" : safeString(auth.error || "auth-failed"),
    };

  const service = await loadMemoryService();
  const docs = (await service.loadActiveMemoryDocs()) as any[];
  const limit = Math.max(1, Number(opts.limit || 120) || 120);
  const batch = docs
    .sort((a: any, b: any) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    )
    .slice(0, limit);
  const transcript = Array.isArray(opts.messages)
    ? turnTranscript(opts.messages)
    : "";

  if (!batch.length && !transcript) return { skipped: "no-input" };

  const compiled = await service.compileMemory({
    query: transcript || "memory",
  });
  const prompt = [
    `Maintenance mode: ${opts.mode || (transcript ? "session" : "consolidate")}`,
    "",
    "Current resident memory:",
    safeString(compiled?.resident || "").trim() || "(none)",
    "",
    "Current progressive index:",
    safeString(compiled?.progressive_index || "").trim() || "(none)",
    "",
    "Current active memory docs:",
    docsPrompt(batch),
    "",
    transcript
      ? ["Conversation that may justify memory changes:", transcript].join("\n")
      : "No new conversation transcript. Focus on consolidation and cleanup.",
    "",
    "Return only high-confidence library maintenance operations.",
  ].join("\n");

  const response = await complete(
    model,
    {
      systemPrompt: MAINTENANCE_SYSTEM_PROMPT,
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
  const operations = (
    Array.isArray(parsed?.operations) ? parsed.operations : []
  )
    .map(normalizeOperation)
    .filter((item): item is MaintenanceOperation => Boolean(item));

  const byId = new Map(batch.map((doc: any) => [doc.id, doc]));
  const applied: Array<Record<string, any>> = [];
  for (const operation of operations) {
    const result = await applyOperation(
      service,
      byId,
      operation,
      opts.trigger || "extension:memory_maintainer",
    );
    if (result) applied.push(result);
  }

  return {
    skipped: "",
    mode: opts.mode || (transcript ? "session" : "consolidate"),
    transcriptUsed: Boolean(transcript),
    scanned: batch.length,
    operationCount: operations.length,
    appliedCount: applied.length,
    applied,
  };
}
