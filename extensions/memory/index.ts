import {
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  enqueueMemoryMaintenanceJob,
  spawnQueuedMemoryWorker,
} from "./async-jobs.js";
import { maintainMemory } from "./maintainer.js";
import {
  buildOnboardingPrompt,
  compilePromptMemory,
  executeMemoryTool,
  formatMemoryAgentResult,
  formatMemoryResult,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
  resolveAgentDir,
  loadMemoryService,
} from "./lib.js";
import { refineMemoryPromptSlot } from "./processing.js";
import { appendTranscriptArchiveEntry } from "./transcripts.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

let installerAutoInitConsumed = false;

const MEMORY_SYSTEM_GUIDANCE = [
  "# Memory guidance",
  "You have persistent memory across sessions.",
  "Use save_memory_prompt for short always-on baselines that should stay present every turn.",
  "Use save_memory for detailed searchable memory docs that should be discovered through retrieval instead of forced into the system prompt.",
  "Use search_memory before substantial work and before saving new memory when duplicates are likely.",
  "Prioritize durable user preferences, recurring corrections, and stable workflow expectations.",
  "Do not store task progress, transient TODOs, one-off implementation chatter, or noisy session summaries in always-on memory prompts.",
  "If a memory is procedural and reusable, prefer skills. If it is detailed and searchable, prefer memory docs. If it must stay present every turn, prefer memory prompts.",
].join("\n");

const MEMORY_REVIEW_INTERVAL = 8;
const reviewStateBySession = new Map<
  string,
  { userTurns: number; lastQueuedTurn: number }
>();

function sessionMeta(ctx: any) {
  return {
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
    sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
  };
}

function getSessionReviewState(sessionId: string) {
  const key = String(sessionId || "").trim();
  if (!key) return null;
  const current = reviewStateBySession.get(key) || {
    userTurns: 0,
    lastQueuedTurn: 0,
  };
  reviewStateBySession.set(key, current);
  return current;
}

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
  const meta = sessionMeta(ctx);
  await appendTranscriptArchiveEntry(
    {
      timestamp:
        String(message?.timestamp || "").trim() || new Date().toISOString(),
      sessionId: meta.sessionId,
      sessionFile: meta.sessionFile,
      role,
      content: message?.content,
    },
    String(ctx?.agentDir || "").trim(),
  );
}

function triggerInitConversation(
  pi: ExtensionAPI,
  mode: "auto" | "manual",
  busy: boolean,
) {
  pi.sendMessage(
    {
      customType: "memory-init-trigger",
      content:
        mode === "auto"
          ? "Begin memory onboarding."
          : "Begin requested memory onboarding.",
      display: false,
    },
    busy ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
  );
}

function branchToMessages(entries: any[]): any[] {
  return entries
    .filter((entry) => entry?.type === "message" && entry?.message)
    .map((entry) => entry.message);
}

function loadMessagesFromSessionFile(sessionFile: string): any[] {
  const file = String(sessionFile || "").trim();
  if (!file) return [];
  try {
    return branchToMessages(SessionManager.open(file).getBranch());
  } catch {
    return [];
  }
}

async function processSessionMemory(
  ctx: any,
  messages: any[],
  opts: { sessionFile?: string; trigger: string; snapshotKey?: string },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  const cwd = String(ctx?.cwd || ctx?.sessionManager?.getCwd?.() || "").trim();
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !sessionFile ||
    !agentDir ||
    !cwd
  ) {
    return;
  }
  await enqueueMemoryMaintenanceJob({
    agentDir,
    cwd,
    sessionFile,
    trigger: opts.trigger,
    snapshotKey: opts.snapshotKey,
    messages,
  });
  spawnQueuedMemoryWorker(agentDir);
}

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

