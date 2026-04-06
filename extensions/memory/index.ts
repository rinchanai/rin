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
} from "./lib.js";
import { resolveMemoryDoc } from "./docs.js";
import {
  buildMemoryDraftDoc,
  refineResidentSlot,
  writeMemoryDocWithSkillCreator,
} from "./processing.js";
import { appendTranscriptArchiveEntry } from "./transcripts.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

let installerAutoInitConsumed = false;

function sessionMeta(ctx: any) {
  return {
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
    sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
  };
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
    Type.Union([Type.Literal("progressive"), Type.Literal("recall")], {
      description:
        "Optional memory layer. Allowed values: `progressive` or `recall`.",
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

const saveResidentMemoryParams = Type.Object({
  residentSlot: Type.Union(
    [
      Type.Literal("agent_identity"),
      Type.Literal("owner_identity"),
      Type.Literal("core_voice_style"),
      Type.Literal("core_methodology"),
      Type.Literal("core_values"),
    ],
    {
      description:
        "Resident slot name. Allowed values: `agent_identity`, `owner_identity`, `core_voice_style`, `core_methodology`, `core_values`.",
    },
  ),
  content: Type.String({ description: "New resident memory entry." }),
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
    const drafted = buildMemoryDraftDoc({
      rootDir: String(ctx?.agentDir || "").trim(),
      draft: {
        name: params.name,
        description: params.description,
        content: params.content,
        exposure: params.exposure,
        scope: params.scope,
        kind: params.kind,
        path: params.path,
      },
    });
    const saved = await writeMemoryDocWithSkillCreator({
      ctx,
      currentThinkingLevel,
      memoryRoot: drafted.root,
      draftDoc: drafted.draftDoc,
    });
    const savedPath = String(saved?.output || "").trim();
    if (!savedPath) throw new Error("memory_save_missing_path");
    const doc = await resolveMemoryDoc(drafted.root, savedPath);
    const response = {
      status: "ok",
      action: "save",
      doc: {
        id: doc?.id || "",
        name: doc?.name || drafted.name,
        path: doc?.path || savedPath,
      },
    };
    const prepared = await prepareToolTextOutput({
      agentText: formatMemoryAgentResult("save", response),
      userText: formatMemoryResult("save", response),
      tempPrefix: "rin-memory-",
      filename: "memory-save.txt",
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: { ...response, ...prepared, drafted },
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

async function executeSaveResidentMemoryAction(
  params: any,
  ctx: any,
  currentThinkingLevel: any,
) {
  try {
    const refined = await refineResidentSlot({
      ctx,
      currentThinkingLevel,
      residentSlot: params.residentSlot,
      incomingContent: params.content,
      rootDir: String(ctx?.agentDir || "").trim(),
    });
    const response = await executeMemoryTool({
      action: "save_resident",
      residentSlot: params.residentSlot,
      name: refined.name,
      content: refined.content,
      source: params.source,
    });
    const prepared = await prepareToolTextOutput({
      agentText: `memory save_resident\npath=${String(response?.doc?.path || refined.path || "")}`,
      userText: `Saved resident memory: ${String(response?.doc?.name || refined.name || params.residentSlot)}\n${String(response?.doc?.path || refined.path || "")}`,
      tempPrefix: "rin-memory-",
      filename: "memory-save-resident.txt",
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: { ...response, ...prepared, refined },
    };
  } catch (error: any) {
    const message = String(
      error?.message || error || "resident_memory_action_failed",
    );
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        agentText: message,
        userText: `Resident memory 操作失败：${message}`,
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
      "Use search_memory to search memory files and read them.",
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
      "Use save_memory for long-term information intended as standalone documents rather than resident system-prompt memories.",
    ],
    parameters: saveMemoryParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeSaveMemoryAction(params, ctx, pi.getThinkingLevel()),
    renderResult: renderMemoryResult,
  });

  pi.registerTool({
    name: "save_resident_memory",
    label: "Save Resident Memory",
    description: "Persist memories into system prompt.",
    promptSnippet: "Persist memories into system prompt.",
    promptGuidelines: [
      "Use save_resident_memory for agent identity, owner identity, core voice style, core methodology, or core values when the information should be known or followed in most situations and can be expressed in a single sentence.",
    ],
    parameters: saveResidentMemoryParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeSaveResidentMemoryAction(params, ctx, pi.getThinkingLevel()),
    renderResult: renderMemoryResult,
  });

  pi.on("message_end", async (event, ctx) => {
    await archiveMessageTranscript(event?.message, ctx);
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
    await processSessionMemory(ctx, messages, {
      sessionFile: sessionMeta(ctx).sessionFile,
      trigger: "extension:session_compaction_maintainer",
      snapshotKey: [
        "compaction",
        String(preparation?.firstKeptEntryId || "").trim(),
        String(preparation?.tokensBefore || "").trim(),
      ]
        .filter(Boolean)
        .join(":"),
    });
  });

  pi.on("session_compact", async (_event, ctx) => {
    await ctx.reload();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await processSessionMemory(
      ctx,
      branchToMessages(ctx?.sessionManager?.getBranch?.() || []),
      {
        sessionFile: sessionMeta(ctx).sessionFile,
        trigger: "extension:session_shutdown_maintainer",
      },
    );
  });

  pi.on("session_switch", async (event, ctx) => {
    if (event?.reason !== "new") return;
    const previousSessionFile = String(event?.previousSessionFile || "").trim();
    if (!previousSessionFile) return;
    await processSessionMemory(
      ctx,
      loadMessagesFromSessionFile(previousSessionFile),
      {
        sessionFile: previousSessionFile,
        trigger: "extension:session_switch_new_maintainer",
      },
    );
  });

  pi.registerCommand("init", {
    description: "Start or restart memory onboarding conversation.",
    handler: async (_args, ctx) => {
      await markOnboardingPrompted("manual:/init");
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
      await markOnboardingPrompted("auto:installer");
      installerAutoInitConsumed = true;
      process.env.RIN_INSTALL_AUTO_INIT = "";
    }
    await refreshOnboardingCompletion();
    const { systemPrompt } = await compilePromptMemory(
      String(event?.prompt || ""),
    );
    const blocks: string[] = [];
    if (
      systemPrompt &&
      !String(event.systemPrompt || "").includes(systemPrompt)
    )
      blocks.push(systemPrompt);
    const onboarding = getOnboardingState();
    if (isOnboardingActive(onboarding)) {
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
