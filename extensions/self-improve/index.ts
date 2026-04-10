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
  compileSelfImprovePrompt,
  executeSelfImproveTool,
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
  resolveAgentDir,
  loadSelfImproveStore,
} from "./lib.js";
import {
  describeSelfImprovePromptSlot,
  refineSelfImprovePromptSlot,
} from "./processing.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

let installerAutoInitConsumed = false;

const SELF_IMPROVE_REVIEW_INTERVAL = 8;
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

function triggerInitConversation(
  pi: ExtensionAPI,
  mode: "auto" | "manual",
  busy: boolean,
) {
  pi.sendMessage(
    {
      customType: "self-improve-init-trigger",
      content:
        mode === "auto"
          ? "Begin self-improve onboarding."
          : "Begin requested self-improve onboarding.",
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

async function processSelfImproveReview(
  ctx: any,
  messages: any[],
  opts: { sessionFile?: string; trigger: string; snapshotKey?: string },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !sessionFile ||
    !agentDir
  ) {
    return;
  }
  await enqueueMemoryMaintenanceJob({
    agentDir,
    sessionFile,
    trigger: opts.trigger,
    snapshotKey: opts.snapshotKey,
    messages,
  });
  spawnQueuedMemoryWorker(agentDir);
}

const saveSelfImprovePromptParams = Type.Object({
  slot: Type.Union(
    [
      Type.Literal("agent_profile"),
      Type.Literal("user_profile"),
      Type.Literal("core_doctrine"),
      Type.Literal("core_facts"),
    ],
    {
      description:
        "Which always-on prompt slot to inspect or update: `agent_profile`, `user_profile`, `core_doctrine`, or `core_facts`.",
    },
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Full revised canonical content for the slot. Omit this on the first call to read the current slot state.",
    }),
  ),
  baseContent: Type.Optional(
    Type.String({
      description:
        "Current canonical content returned by the read step. Required to update a populated slot safely.",
    }),
  ),
});

