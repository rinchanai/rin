import {
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

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
  memoryToolParameters,
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

export default function memoryExtension(pi: ExtensionAPI) {
  const registerMemoryTool = (name: "memory" | "rin_memory", label: string) => {
    pi.registerTool({
      name,
      label,
      description:
        "Search and save the markdown-backed long-term memory library with resident, progressive, and recall layers.",
      promptSnippet:
        "Prefer using `memory.search` to recover missing context before answering.",
      promptGuidelines: [
        "Prefer using `memory.search` to recover context.",
        "Use a few distinctive keywords instead of full sentences.",
        "Start with exact names or unique terms, and broaden only if needed.",
        "Do not assume historical context is already in the current prompt.",
        "`memory.search` returns paths and metadata first; use `read` only when you need the full document.",
        "Use `memory.save` only for stable information worth keeping beyond the current turn, and search before saving to avoid duplicates.",
      ],
      parameters: memoryToolParameters,
      execute: async (_toolCallId, params) => {
        const action = String((params as any)?.action || "").trim();
        try {
          const response = await executeMemoryTool(params as any);
          const prepared = await prepareToolTextOutput({
            agentText: formatMemoryAgentResult(action, response),
            userText: formatMemoryResult(action, response),
            tempPrefix: "rin-memory-",
            filename: `memory-${action || "result"}.txt`,
          });
          return {
            content: [{ type: "text", text: prepared.agentText }],
            details: { ...response, ...prepared },
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
    return {
      systemPrompt:
        `${String(event.systemPrompt || "").trimEnd()}\n\n${blocks.join("\n\n")}`.trimEnd(),
    };
  });
}