const saveMemoryParams = Type.Object({
  id: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  content: Type.String({ description: "Memory content." }),
  description: Type.Optional(Type.String()),
  exposure: Type.Optional(
    Type.Literal("memory_docs", {
      description:
        "Optional memory layer. Normal searchable memory uses `memory_docs`.",
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
  aliases: Type.Optional(Type.Array(Type.String())),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("global"),
        Type.Literal("domain"),
        Type.Literal("project"),
        Type.Literal("session"),
      ],
      {
        description:
          "Optional memory scope. Allowed values: `global`, `domain`, `project`, or `session`.",
      },
    ),
  ),
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("skill"),
        Type.Literal("instruction"),
        Type.Literal("rule"),
        Type.Literal("fact"),
        Type.Literal("index"),
      ],
      {
        description:
          "Optional memory kind. Allowed values: `skill`, `instruction`, `rule`, `fact`, or `index`.",
      },
    ),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("active"),
        Type.Literal("superseded"),
        Type.Literal("invalidated"),
      ],
      {
        description:
          "Optional memory status. Allowed values: `active`, `superseded`, or `invalidated`.",
      },
    ),
  ),
  observationCount: Type.Optional(Type.Number({ minimum: 1 })),
  supersedes: Type.Optional(Type.Array(Type.String())),
  sensitivity: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
});

const saveMemoryPromptParams = Type.Object({
  action: Type.Union(
    [Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")],
    {
      description:
        "Memory prompt action. Allowed values: `add`, `replace`, or `remove`.",
    },
  ),
  memoryPromptSlot: Type.Union(
    [
      Type.Literal("agent_identity"),
      Type.Literal("owner_identity"),
      Type.Literal("core_voice_style"),
      Type.Literal("core_methodology"),
      Type.Literal("core_values"),
      Type.Literal("core_facts"),
    ],
    {
      description:
        "Memory prompt slot name. Allowed values: `agent_identity`, `owner_identity`, `core_voice_style`, `core_methodology`, `core_values`, `core_facts`.",
    },
  ),
  content: Type.Optional(
    Type.String({
      description:
        "New memory prompt content. Required for `add` and `replace`.",
    }),
  ),
  oldText: Type.Optional(
    Type.String({
      description:
        "Short unique substring identifying the text to replace or remove inside the current slot.",
    }),
  ),
  source: Type.Optional(Type.String()),
});

async function executeNamedMemoryAction(action: string, params: any) {
  const input = { ...params, action };
  try {
    const response = await executeMemoryTool(input);
    const prepared = await prepareToolTextOutput({
      agentText: formatMemoryAgentResult(action, response),
      userText: formatMemoryResult(action, response),
      tempPrefix: "rin-memory-",
      filename: `memory-${action}.txt`,
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: { ...response, ...prepared },
    };
  } catch (error: any) {
    const message = String(error?.message || error || "memory_action_failed");
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        agentText: message,
        userText: `Memory 操作失败：${message}`,
      },
      isError: true,
    };
  }
}

async function executeSaveMemoryAction(
  params: any,
  ctx: any,
  currentThinkingLevel: any,
) {
  try {
    const response = await executeMemoryTool({
      action: "save",
      name: params.name,
      description: params.description,
      content: params.content,
      exposure: params.exposure,
      scope: params.scope,
      kind: params.kind,
      path: params.path,
      tags: params.tags,
      aliases: params.aliases,
      source: params.source,
      id: params.id,
      fidelity: params.fidelity,
      status: params.status,
      observationCount: params.observationCount,
      supersedes: params.supersedes,
      sensitivity: params.sensitivity,
    });
    const prepared = await prepareToolTextOutput({
      agentText: formatMemoryAgentResult("save", response),
      userText: formatMemoryResult("save", response),
      tempPrefix: "rin-memory-",
      filename: "memory-save.txt",
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: { ...response, ...prepared },
    };
  } catch (error: any) {
    const message = String(error?.message || error || "memory_action_failed");
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        agentText: message,
        userText: `Memory 操作失败：${message}`,
      },
      isError: true,
    };
  }
}