async function executeSaveSelfImprovePromptAction(params: any) {
  try {
    const slot = String(params?.slot || "").trim();
    const existing = await executeSelfImproveTool({ action: "compile" });
    const currentDoc = Array.isArray(existing?.self_improve_prompt_prompt_docs)
      ? existing.self_improve_prompt_prompt_docs.find(
          (doc: any) =>
            String(doc?.self_improve_prompt_slot || "").trim() === slot,
        )
      : null;
    const currentState = describeSelfImprovePromptSlot({
      slot,
      existingContent: String(currentDoc?.content || ""),
    });

    const usageLine = `usage=${currentState.currentChars}/${currentState.maxChars}`;
    const baseContent = String(params?.baseContent || "").trim();
    const incomingContent = String(params?.content || "").trim();

    if (!incomingContent) {
      const prepared = await prepareToolTextOutput({
        agentText: [
          "self_improve save_prompts",
          "status=review_required",
          `slot=${currentState.slot}`,
          usageLine,
          `path=${String(currentDoc?.path || "")}`,
          "current_content:",
          currentState.content || "(empty)",
        ].join("\n"),
        userText: [
          `Loaded self-improve prompt: ${currentState.name}`,
          usageLine,
          String(currentDoc?.path || ""),
          currentState.content || "(empty)",
        ]
          .filter(Boolean)
          .join("\n"),
        tempPrefix: "rin-self-improve-",
        filename: "self-improve-save-prompt.txt",
      });
      return {
        content: [{ type: "text" as const, text: prepared.agentText }],
        details: {
          ok: true,
          status: "review_required",
          slot: currentState.slot,
          usage: `${currentState.currentChars}/${currentState.maxChars}`,
          currentContent: currentState.content,
          path: String(currentDoc?.path || ""),
          ...prepared,
        },
      };
    }

    if (currentState.content && !baseContent) {
      throw new Error("self_improve_base_content_required");
    }

    if (baseContent !== currentState.content) {
      const prepared = await prepareToolTextOutput({
        agentText: [
          "self_improve save_prompts",
          "status=stale_base_content",
          `slot=${currentState.slot}`,
          usageLine,
          `path=${String(currentDoc?.path || "")}`,
          "current_content:",
          currentState.content || "(empty)",
        ].join("\n"),
        userText: [
          `Stale self-improve prompt base content: ${currentState.name}`,
          usageLine,
          String(currentDoc?.path || ""),
          currentState.content || "(empty)",
        ]
          .filter(Boolean)
          .join("\n"),
        tempPrefix: "rin-self-improve-",
        filename: "self-improve-save-prompt.txt",
      });
      return {
        content: [{ type: "text" as const, text: prepared.agentText }],
        details: {
          ok: false,
          status: "stale_base_content",
          slot: currentState.slot,
          usage: `${currentState.currentChars}/${currentState.maxChars}`,
          currentContent: currentState.content,
          path: String(currentDoc?.path || ""),
          ...prepared,
        },
        isError: true,
      };
    }

    const refined = refineSelfImprovePromptSlot({
      slot: currentState.slot,
      incomingContent,
    });
    const response = await executeSelfImproveTool({
      action: "save_self_improve_prompt",
      selfImprovePromptSlot: currentState.slot,
      name: refined.name,
      content: refined.content,
    });
    const prepared = await prepareToolTextOutput({
      agentText: [
        "self_improve save_prompts",
        "status=updated",
        `slot=${currentState.slot}`,
        `usage=${refined.nextChars}/${refined.maxChars}`,
        `path=${String(response?.doc?.path || "")}`,
      ].join("\n"),
      userText: [
        `Updated self-improve prompt: ${refined.name}`,
        `usage=${refined.nextChars}/${refined.maxChars}`,
        String(response?.doc?.path || ""),
      ]
        .filter(Boolean)
        .join("\n"),
      tempPrefix: "rin-self-improve-",
      filename: "self-improve-save-prompt.txt",
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: {
        ...response,
        ...prepared,
        ok: true,
        status: "updated",
        slot: currentState.slot,
        usage: `${refined.nextChars}/${refined.maxChars}`,
        path: String(response?.doc?.path || ""),
      },
    };
  } catch (error: any) {
    const message = String(
      error?.message || error || "self_improve_prompt_action_failed",
    );
    const slot = String(params?.slot || "").trim();
    let usage = "0/0";
    try {
      if (slot) {
        const existing = await executeSelfImproveTool({ action: "compile" });
        const currentDoc = Array.isArray(existing?.self_improve_prompt_prompt_docs)
          ? existing.self_improve_prompt_prompt_docs.find(
              (doc: any) =>
                String(doc?.self_improve_prompt_slot || "").trim() === slot,
            )
          : null;
        const currentState = describeSelfImprovePromptSlot({
          slot,
          existingContent: String(currentDoc?.content || ""),
        });
        usage = `${currentState.currentChars}/${currentState.maxChars}`;
      }
    } catch {}
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        usage,
        agentText: slot ? `${message}\nslot=${slot}\nusage=${usage}` : message,
        userText: slot
          ? `Self-improve prompt operation failed: ${message}\nusage=${usage}`
          : `Self-improve prompt operation failed: ${message}`,
      },
      isError: true,
    };
  }
}

function renderSelfImproveResult(result: any) {
  const details = result.details as any;
  const fallback =
    result.content?.[0]?.type === "text"
      ? result.content[0].text
      : "(no output)";
  return new Text(String(details?.userText || fallback), 0, 0);
}

