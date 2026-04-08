import type { Model } from "@mariozechner/pi-ai";

import { executeSubagentRun } from "../../src/core/subagent/service.js";
import { openBoundSession } from "../../src/core/session/factory.js";
import { loadMemoryService, resolveAgentDir } from "./lib.js";

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
  exposure?: "memory_prompts" | "memory_docs";
  memoryPromptSlot?: string;
  summary?: string;
  content?: string;
  scope?: "global" | "domain" | "project" | "session";
  kind?: "skill" | "instruction" | "rule" | "fact" | "index";
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
      "exposure": "memory_prompts" | "memory_docs",
      "memoryPromptSlot": "agent_identity" | "owner_identity" | "core_voice_style" | "core_methodology" | "core_values",
      "summary": string,
      "content": string,
      "scope": "global" | "domain" | "project" | "session",
      "kind": "skill" | "instruction" | "rule" | "fact" | "index",
      "tags": string[],
      "aliases": string[],
      "triggers": string[],
      "supersedes": string[],
      "reason": string
    }
  ]
}

Memory architecture:
- memory_prompts: short always-on routing hints and core baselines only.
- memory_docs: reserved for agent-managed skill packages loaded through the normal skills system; do not create, rewrite, or supersede memory_docs entries from this maintainer.

Memory prompt slots are restricted to:
- agent_identity
- owner_identity
- core_voice_style
- core_methodology
- core_values
- core_facts

Rules:
- Prefer fewer, clearer, higher-quality docs.
- Prefer [] over weak guesses.
- Do not record one-off planning chatter or implementation noise.
- Every memory file should stay focused on one topic.
- Memory files should use a clear name, a clear description, and a markdown body.
- When related files need structure, prefer creating an index doc instead of mixing topics into one file.
- If an existing doc is bloated but still right, use rewrite.
- If a new cleaner doc should replace one or more older docs, use supersede and list replaced ids in supersedes.
- If a doc is stale, duplicate, or low-value, use invalidate.
- Use create only when genuinely new durable memory is warranted.
- Memory prompt docs must stay short and stable.
- Procedural knowledge belongs in skills, not in memory_docs entries created by this maintainer.
- This maintainer should only propose memory_prompts operations; return [] instead of creating memory_docs entries.
- Do not invent facts not supported by the provided conversation or docs.
- Favor updating existing memory prompts over creating more docs.
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