async function executeSaveMemoryPromptAction(
  params: any,
  ctx: any,
  currentThinkingLevel: any,
) {
  try {
    const action = String(params?.action || "add").trim();
    const existing = await executeMemoryTool({ action: "compile" });
    const currentDoc = Array.isArray(existing?.memory_prompt_prompt_docs)
      ? existing.memory_prompt_prompt_docs.find(
          (doc: any) =>
            String(doc?.memory_prompt_slot || "").trim() ===
            String(params.memoryPromptSlot || "").trim(),
        )
      : null;
    const refined = await refineMemoryPromptSlot({
      memoryPromptSlot: params.memoryPromptSlot,
      incomingContent: params.content,
      oldText: params.oldText,
      action: action as any,
      existingContent: String(currentDoc?.content || ""),
    });
    const response = refined.removed
      ? await executeMemoryTool({
          action: "remove_memory_prompt",
          memoryPromptSlot: params.memoryPromptSlot,
        })
      : await executeMemoryTool({
          action: "save_memory_prompt",
          memoryPromptSlot: params.memoryPromptSlot,
          name: refined.name,
          content: refined.content,
          source: params.source,
        });
    const targetPath = String(response?.doc?.path || response?.path || "");
    const userVerb =
      action === "remove"
        ? "Removed memory prompt"
        : action === "replace"
          ? "Updated memory prompt"
          : "Saved memory prompt";
    const agentVerb =
      action === "remove"
        ? "memory remove_memory_prompt"
        : "memory save_memory_prompt";
    const prepared = await prepareToolTextOutput({
      agentText: `${agentVerb}\npath=${targetPath}`,
      userText: `${userVerb}: ${String(response?.doc?.name || refined.name || params.memoryPromptSlot)}\n${targetPath}`,
      tempPrefix: "rin-memory-",
      filename: "memory-save-memory-prompt.txt",
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: { ...response, ...prepared, refined, action },
    };
  } catch (error: any) {
    const message = String(
      error?.message || error || "memory_prompt_action_failed",
    );
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        agentText: message,
        userText: `Memory prompt 操作失败：${message}`,
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
      "Search long-term memory. Returns matching paths and metadata first.",
    promptSnippet: "Search long-term memory.",
    promptGuidelines: [
      "Use search_memory proactively before substantial work.",
    ],
    parameters: searchMemoryParams,
    execute: async (_toolCallId, params) =>
      await executeNamedMemoryAction("search", params),
    renderResult: renderMemoryResult,
  });

  pi.registerTool({
    name: "save_memory",
    label: "Save Memory",
    description: "Persist memory documents.",
    promptSnippet: "Persist memory documents.",
    promptGuidelines: [
      "Use save_memory for detailed searchable memory documents that should be discovered through retrieval, keeping separate topics in separate documents.",
    ],
    parameters: saveMemoryParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeSaveMemoryAction(params, ctx, pi.getThinkingLevel()),
    renderResult: renderMemoryResult,
  });

  pi.registerTool({
    name: "save_memory_prompt",
    label: "Save Memory Prompt",
    description: "Persist short always-on memory prompts.",
    promptSnippet: "Persist short always-on memory prompts.",
    promptGuidelines: [
      "Use save_memory_prompt for short always-on baselines that should stay present every turn.",
      "Save proactively when the user corrects you, reveals a durable preference, shares a stable identity cue, or establishes an expectation about how you should behave.",
      "Do not store task progress, session outcomes, completed-work logs, temporary TODO state, or long detailed guidance in memory prompts.",
      "Use action=`add` for new durable cues, `replace` when updating a specific existing phrase via oldText, and `remove` when an always-on cue is no longer valid.",
      "Use `core_facts` only for a very small set of stable facts that must stay present every turn.",
      "When the memory is procedural, prefer skills. When it is detailed and searchable, prefer save_memory instead.",
    ],
    parameters: saveMemoryPromptParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeSaveMemoryPromptAction(params, ctx, pi.getThinkingLevel()),
    renderResult: renderMemoryResult,
  });

  pi.on("message_end", async (event, ctx) => {
    await archiveMessageTranscript(event?.message, ctx);

    const role = String(event?.message?.role || "").trim();
    const meta = sessionMeta(ctx);
    const state = getSessionReviewState(meta.sessionId);
    if (!state || !meta.sessionFile) return;

    if (role === "user") {
      state.userTurns += 1;
      return;
    }

    if (
      role === "assistant" &&
      state.userTurns > 0 &&
      state.userTurns - state.lastQueuedTurn >= MEMORY_REVIEW_INTERVAL
    ) {
      await processSessionMemory(ctx, [], {
        sessionFile: meta.sessionFile,
        trigger: "extension:periodic_memory_review",
        snapshotKey: `review:${state.userTurns}`,
      });
      state.lastQueuedTurn = state.userTurns;
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const preparation = event?.preparation;
    const messages = [
      ...(Array.isArray(preparation?.messagesToSummarize)
        ? preparation.messagesToSummarize
        : []),
      ...(Array.isArray(preparation?.turnPrefixMessages)
        ? preparation.turnPrefixMessages
        : []),
    ];
    const sessionFile = sessionMeta(ctx).sessionFile;
    if (!sessionFile || messages.length === 0) return;
    await maintainMemory(ctx as any, {
      sessionFile,
      trigger: "extension:session_compaction_memory_review",
      mode: "session",
      messages,
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const meta = sessionMeta(ctx);
    await processSessionMemory(
      ctx,
      branchToMessages(ctx?.sessionManager?.getBranch?.() || []),
      {
        sessionFile: meta.sessionFile,
        trigger: "extension:session_shutdown_maintainer",
      },
    );
    if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
  });

  pi.on("session_start", async (event, ctx) => {
    if (event?.reason !== "new") return;
    const previousSessionFile = String(event?.previousSessionFile || "").trim();
    if (!previousSessionFile) return;
    await processSessionMemory(
      ctx,
      loadMessagesFromSessionFile(previousSessionFile),
      {
        sessionFile: previousSessionFile,
        trigger: "extension:session_start_new_maintainer",
      },
    );
  });

  pi.registerCommand("init", {
    description: "Start or restart memory onboarding conversation.",
    handler: async (_args, ctx) => {
      await markOnboardingPrompted(resolveAgentDir, "manual:/init");
      ctx.ui.notify(
        ctx.isIdle()
          ? "Memory onboarding started."
          : "Memory onboarding queued.",
        "info",
      );
      triggerInitConversation(pi, "manual", !ctx.isIdle());
    },
  });

  pi.registerCommand("memory-consolidate", {
    description: "Run a low-frequency LLM memory cleanup pass.",
    handler: async (_args, ctx) => {
      const result = await maintainMemory(ctx as any, {
        mode: "consolidate",
        trigger: "extension:manual_memory_consolidation",
      });
      if (result?.skipped) {
        ctx.ui.notify(
          `Memory consolidation skipped: ${String(result.skipped)}`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Memory consolidation finished: ${String(result?.appliedCount || 0)} change(s).`,
        "info",
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (
      !installerAutoInitConsumed &&
      String(process.env.RIN_INSTALL_AUTO_INIT || "").trim() === "1"
    ) {
      await markOnboardingPrompted(resolveAgentDir, "auto:installer");
      installerAutoInitConsumed = true;
      process.env.RIN_INSTALL_AUTO_INIT = "";
    }
    await refreshOnboardingCompletion(resolveAgentDir, loadMemoryService);
    const { systemPrompt } = await compilePromptMemory();
    const blocks: string[] = [];
    if (!String(event.systemPrompt || "").includes(MEMORY_SYSTEM_GUIDANCE)) {
      blocks.push(MEMORY_SYSTEM_GUIDANCE);
    }
    if (
      systemPrompt &&
      !String(event.systemPrompt || "").includes(systemPrompt)
    )
      blocks.push(systemPrompt);
    const onboarding = getOnboardingState(resolveAgentDir);
    if (isOnboardingActive(resolveAgentDir, onboarding)) {
      blocks.push(
        buildOnboardingPrompt(
          String(onboarding.lastTrigger || "").startsWith("auto:")
            ? "auto"
            : "manual",
        ),
      );
    }
    if (!blocks.length) return;
    const current = String(event.systemPrompt || "").trimEnd();
    const memoryBlock = blocks.join("\n\n").trim();
    const projectContextMarker = "\n\n# Project Context\n\n";
    const idx = current.indexOf(projectContextMarker);
    if (idx >= 0) {
      return {
        systemPrompt:
          `${current.slice(0, idx).trimEnd()}\n\n${memoryBlock}${current.slice(idx)}`.trimEnd(),
      };
    }
    return {
      systemPrompt: `${current}\n\n${memoryBlock}`.trimEnd(),
    };
  });
}
