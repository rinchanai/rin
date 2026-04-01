import {
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { synthesizeEpisodeTurn } from "./episode-synth.js";
import { extractAndPersistTurnMemory } from "./extractor.js";
import {
  buildOnboardingPrompt,
  compilePromptMemory,
  executeMemoryTool,
  formatMemoryAgentResult,
  formatMemoryResult,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  memoryToolParameters,
  refreshOnboardingCompletion,
} from "./lib.js";

let installerAutoInitConsumed = false;

function stringifyMessageContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text")
      .map((part) => String(part?.text || ""))
      .join("\n");
  }
  return "";
}

function sessionMeta(ctx: any) {
  return {
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
    sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
    cwd: String(ctx?.cwd || "").trim(),
    chatKey: String(ctx?.sessionManager?.getSessionName?.() || "").trim(),
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
  opts: { sessionFile?: string; sessionId?: string; trigger: string },
) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const sessionFile = String(opts.sessionFile || "").trim();
  await extractAndPersistTurnMemory(ctx as any, messages, {
    sessionFile,
    trigger: opts.trigger,
  });
  await synthesizeEpisodeTurn(ctx as any, messages, {
    sessionFile,
    sessionId: String(opts.sessionId || "").trim(),
  });
  await executeMemoryTool({ action: "process", sessionFile });
}

export default function memoryExtension(pi: ExtensionAPI) {
  const registerMemoryTool = (name: "memory" | "rin_memory", label: string) => {
    pi.registerTool({
      name,
      label,
      description:
        "Manage the markdown-backed long-term memory library, event ledger, automatic consolidation, and context recall pipeline.",
      promptSnippet:
        "Manage the markdown-backed long-term memory system with resident memory, progressive memory, recall memory, and event ledger processing.",
      promptGuidelines: [
        "Use `memory` for long-term reusable memory, project recall, event history, and memory maintenance. Use it when you need to save, inspect, search, move, process, or review memory state.",
        "When handling memory state, first use `memory` to discover the target document or slot instead of acting from assumptions about internal file paths or storage layout.",
        "For correcting a mistaken save, reclassification, or relocation between resident/progressive/recall, prefer `memory` tool actions such as `search`, `get`, `move`, `save`, or `delete` rather than editing files based only on inferred implementation knowledge.",
        "Resident memory is for short global always-on baselines, including identity, voice/style, methodology, and values/worldview that should always guide behavior. Progressive memory is for longer global or directional guidance that should appear as an expandable entry. Recall memory is for everything that should only be remembered when needed.",
        "Prefer searching and then reading the relevant memory files instead of assuming recall/episode/history content has already been injected into the prompt. Resident and progressive index are the only prompt-resident layers.",
        "Before saving a new memory, search first and prefer updating, moving, or consolidating an existing memory instead of creating duplicates.",
      ],
      parameters: memoryToolParameters,
      execute: async (_toolCallId, params) => {
        const action = String((params as any)?.action || "").trim();
        try {
          const response = await executeMemoryTool(params as any);
          const agentText = formatMemoryAgentResult(action, response);
          const userText = formatMemoryResult(action, response);
          return {
            content: [{ type: "text", text: agentText }],
            details: { ...response, agentText, userText },
          };
        } catch (error: any) {
          const message = String(
            error?.message || error || "memory_action_failed",
          );
          return {
            content: [{ type: "text", text: message }],
            details: {
              ok: false,
              error: message,
              agentText: message,
              userText: `Memory 操作失败：${message}`,
            },
            isError: true,
          };
        }
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
  };

  registerMemoryTool("memory", "Memory");
  registerMemoryTool("rin_memory", "Memory (legacy alias)");

  pi.on("input", async (event, ctx) => {
    const text = String(event?.text || "").trim();
    if (!text) return;
    await executeMemoryTool({
      action: "log_event",
      kind: "user_input",
      text,
      summary: `user: ${text}`,
      source: `input:${String(event?.source || "interactive")}`,
      ...sessionMeta(ctx),
    });
    await executeMemoryTool({
      action: "process",
      sessionFile: sessionMeta(ctx).sessionFile,
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const text = stringifyMessageContent(event?.result?.content);
    await executeMemoryTool({
      action: "log_event",
      kind: "tool_result",
      text: text || JSON.stringify(event?.result?.details || {}, null, 2),
      summary: `${String(event?.toolName || "tool")}${event?.isError ? " (error)" : ""}: ${text || "completed"}`,
      toolName: String(event?.toolName || ""),
      isError: Boolean(event?.isError),
      source: `tool:${String(event?.toolName || "")}`,
      ...sessionMeta(ctx),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    if (event?.message?.role !== "assistant") return;
    const text = stringifyMessageContent(event.message.content);
    if (!text) return;
    await executeMemoryTool({
      action: "log_event",
      kind: "assistant_message",
      text,
      summary: `assistant: ${text}`,
      source: "assistant:message_end",
      ...sessionMeta(ctx),
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await processSessionMemory(
      ctx,
      branchToMessages(ctx?.sessionManager?.getBranch?.() || []),
      {
        sessionFile: sessionMeta(ctx).sessionFile,
        sessionId: sessionMeta(ctx).sessionId,
        trigger: "extension:session_shutdown_extractor",
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
        trigger: "extension:session_switch_new_extractor",
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

  pi.on("before_agent_start", async (event, ctx) => {
    await executeMemoryTool({
      action: "process",
      sessionFile: sessionMeta(ctx).sessionFile,
    });
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
    return {
      systemPrompt:
        `${String(event.systemPrompt || "").trimEnd()}\n\n${blocks.join("\n\n")}`.trimEnd(),
    };
  });
}