async function runForkedSessionMemoryReview(options: {
  cwd: string;
  agentDir: string;
  sessionFile: string;
  transcriptMessages?: any[];
  additionalExtensionPaths?: string[];
}) {
  const transcript = Array.isArray(options.transcriptMessages)
    ? turnTranscript(options.transcriptMessages)
    : "";

  const { session } = await openBoundSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    sessionFile: options.sessionFile,
  });
  try {
    const forkTargets = session.getUserMessagesForForking?.() || [];
    const latest = forkTargets[forkTargets.length - 1];
    if (latest?.entryId) {
      const result = await session.fork(latest.entryId);
      if (result?.cancelled) return { skipped: "fork-cancelled" };
    }

    if (transcript.trim()) {
      await session.sendCustomMessage(
        {
          customType: "memory_session_transcript",
          display: false,
          content: [
            {
              type: "text",
              text: [
                "Use the archived transcript below as authoritative context for memory extraction before compaction removes it.",
                transcript,
              ].join("\n\n"),
            },
          ],
        },
        { triggerTurn: false },
      );
    }

    const prompt = [
      "Capture durable global baselines that should stay present every turn with save_memory_prompt.",
      "If the transcript shows a complex task, a tricky error fix, a non-trivial workflow, or a reusable user-corrected approach, save that procedure as a skill so it can be reused next time.",
      "Agent-generated skills live under the managed memory_docs skill path as ordinary <skill-name>/SKILL.md packages.",
      "When creating or substantially revising such a skill, use the skill-creator skill if it is available.",
      "If an existing skill was missing steps, outdated, incomplete, or wrong, update it immediately.",
      "Do not save transcript summaries, task progress, completed-work logs, or temporary TODO state as memory prompts.",
    ].join(" ");
    await session.prompt(prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });
    await session.agent.waitForIdle();
    const finalText = safeString(session.getLastAssistantText?.() || "").trim();
    return {
      skipped: "",
      transcriptUsed: Boolean(transcript.trim()),
      forked: Boolean(latest?.entryId),
      saved: true,
      output: finalText,
    };
  } finally {
    try {
      await session.abort();
    } catch {}
    try {
      session.dispose?.();
    } catch {}
  }
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
      memory_prompt_slot: doc.memory_prompt_slot,
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
    memoryPromptSlot: safeString(raw?.memoryPromptSlot).trim(),
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
  return params.exposure === "memory_prompts"
    ? await service.saveMemoryPromptDoc(params)
    : await service.saveMemory(params);
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
      exposure: operation.exposure || "memory_docs",
      memoryPromptSlot:
        operation.exposure === "memory_prompts"
          ? operation.memoryPromptSlot
          : "",
      scope: operation.scope || "project",
      kind: operation.kind || "fact",
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
    memoryPromptSlot:
      exposure === "memory_prompts"
        ? operation.memoryPromptSlot || existing.memory_prompt_slot
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
        memoryPromptSlot: oldDoc.memory_prompt_slot,
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
  ctx: ExtensionCtxLike & { cwd?: string; sessionManager?: any },
  opts: {
    messages?: any[];
    sessionFile?: string;
    trigger?: string;
    mode?: "session" | "consolidate";
    limit?: number;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const transcript = Array.isArray(opts.messages)
    ? turnTranscript(opts.messages)
    : "";
  const mode = opts.mode || (transcript ? "session" : "consolidate");
  if (mode !== "session" && !ctx.model) return { skipped: "no-model" };

  const service = await loadMemoryService();
  const docs = (await service.loadActiveMemoryDocs()) as any[];
  const limit = Math.max(1, Number(opts.limit || 120) || 120);
  const batch = docs
    .sort((a: any, b: any) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    )
    .slice(0, limit);

  if (mode === "session") {
    const sessionFile = safeString(opts.sessionFile || "").trim();
    if (!sessionFile) return { skipped: "no-session-file" };
    const cwd = safeString(
      ctx.cwd || ctx.sessionManager?.getCwd?.() || "",
    ).trim();
    if (!cwd) return { skipped: "no-cwd" };

    const extracted = await runForkedSessionMemoryReview({
      cwd,
      agentDir: resolveAgentDir(),
      sessionFile,
      transcriptMessages: Array.isArray(opts.messages) ? opts.messages : [],
      additionalExtensionPaths: opts.additionalExtensionPaths,
    });
    return {
      ...extracted,
      mode,
      sessionFile,
    };
  }

  if (!batch.length && !transcript) return { skipped: "no-input" };
  const compiled = await service.compileMemory({
    query: transcript || "memory",
    domainQuery: safeString(ctx.cwd || "").trim(),
  });
  const prompt = [
    `Maintenance mode: ${mode}`,
    "",
    "Current memory prompts:",
    safeString(compiled?.memory_prompt_context || "").trim() || "(none)",
    "",
    "Current relevant memory docs:",
    safeString(compiled?.memory_doc_context || "").trim() || "(none)",
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

  const consolidationRun = await executeSubagentRun({
    params: {
      prompt: `${MAINTENANCE_SYSTEM_PROMPT}\n\n${prompt}`,
    },
    ctx,
    currentThinkingLevel: "medium" as any,
  });
  if (consolidationRun.ok === false)
    return {
      skipped: safeString(
        consolidationRun.error || "memory_maintenance_failed",
      ),
    };

  const text = safeString(consolidationRun.results[0]?.output || "");
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
    mode,
    transcriptUsed: Boolean(transcript),
    scanned: batch.length,
    operationCount: operations.length,
    appliedCount: applied.length,
    applied,
  };
}
