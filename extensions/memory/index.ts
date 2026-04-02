import {
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

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
import { prepareToolTextOutput } from "../shared/tool-text.js";

let installerAutoInitConsumed = false;

function sessionMeta(ctx: any) {
  return {
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
    sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
  };
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
  opts: { sessionFile?: string; trigger: string },
) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  await maintainMemory(ctx as any, {
    messages,
    trigger: opts.trigger,
    mode: "session",
  });
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
    Type.Union(
      [
        Type.Literal("resident"),
        Type.Literal("progressive"),
        Type.Literal("recall"),
      ],
      {
        description:
          "Optional memory layer. Allowed values: `resident`, `progressive`, or `recall`.",
      },
    ),
  ),
  residentSlot: Type.Optional(
    Type.Union(
      [
        Type.Literal("agent_identity"),
        Type.Literal("owner_identity"),
        Type.Literal("core_voice_style"),
        Type.Literal("core_methodology"),
        Type.Literal("core_values"),
      ],
      {
        description:
          "Resident slot name. Use only with `exposure: resident`. Allowed values: `agent_identity`, `owner_identity`, `core_voice_style`, `core_methodology`, `core_values`.",
      },
    ),
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
        Type.Literal("identity"),
        Type.Literal("style"),
        Type.Literal("method"),
        Type.Literal("value"),
        Type.Literal("preference"),
        Type.Literal("rule"),
        Type.Literal("knowledge"),
        Type.Literal("history"),
      ],
      {
        description:
          "Optional memory kind. Allowed values: `identity`, `style`, `method`, `value`, `preference`, `rule`, `knowledge`, or `history`.",
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
      "Use `search_memory` to search memory files and read them.",
    ],
    parameters: searchMemoryParams,
    execute: async (_toolCallId, params) =>
      await executeNamedMemoryAction("search", params),
    renderResult: renderMemoryResult,
  });

  pi.registerTool({
    name: "save_memory",
    label: "Save Memory",
    description: "Save stable information to long-term memory.",
    promptSnippet: "Save long-term memory.",
    promptGuidelines: ["Use `save_memory` to persist specific information."],
    parameters: saveMemoryParams,
    execute: async (_toolCallId, params) =>
      await executeNamedMemoryAction("save", params),
    renderResult: renderMemoryResult,
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