export default function selfImproveExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "save_prompts",
    label: "Save Prompts",
    description:
      "Save durable prompt baselines that persist across sessions and stay available every turn. Keep them compact and focused on what will still matter later.",
    promptSnippet: "Save durable prompt baselines.",
    promptGuidelines: [
      "Use save_prompts proactively for durable baselines such as preferences, recurring corrections, environment conventions, stable facts, and other long-lived guidance that should remain active every turn.",
      "Use save_prompts only for compact long-lived prompt content; do not store task progress, session outcomes, or temporary state with save_prompts.",
      "Before updating a slot, first call save_prompts with only `slot` to read the current canonical content, then submit the full revised content with `baseContent` from that read.",
      "Treat the content returned by the read step as canonical. When updating, pass `baseContent` exactly as read, and provide `content` in the same normalized shape unless you intentionally want the tool to re-normalize it.",
      "Save reusable procedures, workflows, checklists, and playbooks as skills under /home/rin/.rin/self_improve/skills instead of save_prompts content; use skill-creator for major creation or revision when available, and update outdated or incomplete skills promptly.",
      "If a slot accumulates extensive details on a single topic, extract them into a builtin skill and leave only a compact reference in `save_prompts`.",
    ],
    parameters: saveSelfImprovePromptParams,
    execute: async (_toolCallId, params) =>
      await executeSaveSelfImprovePromptAction(params),
    renderResult: renderSelfImproveResult,
  });

  pi.on("message_end", async (event, ctx) => {
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
      state.userTurns - state.lastQueuedTurn >= SELF_IMPROVE_REVIEW_INTERVAL
    ) {
      await processSelfImproveReview(ctx, [], {
        sessionFile: meta.sessionFile,
        trigger: "extension:periodic_self_improve_review",
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
      trigger: "extension:session_compaction_self_improve_review",
      messages,
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const meta = sessionMeta(ctx);
    await processSelfImproveReview(
      ctx,
      branchToMessages(ctx?.sessionManager?.getBranch?.() || []),
      {
        sessionFile: meta.sessionFile,
        trigger: "extension:session_shutdown_self_improve_review",
      },
    );
    if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
  });

  pi.on("session_start", async (event, ctx) => {
    if (event?.reason !== "new") return;
    const previousSessionFile = String(event?.previousSessionFile || "").trim();
    if (!previousSessionFile) return;
    await processSelfImproveReview(
      ctx,
      loadMessagesFromSessionFile(previousSessionFile),
      {
        sessionFile: previousSessionFile,
        trigger: "extension:session_start_new_self_improve_review",
      },
    );
  });

  pi.registerCommand("init", {
    description: "Start or restart self-improve onboarding conversation.",
    handler: async (_args, ctx) => {
      await markOnboardingPrompted(resolveAgentDir, "manual:/init");
      ctx.ui.notify(
        ctx.isIdle()
          ? "Self-improve onboarding started."
          : "Self-improve onboarding queued.",
        "info",
      );
      triggerInitConversation(pi, "manual", !ctx.isIdle());
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (
      !installerAutoInitConsumed &&
      String(process.env.RIN_INSTALL_AUTO_INIT || "").trim() === "1"
    ) {
      await markOnboardingPrompted(resolveAgentDir, "auto:installer");
      installerAutoInitConsumed = true;
      process.env.RIN_INSTALL_AUTO_INIT = "";
    }
    await refreshOnboardingCompletion(resolveAgentDir, loadSelfImproveStore);
    const { systemPrompt } = await compileSelfImprovePrompt();
    const blocks: string[] = [];
    if (
      systemPrompt &&
      !String(event.systemPrompt || "").includes(systemPrompt)
    ) {
      blocks.push(systemPrompt);
    }
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
    const promptsBlock = blocks[0] || "";

    const insertBeforeMarker = (
      source: string,
      marker: string,
      blockText: string,
    ) => {
      const text = String(blockText || "").trim();
      if (!text) return source;
      const idx = source.indexOf(marker);
      if (idx < 0) return source;
      return `${source.slice(0, idx).trimEnd()}\n\n${text}\n\n${source.slice(idx)}`.trimEnd();
    };

    const skillsMarker =
      "\n\nAvailable skills provide specialized instructions for specific tasks.\n\n";

    let next = current;
    if (promptsBlock) {
      if (next.includes(skillsMarker)) {
        next = insertBeforeMarker(next, skillsMarker, promptsBlock);
      } else {
        next = `${next}\n\n${promptsBlock}`.trimEnd();
      }
    }
    return {
      systemPrompt: next.trimEnd(),
    };
  });
}
